import { Router } from "express";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { sanitizeSnapshot } from "../validation.js";

const router = Router();
router.use(authMiddleware);

router.get("/dashboard", asyncHandler(async (req, res) => {
  const uid = req.user.uid;

  const plantiosCol = await col("plantios");
  const lotesCol = await col("lotes");
  const colheitasCol = await col("colheitas");
  const gastosCol = await col("gastos");

  const [ativos, lotes, harvests] = await Promise.all([
    plantiosCol.countDocuments({ user_id: uid, status: "ativo" }),
    lotesCol.countDocuments({ user_id: uid }),
    colheitasCol.countDocuments({ user_id: uid }),
  ]);

  const pending = await plantiosCol
    .find({
      user_id: uid,
      status: { $nin: ["colhido", "perdido"] },
      data_colheita_prevista: { $ne: null, $gte: new Date().toISOString().slice(0, 10) },
    })
    .sort({ data_colheita_prevista: 1 })
    .limit(25)
    .toArray();

  const lotesList = await lotesCol.find({ user_id: uid }).toArray();
  const loteMap = Object.fromEntries(lotesList.map((l) => [l._id || l.id, l]));
  const pendingWithLote = pending.map((p) => ({
    ...p,
    id: p._id || p.id,
    lote_nome: loteMap[p.lote_id]?.nome || "",
  }));

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const gastos = await gastosCol.find({ user_id: uid }).toArray();
  let custo_total = 0, custo_30d = 0;
  for (const g of gastos) {
    const custo = (g.quantidade || 0) * (g.valor_unitario || 0);
    custo_total += custo;
    if (g.data && g.data >= thirtyDaysAgo) custo_30d += custo;
  }

  const colheitas = await colheitasCol.find({ user_id: uid }).toArray();
  let receita_total = 0, receita_30d = 0;
  for (const c of colheitas) {
    const receita = (c.quantidade || 0) * (c.preco_venda || 0);
    receita_total += receita;
    if (c.data && c.data >= thirtyDaysAgo) receita_30d += receita;
  }

  res.json({
    ativos,
    lotes,
    colheitas: harvests,
    custo_total,
    custo_30d,
    receita_total,
    receita_30d,
    lucro_total: receita_total - custo_total,
    lucro_30d: receita_30d - custo_30d,
    proximas_colheitas: sanitizeSnapshot({ proximas_colheitas: pendingWithLote }).proximas_colheitas,
  });
}));

router.get("/performance", asyncHandler(async (req, res) => {
  const uid = req.user.uid;

  const plantiosCol = await col("plantios");
  const colheitasCol = await col("colheitas");
  const gastosCol = await col("gastos");

  const [plantios, allColheitas, allGastos] = await Promise.all([
    plantiosCol.find({ user_id: uid }).toArray(),
    colheitasCol.find({ user_id: uid }).toArray(),
    gastosCol.find({ user_id: uid }).toArray(),
  ]);

  const groups = {};
  for (const p of plantios) {
    const cult = p.cultura || "Outro";
    if (!groups[cult]) groups[cult] = { cultura: cult, plantios: 0, rendimento: 0, receita: 0, custo: 0 };

    groups[cult].plantios++;

    const cols = allColheitas.filter((c) => c.plantio_id === p.id || c.plantio_id === (p._id?.toString()));
    for (const c of cols) {
      groups[cult].rendimento += c.quantidade || 0;
      groups[cult].receita += (c.quantidade || 0) * (c.preco_venda || 0);
    }

    const gas = allGastos.filter((g) => g.plantio_id === p.id || g.plantio_id === (p._id?.toString()));
    for (const g of gas) {
      groups[cult].custo += (g.quantidade || 0) * (g.valor_unitario || 0);
    }
  }

  const perf = Object.values(groups)
    .map((r) => ({ ...r, custo: r.custo ?? 0, lucro: (r.receita ?? 0) - (r.custo ?? 0) }))
    .sort((a, b) => b.receita - a.receita);

  res.json(sanitizeSnapshot({ perf }).perf);
}));

export default router;
