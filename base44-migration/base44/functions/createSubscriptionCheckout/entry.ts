import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

const plans = {
  corte: { name: "Corte", amountCents: 8490 },
  barba: { name: "Barba", amountCents: 7990 },
  "corte-barba": { name: "Corte + barba", amountCents: 14950 },
} as const;

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default async function (request: Request): Promise<Response> {
  const base44 = createClientFromRequest(request);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return jsonResponse({ error: "Entre na sua conta antes de assinar." }, 401);

  const accessToken = secrets.get("MERCADOPAGO_ACCESS_TOKEN");
  const webhookSecret = secrets.get("MERCADOPAGO_WEBHOOK_SECRET");
  if (!accessToken || !webhookSecret) {
    return jsonResponse({ error: "A integração Mercado Pago ainda não está configurada." }, 503);
  }

  let body: { plan_code?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Dados de plano inválidos." }, 400);
  }
  const planCode = body.plan_code as keyof typeof plans;
  const plan = plans[planCode];
  if (!plan) return jsonResponse({ error: "Selecione um plano mensal válido." }, 400);

  const baseUrl = new URL(request.url).origin;
  const subscriptionStore = base44.asServiceRole.entities.ClubSubscription;
  const existingRecords = await subscriptionStore.filter({ user_id: user.id }, "-created_date", 50, 0);
  const now = Date.now();
  const currentMembership = existingRecords.find(record =>
    record.status === "authorized"
    && record.latest_payment_status === "processed"
    && record.latest_payment_at
    && now - Date.parse(record.latest_payment_at) <= 35 * 24 * 60 * 60 * 1000
  );
  if (currentMembership) {
    return jsonResponse({ error: "Você já tem uma assinatura ativa no B7 Barber Club." }, 409);
  }

  const pendingCheckout = existingRecords.find(record =>
    ["creating", "pending"].includes(record.status)
  );
  if (pendingCheckout) {
    if (pendingCheckout.plan_code === planCode && pendingCheckout.checkout_url) {
      return jsonResponse({ checkout_url: pendingCheckout.checkout_url });
    }
    return jsonResponse({ error: "Conclua ou cancele seu checkout pendente antes de trocar de plano." }, 409);
  }

  const externalReference = `b7-${crypto.randomUUID()}`;
  const localSubscription = await subscriptionStore.create({
    user_id: user.id,
    plan_code: planCode,
    amount_cents: plan.amountCents,
    external_reference: externalReference,
    status: "creating",
  });

  try {
    const providerResponse = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": externalReference,
      },
      body: JSON.stringify({
        reason: `B7 Barber Club - ${plan.name}`,
        external_reference: externalReference,
        payer_email: user.email,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: plan.amountCents / 100,
          currency_id: "BRL",
        },
        back_url: `${baseUrl}/?payment=returned`,
        notification_url: `${baseUrl}/functions/mercadopagoWebhook`,
        status: "pending",
      }),
    });

    if (!providerResponse.ok) {
      await subscriptionStore.update(localSubscription.id, { status: "checkout_failed" });
      console.error("Mercado Pago preapproval failed", providerResponse.status);
      return jsonResponse({ error: "Não foi possível criar o checkout no Mercado Pago." }, 502);
    }

    const providerSubscription = await providerResponse.json();
    const checkoutUrl = providerSubscription.init_point;
    if (
      typeof checkoutUrl !== "string"
      || !checkoutUrl.startsWith("https://")
      || !/(^|\.)mercadopago\.com(\.br)?(?=\/|$)/i.test(new URL(checkoutUrl).hostname)
    ) {
      await subscriptionStore.update(localSubscription.id, { status: "checkout_failed" });
      return jsonResponse({ error: "O Mercado Pago retornou um link de checkout inválido." }, 502);
    }

    await subscriptionStore.update(localSubscription.id, {
      mp_subscription_id: String(providerSubscription.id),
      checkout_url: checkoutUrl,
      next_payment_date: providerSubscription.next_payment_date || null,
    });
    return jsonResponse({ checkout_url: checkoutUrl }, 201);
  } catch (error) {
    await subscriptionStore.update(localSubscription.id, { status: "checkout_failed" }).catch(() => {});
    console.error("Subscription checkout failed", error);
    return jsonResponse({ error: "Não foi possível iniciar a assinatura. Tente novamente." }, 502);
  }
}