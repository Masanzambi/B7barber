import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

export default async function (request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Método não permitido." }, { status: 405 });
  const setupSecret = secrets.get("B7_ADMIN_SETUP_SECRET");
  if (!setupSecret) return Response.json({ error: "Inicialização administrativa desativada." }, { status: 404 });
  const providedSecret = request.headers.get("x-b7-setup-secret") || "";
  const encoder = new TextEncoder();
  const message = encoder.encode("b7-admin-bootstrap");
  const [expectedKey, providedKey] = await Promise.all([
    crypto.subtle.importKey("raw", encoder.encode(setupSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    crypto.subtle.importKey("raw", encoder.encode(providedSecret || "invalid"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  const [expected, received] = await Promise.all([
    crypto.subtle.sign("HMAC", expectedKey, message),
    crypto.subtle.sign("HMAC", providedKey, message),
  ]);
  const expectedBytes = new Uint8Array(expected);
  const receivedBytes = new Uint8Array(received);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) difference |= expectedBytes[index] ^ receivedBytes[index];
  if (difference !== 0) return Response.json({ error: "Credencial de inicialização inválida." }, { status: 403 });

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "E-mail inválido." }, { status: 400 });
  }
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Informe o e-mail da conta Base44 que será administradora." }, { status: 400 });
  }

  try {
    const base44 = createClientFromRequest(request);
    const existingAdmins = await base44.asServiceRole.entities.User.filter({ role: "admin" }, "created_date", 2, 0);
    if (existingAdmins.length) {
      return Response.json({ error: "Já existe uma conta administradora. Remova B7_ADMIN_SETUP_SECRET após a configuração." }, { status: 409 });
    }
    const matches = await base44.asServiceRole.entities.User.filter({ email }, "created_date", 2, 0);
    if (!matches[0]) return Response.json({ error: "Cadastre esta conta no app Base44 antes de promovê-la." }, { status: 404 });
    const updated = await base44.asServiceRole.entities.User.update(matches[0].id, { role: "admin" });
    return Response.json({ success: true, email: updated.email });
  } catch (error) {
    console.error("Admin bootstrap failed", error);
    return Response.json({ error: "Não foi possível inicializar a conta administradora." }, { status: 500 });
  }
}