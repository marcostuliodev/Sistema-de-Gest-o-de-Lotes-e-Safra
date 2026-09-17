import { Router } from "express";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { geocode, fetchWeather } from "../weather.js";

const router = Router();
router.use(authMiddleware);

router.get(
  "/geocode",
  asyncHandler(async (req, res) => {
    const results = await geocode(req.query.q || "");
    res.json({ results });
  })
);

router.get(
  "/location",
  asyncHandler(async (req, res) => {
    try {
      const usersCol = await col("users");
      const row = await usersCol.findOne({ _id: req.user.uid });
      if (!row || row.lat == null || row.lon == null) {
        res.json({ location: null });
        return;
      }
      res.json({
        location: { lat: row.lat, lon: row.lon, city: row.city, tz: row.tz },
      });
    } catch (e) {
      console.error("Erro ao buscar localização:", e);
      res.status(500).json({ error: "Erro interno ao carregar localização" });
    }
  })
);

router.post(
  "/location",
  asyncHandler(async (req, res) => {
    const { lat, lon, city, tz } = req.body || {};
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
      return res.status(400).json({ error: "Coordenadas inválidas" });
    }
    const safeCity = String(city || "").slice(0, 200);
    const safeTz = String(tz || "auto").slice(0, 64);
    const usersCol = await col("users");
    await usersCol.updateOne(
      { _id: req.user.uid },
      { $set: { lat: la, lon: lo, city: safeCity, tz: safeTz } }
    );
    res.json({ ok: true, location: { lat: la, lon: lo, city: safeCity, tz: safeTz } });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    try {
      const usersCol = await col("users");
      const row = await usersCol.findOne({ _id: req.user.uid });
      if (!row || row.lat == null || row.lon == null) {
        return res.status(400).json({ error: "Localização não configurada" });
      }
      const weather = await fetchWeather(row.lat, row.lon, row.tz || "auto");
      res.json({ location: { city: row.city, lat: row.lat, lon: row.lon, tz: row.tz }, weather });
    } catch (e) {
      console.error("Erro ao buscar clima:", e);
      res.status(500).json({ error: "Erro ao obter dados meteorológicos. Verifique sua conexão e tente novamente." });
    }
  })
);

router.get(
  "/alerts",
  asyncHandler(async (req, res) => {
    const alertsCol = await col("weather_alerts");
    const rows = await alertsCol
      .find({ user_id: req.user.uid })
      .sort({ sent_at: -1 })
      .limit(30)
      .toArray();
    res.json({ alerts: rows });
  })
);

export default router;
