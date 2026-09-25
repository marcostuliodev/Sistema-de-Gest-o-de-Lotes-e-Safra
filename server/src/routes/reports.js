import { Router } from "express";
import { col } from "../db.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { sanitizeSnapshot } from "../validation.js";
import {
  PERMISSIONS,
  idToString,
  normalizeId,
  projectMiddleware,
  requireProjectPermission,
} from "../authz.js";
import {
  buildProjectFilter,
  combineFilters,
} from "../projectScope.js";

const router = Router();
router.use(authMiddleware);
router.use(projectMiddleware);

async function requireAdvancedReports(req, res, next) {
  try {
    const { plan } = await resolveEffectivePlan(req.user.uid, req.projectId);
    if (!getPlanFeatures(plan).relatoriosAvancados) {
      return res.status(403).json({ error: "Relatórios avançados exigem um plano pago.", code: "PLAN_LIMIT" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function referenceKey(value) {
  return normalizeId(value) || idToString(value);
}

function sameReference(left, right) {
  const leftId = referenceKey(left);
  const rightId = referenceKey(right);
  return !!leftId && !!rightId && leftId === rightId;
}

function referencesRow(row, value) {
  return sameReference(row, value) || sameReference(row?._id, value) || sameReference(row?.id, value);
}

function entityId(row) {
  return row._id ?? row.id;
}

router.get(
  "/dashboard",
  requireProjectPermission(PERMISSIONS.REPORTS_READ),
  asyncHandler(async (req, res) => {
    const scope = await buildProjectFilter(req);
    const plantiosCol = await col("plantios");
    const lotesCol = await col("lotes");
    const colheitasCol = await col("colheitas");
    const gastosCol = await col("gastos");

    const [ativos, lotes, harvests] = await Promise.all([
      plantiosCol.countDocuments(combineFilters(scope, { status: "ativo" })),
      lotesCol.countDocuments(scope),
      colheitasCol.countDocuments(scope),
    ]);

    const pending = await plantiosCol
      .find(
        combineFilters(scope, {
          status: { $nin: ["colhido", "perdido"] },
          data_colheita_prevista: { $ne: null, $gte: new Date().toISOString().slice(0, 10) },
        })
      )
      .sort({ data_colheita_prevista: 1 })
      .limit(25)
      .toArray();

    const lotesList = await lotesCol.find(scope).toArray();
    const loteMap = Object.create(null);
    for (const lote of lotesList) {
      for (const value of [lote._id, lote.id]) {
        const id = referenceKey(value);
        if (id) loteMap[id] = lote;
      }
    }
    const pendingWithLote = pending.map((plantio) => ({
      ...plantio,
      id: entityId(plantio),
      lote_nome: loteMap[referenceKey(plantio.lote_id)]?.nome || "",
    }));

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const gastos = await gastosCol.find(scope).toArray();
    let custo_total = 0;
    let custo_30d = 0;
    for (const gasto of gastos) {
      const custo = (gasto.quantidade || 0) * (gasto.valor_unitario || 0);
      custo_total += custo;
      if (gasto.data && gasto.data >= thirtyDaysAgo) custo_30d += custo;
    }

    const colheitas = await colheitasCol.find(scope).toArray();
    let receita_total = 0;
    let receita_30d = 0;
    for (const colheita of colheitas) {
      const receita = (colheita.quantidade || 0) * (colheita.preco_venda || 0);
      receita_total += receita;
      if (colheita.data && colheita.data >= thirtyDaysAgo) receita_30d += receita;
    }

    return res.json({
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
  })
);

router.get(
  "/performance",
  requireProjectPermission(PERMISSIONS.REPORTS_READ),
  requireAdvancedReports,
  asyncHandler(async (req, res) => {
    const scope = await buildProjectFilter(req);
    const plantiosCol = await col("plantios");
    const colheitasCol = await col("colheitas");
    const gastosCol = await col("gastos");

    const [plantios, allColheitas, allGastos] = await Promise.all([
      plantiosCol.find(scope).toArray(),
      colheitasCol.find(scope).toArray(),
      gastosCol.find(scope).toArray(),
    ]);

    const groups = Object.create(null);
    for (const plantio of plantios) {
      const cultura = plantio.cultura || "Outro";
      if (!groups[cultura]) {
        groups[cultura] = { cultura, plantios: 0, rendimento: 0, receita: 0, custo: 0 };
      }

      groups[cultura].plantios++;
      const harvests = allColheitas.filter((colheita) => referencesRow(plantio, colheita.plantio_id));
      for (const colheita of harvests) {
        groups[cultura].rendimento += colheita.quantidade || 0;
        groups[cultura].receita += (colheita.quantidade || 0) * (colheita.preco_venda || 0);
      }

      const expenses = allGastos.filter((gasto) => referencesRow(plantio, gasto.plantio_id));
      for (const gasto of expenses) {
        groups[cultura].custo += (gasto.quantidade || 0) * (gasto.valor_unitario || 0);
      }
    }

    const performance = Object.values(groups)
      .map((row) => ({
        ...row,
        custo: row.custo ?? 0,
        lucro: (row.receita ?? 0) - (row.custo ?? 0),
      }))
      .sort((left, right) => right.receita - left.receita);

    return res.json(sanitizeSnapshot({ performance }).performance);
  })
);

export default router;
