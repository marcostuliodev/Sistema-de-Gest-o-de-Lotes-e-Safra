import { Router } from "express";
import { runWeatherChecks } from "../scheduler.js";

const router = Router();

// Disparado por um agendador externo (ex.: cron-job.org / UptimeRobot) para
// rodar as verificações de clima mesmo quando o Render "dorme" o free tier.
// Use GET /api/cron/weather?key=CRON_KEY (ou header x-cron-key).
router.get("/weather", async (req, res) => {
  const cronKey = process.env.CRON_KEY;
  const provided = req.query.key || req.get("x-cron-key");
  if (cronKey && provided !== cronKey) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!cronKey) {
    console.warn("[cron] CRON_KEY não definida — endpoint liberado apenas em dev.");
  }
  try {
    await runWeatherChecks();
    res.json({ ok: true, ranAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
