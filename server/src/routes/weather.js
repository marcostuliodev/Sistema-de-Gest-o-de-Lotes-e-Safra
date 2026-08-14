import { Router } from "express";
import { db } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { geocode, fetchWeather } from "../weather.js";

const router = Router();
router.use(authMiddleware);

// Busca cidades (geocodificação).
router.get(
  "/geocode",
  asyncHandler(async (req, res) => {
    const results = await geocode(req.query.q || "");
    res.json({ results });
  })
);

// Lê a localização salva do produtor.
router.get(
  "/location",
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT lat, lon, city, tz FROM users WHERE id = ?")
      .get(req.user.uid);
    if (!row || row.lat == null || row.lon == null) {
      res.json({ location: null });
      return;
    }
    res.json({
      location: { lat: row.lat, lon: row.lon, city: row.city, tz: row.tz },
    });
  })
);

// Salva a localização da propriedade.
router.post(
  "/location",
  asyncHandler(async (req, res) => {
    const { lat, lon, city, tz } = req.body || {};
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
      return res.status(400).json({ error: "Coordenadas inválidas" });
    }
    await db
      .prepare("UPDATE users SET lat = ?, lon = ?, city = ?, tz = ? WHERE id = ?")
      .run(la, lo, String(city || ""), String(tz || "auto"), req.user.uid);
    res.json({ ok: true, location: { lat: la, lon: lo, city: city || "", tz: tz || "auto" } });
  })
);

// Clima atual (normalizado) da localização do produtor.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT lat, lon, city, tz FROM users WHERE id = ?")
      .get(req.user.uid);
    if (!row || row.lat == null || row.lon == null) {
      return res.status(400).json({ error: "Localização não configurada" });
    }
    const weather = await fetchWeather(row.lat, row.lon, row.tz || "auto");
    res.json({ location: { city: row.city, lat: row.lat, lon: row.lon, tz: row.tz }, weather });
  })
);

// Histórico de alertas enviados.
router.get(
  "/alerts",
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare(
        "SELECT type, severity, title, body, sent_at FROM weather_alerts WHERE user_id = ? ORDER BY sent_at DESC LIMIT 30"
      )
      .all(req.user.uid);
    res.json({ alerts: rows });
  })
);

export default router;
