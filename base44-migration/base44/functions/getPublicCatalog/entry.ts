import { createClientFromRequest } from "npm:@base44/sdk";

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

export default async function (request: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(request);
    const [serviceRecords, barberRecords] = await Promise.all([
      base44.asServiceRole.entities.Service.filter({ active: true }, "sort_order", 100, 0),
      base44.asServiceRole.entities.Barber.filter({ active: true }, "sort_order", 50, 0),
    ]);
    return Response.json({
      services: serviceRecords.length ? serviceRecords : defaultServices,
      barbers: barberRecords.length ? barberRecords : defaultBarbers,
    });
  } catch (error) {
    console.error("Public catalog lookup failed", error);
    return Response.json({ error: "Não foi possível carregar o catálogo." }, { status: 500 });
  }
}