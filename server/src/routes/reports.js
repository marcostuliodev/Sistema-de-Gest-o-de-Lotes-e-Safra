import { Router } from "express";
import { db } from "../db.js";
import { authMiddleware } from "../auth.js";
import { sanitizeSnapshot, sanitizeRow } from "../validation.js";

const router = Router();
router.use(authMiddleware);

router.get("/dashboard", async (req, res) => {
  const uid = req.user.uid;

  const active = (await db.prepare("SELECT COUNT(*) c FROM plantios WHERE user_id = ? AND status = 'ativo'").get(uid)).c;
  const lotes = (await db.prepare("SELECT COUNT(*) c FROM lotes WHERE user_id = ?").get(uid)).c;
  const harvests = (await db.prepare("SELECT COUNT(*) c FROM colheitas WHERE user_id = ?").get(uid)).c;

  const pending = await db.prepare(`
    SELECT p.*, l.nome AS lote_nome
    FROM plantios p JOIN lotes l ON l.id = p.lote_id
    WHERE p.user_id = ? AND p.status NOT IN ('colhido','perdido')
      AND p.data_colheita_prevista IS NOT NULL AND p.data_colheita_prevista::date >= CURRENT_DATE
    ORDER BY p.data_colheita_prevista::date LIMIT 25
  `).all(uid);

  const costs = await db.prepare(`
    SELECT COALESCE(SUM(g.quantidade * g.valor_unitario), 0) AS custo_total,
           COALESCE(SUM(CASE WHEN g.data::date >= (CURRENT_DATE - INTERVAL '30 days') THEN g.quantidade * g.valor_unitario ELSE 0 END), 0) AS custo_30d
    FROM gastos g WHERE g.user_id = ?
  `).get(uid);

  const revenue = await db.prepare(`
    SELECT COALESCE(SUM(c.quantidade * c.preco_venda), 0) AS receita_total,
           COALESCE(SUM(CASE WHEN c.data::date >= (CURRENT_DATE - INTERVAL '30 days') THEN c.quantidade * c.preco_venda ELSE 0 END), 0) AS receita_30d
    FROM colheitas c WHERE c.user_id = ?
  `).get(uid);

  res.json({
    ativos: active,
    lotes,
    colheitas: harvests,
    custo_total: costs.custo_total,
    custo_30d: costs.custo_30d,
    receita_total: revenue.receita_total,
    receita_30d: revenue.receita_30d,
    lucro_total: revenue.receita_total - costs.custo_total,
    lucro_30d: revenue.receita_30d - costs.custo_30d,
    proximas_colheitas: sanitizeSnapshot({ proximas_colheitas: pending }).proximas_colheitas,
  });
});

router.get("/performance", async (req, res) => {
  const uid = req.user.uid;
  const rows = await db.prepare(`
    SELECT p.cultura,
           COUNT(DISTINCT p.id) AS plantios,
           COALESCE(SUM(c.quantidade), 0) AS rendimento,
           COALESCE(SUM(c.quantidade * c.preco_venda), 0) AS receita,
           COALESCE((
             SELECT SUM(g2.quantidade * g2.valor_unitario)
             FROM gastos g2 WHERE g2.plantio_id = p.id
           ), 0) AS custo
    FROM plantios p
    LEFT JOIN colheitas c ON c.plantio_id = p.id
    WHERE p.user_id = ?
    GROUP BY p.cultura
    ORDER BY receita DESC
  `).all(uid);
  const perf = rows.map((r) => ({ ...r, custo: r.custo ?? 0, lucro: (r.receita ?? 0) - (r.custo ?? 0) }));
  res.json(sanitizeSnapshot({ perf }).perf);
});

export default router;
