import { createClientFromRequest } from "npm:@base44/sdk";

const barberNames = new Set(["Artur", "Fabio", "Ricardo"]);
const serviceCategories = new Set(["cabelo", "barba", "combos", "quimica"]);
const cashBarbers = ["Artur", "Fabio", "Ricardo"] as const;
const defaultServices = [
  { name: "Corte", description: "Corte tradicional, degradê ou social", price_brl: 35, category: "cabelo", active: true, sort_order: 1 },
  { name: "Bigode", description: "Aparação e acabamento", price_brl: 5, category: "barba", active: true, sort_order: 2 },
  { name: "Cavanhaque", description: "Desenho e alinhamento", price_brl: 15, category: "barba", active: true, sort_order: 3 },
  { name: "Corte infantil", description: "Corte para os pequenos", price_brl: 40, category: "cabelo", active: true, sort_order: 4 },
  { name: "Corte + Barba", description: "Corte completo com alinhamento e finalização de barba", price_brl: 60, category: "combos", active: true, sort_order: 5 },
  { name: "Corte + Pigmentação", description: "Corte com acabamento e pigmentação", price_brl: 60, category: "combos", active: true, sort_order: 6 },
  { name: "Hidratação", description: "Tratamento capilar", price_brl: 15, category: "quimica", active: true, sort_order: 7 },
  { name: "Limpeza de Pele", description: "Cuidado facial", price_brl: 15, category: "quimica", active: true, sort_order: 8 },
  { name: "Sobrancelha", description: "Design e limpeza", price_brl: 5, category: "barba", active: true, sort_order: 9 },
  { name: "Pezinho", description: "Acabamento de contorno", price_brl: 10, category: "cabelo", active: true, sort_order: 10 },
  { name: "Nevou", description: "Platinado completo profissional", price_brl: 100, category: "quimica", active: true, sort_order: 11 },
  { name: "Reflexo", description: "Luzes e mechas masculinas alinhadas", price_brl: 100, category: "quimica", active: true, sort_order: 12 },
];
const defaultBarbers = [
  { name: "Artur", specialty: "Master Barber", image_url: "/imagens/arthur-.png", rating: 5, review_count: 189, active: true, sort_order: 1 },
  { name: "Fabio", specialty: "Visagista", image_url: "/imagens/Fabio.png", rating: 4.9, review_count: 142, active: true, sort_order: 2 },
  { name: "Ricardo", specialty: "Barboterapia", image_url: "/imagens/ricardo-.png", rating: 4.9, review_count: 97, active: true, sort_order: 3 },
];

function responseError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export default async function (request: Request): Promise<Response> {
  const base44 = createClientFromRequest(request);
  const user = await base44.auth.me().catch(() => null);
  if (!user || user.role !== "admin") return responseError("Acesso restrito à administração.", 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return responseError("Dados inválidos.");
  }
  const admin = base44.asServiceRole;

  try {
    switch (body.action) {
      case "seedCatalog": {
        let servicesCreated = 0;
        let barbersCreated = 0;
        for (const service of defaultServices) {
          const matches = await admin.entities.Service.filter({ name: service.name }, "created_date", 2, 0);
          if (!matches.length) {
            await admin.entities.Service.create(service);
            servicesCreated += 1;
          }
        }
        for (const barber of defaultBarbers) {
          const matches = await admin.entities.Barber.filter({ name: barber.name }, "created_date", 2, 0);
          if (!matches.length) {
            await admin.entities.Barber.create(barber);
            barbersCreated += 1;
          }
        }
        return Response.json({ services_created: servicesCreated, barbers_created: barbersCreated });
      }
      case "saveService": {
        const name = String(body.name || "").trim();
        const category = String(body.category || "");
        const price = Number(body.price_brl);
        if (!name || name.length > 80 || !serviceCategories.has(category) || !Number.isFinite(price) || price < 0 || price > 10000) {
          return responseError("Informe nome, categoria e preço válidos para o serviço.");
        }
        const serviceData = {
          name,
          description: String(body.description || "").trim().slice(0, 300),
          category,
          price_brl: Math.round(price * 100) / 100,
          active: body.active !== false,
          sort_order: Math.max(0, Math.floor(Number(body.sort_order) || 0)),
        };
        const id = String(body.id || "");
        const service = id
          ? await admin.entities.Service.update(id, serviceData)
          : await admin.entities.Service.create(serviceData);
        return Response.json({ service });
      }
      case "setServiceActive": {
        const id = String(body.id || "");
        if (!id || typeof body.active !== "boolean") return responseError("Serviço ou estado inválido.");
        const service = await admin.entities.Service.update(id, { active: body.active });
        return Response.json({ service });
      }
      case "saveBarber": {
        const name = String(body.name || "").trim();
        if (!name || name.length > 80) return responseError("Informe o nome do barbeiro.");
        const barberData = {
          name,
          specialty: String(body.specialty || "").trim().slice(0, 120),
          image_url: String(body.image_url || "").trim().slice(0, 500),
          rating: Math.max(0, Math.min(5, Number(body.rating) || 0)),
          review_count: Math.max(0, Math.floor(Number(body.review_count) || 0)),
          active: body.active !== false,
          sort_order: Math.max(0, Math.floor(Number(body.sort_order) || 0)),
        };
        const id = String(body.id || "");
        const barber = id
          ? await admin.entities.Barber.update(id, barberData)
          : await admin.entities.Barber.create(barberData);
        return Response.json({ barber });
      }
      case "setBarberActive": {
        const id = String(body.id || "");
        if (!id || typeof body.active !== "boolean") return responseError("Barbeiro ou estado inválido.");
        const barber = await admin.entities.Barber.update(id, { active: body.active });
        return Response.json({ barber });
      }
      case "setUserDisabled": {
        const id = String(body.id || "");
        if (!id || typeof body.disabled !== "boolean") return responseError("Conta ou estado inválido.");
        const target = await admin.entities.User.get(id).catch(() => null);
        if (!target) return responseError("Conta não encontrada.", 404);
        if (target.id === user.id && body.disabled) return responseError("Não é possível desativar sua própria conta.", 409);
        const updated = await admin.entities.User.update(id, { disabled: body.disabled });
        return Response.json({ user: { id: updated.id, email: updated.email, disabled: updated.disabled } });
      }
      case "setAvailability": {
        const barberName = String(body.barber_name || "");
        const date = body.date;
        const hour = Number(body.hour);
        if (!barberNames.has(barberName) || !validIsoDate(date) || !Number.isInteger(hour) || hour < 8 || hour > 21 || typeof body.is_available !== "boolean") {
          return responseError("Barbeiro, data, horário ou disponibilidade inválidos.");
        }
        const matching = await admin.entities.BarberAvailability.filter(
          { barber_name: barberName, date, hour },
          "-created_date",
          2,
          0,
        );
        if (!body.is_available) {
          const confirmedRequests = await admin.entities.BookingRequest.filter(
            { barber_name: barberName, date, hour, status: "confirmed" },
            "-created_date",
            2,
            0,
          );
          if (confirmedRequests.length) return responseError("Há um atendimento confirmado nesse horário.", 409);
        }
        const slotData = { barber_name: barberName, date, hour, is_available: body.is_available, updated_by: user.email };
        const slot = matching[0]
          ? await admin.entities.BarberAvailability.update(matching[0].id, slotData)
          : await admin.entities.BarberAvailability.create(slotData);
        return Response.json({ slot });
      }
      case "createCashEntry": {
        const barberName = String(body.barber_name || "");
        const entryType = String(body.entry_type || "");
        const description = String(body.description || "").trim();
        const amount = Number(body.amount_brl);
        if (!(cashBarbers as readonly string[]).includes(barberName) || !["income", "expense"].includes(entryType) || !description || description.length > 120 || !Number.isFinite(amount) || amount <= 0 || amount > 1000000 || !validIsoDate(body.entry_date)) {
          return responseError("Informe barbeiro, tipo, valor, descrição e data válidos.");
        }
        const entry = await admin.entities.CashEntry.create({
          barber_name: barberName,
          entry_type: entryType,
          amount_cents: Math.round(amount * 100),
          description,
          entry_date: body.entry_date,
        });
        return Response.json({ entry }, { status: 201 });
      }
      case "deleteCashEntry": {
        const id = String(body.id || "");
        if (!id) return responseError("Identificador do lançamento ausente.");
        const result = await admin.entities.CashEntry.delete(id);
        return Response.json({ success: result.success });
      }
      case "updateBookingRequest": {
        const id = String(body.id || "");
        const status = String(body.status || "");
        if (!id || !["confirmed", "declined"].includes(status)) return responseError("Solicitação ou status inválido.");
        const requestRecord = await admin.entities.BookingRequest.get(id).catch(() => null);
        if (!requestRecord) return responseError("Solicitação não encontrada.", 404);
        if (status === "confirmed") {
          const [blockedSlots, otherConfirmedRequests] = await Promise.all([
            admin.entities.BarberAvailability.filter({
              barber_name: requestRecord.barber_name,
              date: requestRecord.date,
              hour: requestRecord.hour,
              is_available: false,
            }, "-created_date", 2, 0),
            admin.entities.BookingRequest.filter({
              barber_name: requestRecord.barber_name,
              date: requestRecord.date,
              hour: requestRecord.hour,
              status: "confirmed",
            }, "-created_date", 10, 0),
          ]);
          if (blockedSlots.length || otherConfirmedRequests.some(item => item.id !== id)) {
            return responseError("O horário não está mais disponível.", 409);
          }
        }
        const booking = await admin.entities.BookingRequest.update(id, {
          status,
          admin_note: String(body.admin_note || "").trim().slice(0, 300),
        });
        return Response.json({ booking });
      }
      default:
        return responseError("Ação administrativa não reconhecida.");
    }
  } catch (error) {
    console.error("Admin action failed", error);
    return responseError("Não foi possível concluir a operação administrativa.", 500);
  }
}