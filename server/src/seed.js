import { v4 as uuid } from "uuid";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, migrate } from "./db.js";
import { createDemoAccount } from "./routes/auth.js";

export async function seed() {
  await migrate();
  const uid = await createDemoAccount();

  const today = new Date();
  const iso = (d) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const addDays = (days) => iso(new Date(Date.now() + days * 864e5));

  const lotes = [
    { id: uuid(), nome: "Talhão Norte", tipo: "talhao", area: 1200, localizacao: "Setor 1" },
    { id: uuid(), nome: "Estufa Principal", tipo: "bancada", area: 340, localizacao: "Ao lado do galpão" },
    { id: uuid(), nome: "Horta Sul", tipo: "talhao", area: 800, localizacao: "Margem do riacho" },
  ];

  const insumos = [
    { id: uuid(), nome: "Semente de Alface", categoria: "semente", unidade: "pacote" },
    { id: uuid(), nome: "Fertilizante NPK 10-10-10", categoria: "fertilizante", unidade: "kg" },
    { id: uuid(), nome: "Adubo Orgânico", categoria: "adubo", unidade: "kg" },
    { id: uuid(), nome: "Mudas de Tomate", categoria: "muda", unidade: "un" },
    { id: uuid(), nome: "Defensivo Natural Neem", categoria: "defensivo", unidade: "L" },
  ];

  const seedLote = (l) =>
    db.prepare("INSERT INTO lotes (id, user_id, nome, tipo, area, localizacao) VALUES (?, ?, ?, ?, ?, ?)").run(l.id, uid, l.nome, l.tipo, l.area, l.localizacao);
  const seedInsumo = (i) =>
    db.prepare("INSERT INTO insumos (id, user_id, nome, categoria, unidade) VALUES (?, ?, ?, ?, ?)").run(i.id, uid, i.nome, i.categoria, i.unidade);

  const plantio = async (lote, cultura, daysPlantedAgo, previstoEmDias, extra = {}) => {
    const id = uuid();
    await db.prepare(
      "INSERT INTO plantios (id, user_id, lote_id, cultura, cultivar, data_plantio, data_colheita_prevista, qtd_plantada, unidade, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, uid, lote.id, cultura, extra.cultivar || "Padrão", addDays(-daysPlantedAgo), extra.previsto ? iso(extra.previsto) : addDays(previstoEmDias), extra.qtd || 100, extra.unidade || "un", extra.status || "ativo");
    return id;
  };

  const gasto = async (pid, insumo, qtd, valor, daysAgo, descricao) => {
    await db.prepare("INSERT INTO gastos (id, user_id, plantio_id, insumo_id, descricao, quantidade, valor_unitario, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      uuid(), uid, pid, insumo.id, descricao, qtd, valor, addDays(-daysAgo)
    );
  };

  const colheita = async (pid, qtd, preco, daysAgo, unidade = "kg") => {
    await db.prepare("INSERT INTO colheitas (id, user_id, plantio_id, data, quantidade, unidade, preco_venda) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      uuid(), uid, pid, addDays(-daysAgo), qtd, unidade, preco
    );
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
