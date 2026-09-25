import { v4 as uuid } from "uuid";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { col } from "./db.js";
import { createDemoAccount } from "./routes/auth.js";

export async function seed() {
  const uid = await createDemoAccount();

  const today = new Date();
  const iso = (d) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const addDays = (days) => iso(new Date(Date.now() + days * 864e5));

  const lotes = [
    { _id: uuid(), id: uuid(), nome: "Talhão Norte", tipo: "talhao", area_m2: 1200, area: 1200, localizacao: "Setor 1" },
    { _id: uuid(), id: uuid(), nome: "Estufa Principal", tipo: "bancada", area_m2: 340, area: 340, localizacao: "Ao lado do galpão" },
    { _id: uuid(), id: uuid(), nome: "Horta Sul", tipo: "talhao", area_m2: 800, area: 800, localizacao: "Margem do riacho" },
  ];

  const insumos = [
    { _id: uuid(), id: uuid(), nome: "Semente de Alface", categoria: "semente", unidade: "pacote" },
    { _id: uuid(), id: uuid(), nome: "Fertilizante NPK 10-10-10", categoria: "fertilizante", unidade: "kg" },
    { _id: uuid(), id: uuid(), nome: "Adubo Orgânico", categoria: "adubo", unidade: "kg" },
    { _id: uuid(), id: uuid(), nome: "Mudas de Tomate", categoria: "muda", unidade: "un" },
    { _id: uuid(), id: uuid(), nome: "Defensivo Natural Neem", categoria: "defensivo", unidade: "L" },
  ];

  const seedLote = async (l) => {
    const c = await col("lotes");
    await c.insertOne({ _id: l._id, id: l.id, user_id: uid, nome: l.nome, tipo: l.tipo, area_m2: l.area_m2, area: l.area_m2, localizacao: l.localizacao });
  };

  const seedInsumo = async (i) => {
    const c = await col("insumos");
    await c.insertOne({ _id: i._id, id: i.id, user_id: uid, nome: i.nome, categoria: i.categoria, unidade: i.unidade });
  };

  const plantio = async (lote, cultura, daysPlantedAgo, previstoEmDias, extra = {}) => {
    const id = uuid();
    const c = await col("plantios");
    await c.insertOne({
      _id: id,
      id,
      user_id: uid,
      lote_id: lote.id,
      cultura,
      cultivar: extra.cultivar || "Padrão",
      data_plantio: addDays(-daysPlantedAgo),
      data_colheita_prevista: extra.previsto ? iso(extra.previsto) : addDays(previstoEmDias),
      qtd_plantada: extra.qtd || 100,
      unidade: extra.unidade || "un",
      status: extra.status || "ativo",
    });
    return id;
  };

  const gasto = async (pid, insumo, qtd, valor, daysAgo, descricao) => {
    const c = await col("gastos");
    await c.insertOne({
      _id: uuid(),
      id: uuid(),
      user_id: uid,
      plantio_id: pid,
      insumo_id: insumo.id,
      descricao,
      quantidade: qtd,
      valor_unitario: valor,
      data: addDays(-daysAgo),
    });
  };

  const colheita = async (pid, qtd, preco, daysAgo, unidade = "kg") => {
    const c = await col("colheitas");
    await c.insertOne({
      _id: uuid(),
      id: uuid(),
      user_id: uid,
      plantio_id: pid,
      data: addDays(-daysAgo),
      quantidade: qtd,
      unidade,
      preco_venda: preco,
    });
  };

  for (const l of lotes) await seedLote(l);
  for (const i of insumos) await seedInsumo(i);

  // Alface — em andamento, colheita próxima
  const p1 = await plantio(lotes[1], "Alface", 35, 12, { cultivar: "Crespa", qtd: 300, unidade: "pés", status: "ativo" });
  await gasto(p1, insumos[0], 3, 18.5, 35, "Semente para 300 pés");
  await gasto(p1, insumos[1], 8, 6.4, 33, "Cobertura inicial");
  await gasto(p1, insumos[4], 2, 22, 10, "Preventivo pragas");

  // Tomate — colhido, ciclo encerrado
  const p2 = await plantio(lotes[1], "Tomate", 110, 0, { cultivar: "Santa Cruz", qtd: 60, unidade: "mudas", status: "colhido", previsto: addDays(-35) });
  await gasto(p2, insumos[3], 60, 1.2, 110, "Mudas 60 un");
  await gasto(p2, insumos[1], 25, 6.4, 90, "Manutenção ciclo");
  await gasto(p2, insumos[4], 3, 22, 40, "Controle de pragas");
  await colheita(p2, 420, 4.5, 35);
  await colheita(p2, 260, 4.0, 18);

  // Cenoura — planejada
  const p3 = await plantio(lotes[0], "Cenoura", 2, 95, { cultivar: "Nantes", qtd: 500, unidade: "mudas", status: "planejado" });
  await gasto(p3, insumos[1], 10, 6.4, 2, "Preparo do solo");

  // Couve — em andamento, colheita próxima
  const p4 = await plantio(lotes[2], "Couve", 45, 7, { cultivar: "Manteiga", qtd: 150, unidade: "pés", status: "ativo" });
  await gasto(p4, insumos[2], 20, 3.8, 40, "Adubação orgânica");

  console.log(`Seed concluído para u${uid}: ${lotes.length} lotes, ${insumos.length} insumos, plantios com colheitas.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  seed().catch((err) => {
    console.error("Falha no seed:", err.message);
    process.exit(1);
  });
}
