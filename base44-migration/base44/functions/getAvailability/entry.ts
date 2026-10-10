import { createClientFromRequest } from "npm:@base44/sdk";

export default async function (request: Request): Promise<Response> {
  let body: { date?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Informe uma data para consultar." }, { status: 400 });
  }
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return Response.json({ error: "Informe uma data válida." }, { status: 400 });
  }

  try {
    const base44 = createClientFromRequest(request);
    const [slots, bookingRequests] = await Promise.all([
      base44.asServiceRole.entities.BarberAvailability.filter(
        { date: body.date },
        "hour",
        500,
        0,
      ),
      base44.asServiceRole.entities.BookingRequest.filter({ date: body.date }, "hour", 500, 0),
    ]);
    const availability: Record<string, Record<string, boolean>> = {};
    for (const slot of slots) {
      availability[slot.barber_name] ||= {};
      availability[slot.barber_name][String(slot.hour)] = Boolean(slot.is_available);
    }
    for (const booking of bookingRequests) {
      if (["pending", "confirmed"].includes(booking.status)) {
        availability[booking.barber_name] ||= {};
        availability[booking.barber_name][String(booking.hour)] = false;
      }
    }
    return Response.json({ date: body.date, availability, confirmed_booking: false });
  } catch (error) {
    console.error("Availability lookup failed", error);
    return Response.json({ error: "Não foi possível consultar os horários." }, { status: 500 });
  }
}