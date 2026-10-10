import { createClientFromRequest } from "npm:@base44/sdk";

const planNames: Record<string, string> = {
  corte: "Corte",
  barba: "Barba",
  "corte-barba": "Corte + barba",
};

export default async function (request: Request): Promise<Response> {
  const base44 = createClientFromRequest(request);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Entre na sua conta." }, { status: 401 });

  const records = await base44.asServiceRole.entities.ClubSubscription.filter(
    { user_id: user.id },
    "-created_date",
    50,
    0,
  );
  const subscription = records[0];
  if (!subscription) return Response.json({ subscription: null, active: false });

  const paymentDate = subscription.latest_payment_at ? Date.parse(subscription.latest_payment_at) : 0;
  const paymentIsCurrent = paymentDate > 0 && Date.now() - paymentDate <= 35 * 24 * 60 * 60 * 1000;
  const active = subscription.status === "authorized"
    && subscription.latest_payment_status === "processed"
    && paymentIsCurrent;

  return Response.json({
    subscription: {
      plan_code: subscription.plan_code,
      plan_name: planNames[subscription.plan_code] || "B7 Barber Club",
      status: subscription.status,
      latest_payment_status: subscription.latest_payment_status || null,
      latest_payment_at: subscription.latest_payment_at || null,
      next_payment_date: subscription.next_payment_date || null,
      active,
    },
    active,
  });
}