import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

const encoder = new TextEncoder();
const supportedPaymentStatuses = new Set([
  "processed",
  "recycling",
  "waiting for gateway",
  "cancelled",
]);
const supportedSubscriptionStatuses = new Set([
  "pending",
  "authorized",
  "paused",
  "cancelled",
  "rejected",
]);

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function secureCompare(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifySignature(
  signatureHeader: string,
  requestId: string,
  dataId: string,
  secret: string,
): Promise<boolean> {
  const values = Object.fromEntries(
    signatureHeader.split(",").map(part => {
      const separator = part.indexOf("=");
      return separator < 0
        ? ["", ""]
        : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }).filter(([key]) => key),
  );
  const timestamp = values.ts;
  const suppliedHash = values.v1?.toLowerCase();
  if (!timestamp || !/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(suppliedHash || "")) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(manifest));
  const expectedHash = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  return secureCompare(expectedHash, suppliedHash);
}

async function getProviderResource(path: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Mercado Pago respondeu ${response.status}.`);
  return await response.json();
}

export default async function (request: Request): Promise<Response> {
  const webhookSecret = secrets.get("MERCADOPAGO_WEBHOOK_SECRET");
  const accessToken = secrets.get("MERCADOPAGO_ACCESS_TOKEN");
  if (!webhookSecret || !accessToken) {
    return jsonResponse({ error: "Webhook Mercado Pago não configurado." }, 503);
  }

  let notification: Record<string, unknown>;
  try {
    notification = await request.json();
  } catch {
    return jsonResponse({ error: "Notificação inválida." }, 400);
  }

  const url = new URL(request.url);
  const data = notification.data && typeof notification.data === "object"
    ? notification.data as Record<string, unknown>
    : {};
  const dataId = url.searchParams.get("data.id") || String(data.id || "");
  const requestId = request.headers.get("x-request-id") || "";
  const signatureIsValid = await verifySignature(
    request.headers.get("x-signature") || "",
    requestId,
    dataId,
    webhookSecret,
  );
  if (!signatureIsValid) return jsonResponse({ error: "Assinatura do webhook inválida." }, 401);

  const eventType = String(notification.type || url.searchParams.get("type") || "");
  if (!new Set(["subscription_preapproval", "subscription_authorized_payment"]).has(eventType)) {
    return jsonResponse({ received: true, ignored: true });
  }
  if (!dataId) return jsonResponse({ error: "A notificação não contém ID do recurso." }, 400);

  try {
    const base44 = createClientFromRequest(request);
    const store = base44.asServiceRole.entities.ClubSubscription;
    let providerPayment: Record<string, unknown> | null = null;
    let providerSubscriptionId = dataId;

    if (eventType === "subscription_authorized_payment") {
      providerPayment = await getProviderResource(
        `/authorized_payments/${encodeURIComponent(dataId)}`,
        accessToken,
      );
      providerSubscriptionId = String(providerPayment.preapproval_id || "");
      if (!providerSubscriptionId) return jsonResponse({ received: true, ignored: true });
    }

    const providerSubscription = await getProviderResource(
      `/preapproval/${encodeURIComponent(providerSubscriptionId)}`,
      accessToken,
    );
    const externalReference = String(providerSubscription.external_reference || "");
    const matchingRecords = await store.filter({ external_reference: externalReference }, "-created_date", 2, 0);
    const localSubscription = matchingRecords[0];
    const providerSubscriptionId = String(providerSubscription.id || "");
    if (
      !localSubscription
      || !providerSubscriptionId
      || (localSubscription.mp_subscription_id && providerSubscriptionId !== String(localSubscription.mp_subscription_id))
    ) {
      return jsonResponse({ received: true, updated: false });
    }

    const providerStatus = String(providerSubscription.status || "").toLowerCase();
    const updates: Record<string, string | null> = { mp_subscription_id: providerSubscriptionId };
    if (supportedSubscriptionStatuses.has(providerStatus)) updates.status = providerStatus;
    if (typeof providerSubscription.next_payment_date === "string") {
      updates.next_payment_date = providerSubscription.next_payment_date;
    }

    if (providerPayment) {
      const paymentId = String(providerPayment.id || "");
      const paymentStatus = String(providerPayment.status || "").toLowerCase();
      if (paymentId && supportedPaymentStatuses.has(paymentStatus)) {
        updates.latest_payment_id = paymentId;
        updates.latest_payment_status = paymentStatus;
        const paymentDate = providerPayment.date_approved || providerPayment.last_modified || providerPayment.date_created;
        if (typeof paymentDate === "string") updates.latest_payment_at = paymentDate;
      }
    }

    if (Object.keys(updates).length > 0) {
      await store.update(localSubscription.id, updates);
    }
    return jsonResponse({ received: true, updated: Object.keys(updates).length > 0 });
  } catch (error) {
    console.error("Mercado Pago webhook processing failed", error);
    return jsonResponse({ error: "Não foi possível confirmar a notificação com o Mercado Pago." }, 502);
  }
}