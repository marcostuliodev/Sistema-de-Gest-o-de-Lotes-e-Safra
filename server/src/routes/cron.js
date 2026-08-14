import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { runWeatherChecks, getCronKey } from "../scheduler.js";

const router = Router();

// Comparação à prova de ataque de temporização (timing-safe). Evita que um
// atacante infira o CRON_KEY byte a byte medindo o tempo de resposta.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Disparado por um agendador externo (ex.: GitHub Actions / cron-job.org) para
// rodar as verificações de clima mesmo quando o Render "dorme" o free tier.
// Use GET /api/cron/weather?key=CRON_KEY (ou header x-cron-key).
router.get("/weather", async (req, res) => {
  const provided = req.query.key || req.get("x-cron-key");
  let cronKey = null;
  try {
    cronKey = await getCronKey();
  } catch {
    /* db pode estar indisponível momentaneamente */
  }
  const dev = process.env.NODE_ENV !== "production";
  const keyMatches = safeEqual(provided, cronKey);
  const devBypass = dev && !cronKey;
  if (!keyMatches && !devBypass) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    await runWeatherChecks();
    res.json({ ok: true, ranAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
