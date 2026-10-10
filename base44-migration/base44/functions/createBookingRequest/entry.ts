import { createClientFromRequest } from "npm:@base44/sdk";

const barberNames = new Set(["Artur", "Fabio", "Ricardo"]);
const defaultServiceNames = new Set([
  "Corte", "Bigode", "Cavanhaque", "Corte infantil", "Corte + Barba", "Corte + Pigmentação",
  "Hidratação", "Limpeza de Pele", "Sobrancelha", "Pezinho", "Nevou", "Reflexo",
]);

export default async function (request: Request): Promise<Response> {
  const base44 = createClientFromRequest(request);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Entre na sua conta para solicitar um horário." }, { status: 401 });

  let body: { service_id?: string; barber_name?: string; date?: string; hour?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados do horário inválidos." }, { status: 400 });
  }
  const serviceId = String(body.service_id || "");
  const serviceName = String(body.service_name || "");
  const barberName = String(body.barber_name || "");
  const date = String(body.date || "");
  const hour = Number(body.hour);
  if ((!serviceId && !defaultServiceNames.has(serviceName)) || !barberNames.has(barberName) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || hour < 8 || hour > 21) {
    return Response.json({ error: "Selecione serviço, barbeiro, data e horário válidos." }, { status: 400 });
  }
  const parsedDate = new Date(`${date}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || date < today) {
    return Response.json({ error: "Escolha uma data válida, a partir de hoje." }, { status: 400 });
  }

  try {
    const admin = base44.asServiceRole;
    const [serviceById, matchingSlots, requests] = await Promise.all([
      serviceId ? admin.entities.Service.get(serviceId).catch(() => null) : Promise.resolve(null),
      admin.entities.BarberAvailability.filter({ barber_name: barberName, date, hour }, "-created_date", 2, 0),
      admin.entities.BookingRequest.filter({ barber_name: barberName, date, hour }, "-created_date", 100, 0),
    ]);
    const service = serviceById || { name: serviceName, active: defaultServiceNames.has(serviceName) };
    if (!service || !service.active) return Response.json({ error: "Este serviço não está disponível." }, { status: 404 });
    if (matchingSlots[0] && !matchingSlots[0].is_available) {
      return Response.json({ error: "Esse horário não está disponível. Escolha outro." }, { status: 409 });
    }
    if (requests.some(item => ["pending", "confirmed"].includes(item.status))) {
      return Response.json({ error: "Esse horário já tem uma solicitação. Escolha outro." }, { status: 409 });
    }

    const created = await base44.entities.BookingRequest.create({
      user_id: user.id,
      user_name: user.display_name || user.full_name || user.email,
      user_email: user.email,
      user_phone: user.phone || "",
      service_name: service.name,
      barber_name: barberName,
      date,
      hour,
      status: "pending",
    });
    return Response.json({
      request_id: created.id,
      status: "pending",
      barber_name: barberName,
      service_name: service.name,
      date,
      hour,
    }, { status: 201 });
  } catch (error) {
    console.error("Booking request failed", error);
    return Response.json({ error: "Não foi possível solicitar esse horário." }, { status: 500 });
  }
}