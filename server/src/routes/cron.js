import { Router } from "express";
import { runWeatherChecks, getCronKey } from "../scheduler.js";

const router = Router();

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
  if (provided !== cronKey && !(dev && !cronKey)) {
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
