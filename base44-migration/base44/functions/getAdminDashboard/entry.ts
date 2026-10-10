import { createClientFromRequest } from "npm:@base44/sdk";

const barberNames = ["Artur", "Fabio", "Ricardo"];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function periodStart(date: Date, period: "week" | "month" | "year"): string {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (period === "week") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  else if (period === "month") start.setUTCDate(1);
  else start.setUTCMonth(0, 1);
  return isoDate(start);
}

function buildCashSummary(rows: Record<string, unknown>[], period: "week" | "month" | "year", startDate: string, endDate: string) {
  const totals = Object.fromEntries(barberNames.map(name => [name, { income_cents: 0, expense_cents: 0, profit_cents: 0 }])) as Record<string, { income_cents: number; expense_cents: number; profit_cents: number }>;
  for (const row of rows) {
    const barber = String(row.barber_name || "");
    if (!totals[barber]) continue;
    const amount = Number(row.sum_amount_cents) || 0;
    if (row.entry_type === "income") totals[barber].income_cents = amount;
    if (row.entry_type === "expense") totals[barber].expense_cents = amount;
  }
  const barbers = barberNames.map(name => ({
    name,
    ...totals[name],
    profit_cents: totals[name].income_cents - totals[name].expense_cents,
  }));
  return {
    start_date: startDate,
    end_date: endDate,
    barbers,
    total_income_cents: barbers.reduce((total, barber) => total + barber.income_cents, 0),
    total_expense_cents: barbers.reduce((total, barber) => total + barber.expense_cents, 0),
    total_profit_cents: barbers.reduce((total, barber) => total + barber.profit_cents, 0),
    period,
  };
}

export default async function (request: Request): Promise<Response> {
  const base44 = createClientFromRequest(request);
  const user = await base44.auth.me().catch(() => null);
  if (!user || user.role !== "admin") {
    return Response.json({ error: "Acesso restrito à administração." }, { status: 403 });
  }

  try {
    const admin = base44.asServiceRole;
    const today = new Date();
    const endDate = isoDate(today);
    const periods = ["week", "month", "year"] as const;
    const [users, services, barbers, subscriptions, cashEntries, bookingRequests, ...cashAggregates] = await Promise.all([
      admin.entities.User.list("-created_date", 500, 0, ["id", "email", "full_name", "role", "disabled", "created_date"]),
      admin.entities.Service.list("sort_order", 500, 0),
      admin.entities.Barber.list("sort_order", 100, 0),
      admin.entities.ClubSubscription.list("-created_date", 500, 0),
      admin.entities.CashEntry.list("-entry_date", 500, 0),
      admin.entities.BookingRequest.list("-created_date", 500, 0),
      ...periods.flatMap(period => {
        const startDate = periodStart(today, period);
        return ["income", "expense"].map(entryType => admin.entities.CashEntry.aggregate({
          query: { entry_type: entryType, entry_date: { $gte: startDate, $lte: endDate } },
          groupBy: "barber_name",
          sum: "amount_cents",
          count: false,
        }));
      }),
    ]);
    const cashflow = Object.fromEntries(periods.map((period, index) => {
      const startDate = periodStart(today, period);
      const rows = [
        ...cashAggregates[index * 2].rows.map(row => ({ ...row, entry_type: "income" })),
        ...cashAggregates[index * 2 + 1].rows.map(row => ({ ...row, entry_type: "expense" })),
      ];
      return [period, buildCashSummary(rows, period, startDate, endDate)];
    }));
    return Response.json({ users, services, barbers, subscriptions, cash_entries: cashEntries, cashflow, booking_requests: bookingRequests });
  } catch (error) {
    console.error("Admin dashboard load failed", error);
    return Response.json({ error: "Não foi possível carregar o painel." }, { status: 500 });
  }
}