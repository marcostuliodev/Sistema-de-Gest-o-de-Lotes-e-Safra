import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { getVapidPublic, sendPush } from "../push.js";
import { fetchWeather } from "../weather.js";

const router = Router();
router.use(authMiddleware);

router.get(
  "/vapid",
  asyncHandler(async (_req, res) => {
    const pub = await getVapidPublic();
    res.json({ publicKey: pub });
  })
);

router.post(
  "/subscribe",
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "Inscrição inválida" });
    }
    // Substitui qualquer inscrição existente deste endpoint para este usuário.
    await db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(req.user.uid, endpoint);
    await db
      .prepare("INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, now()::text)")
      .run(uuid(), req.user.uid, endpoint, keys.p256dh, keys.auth);
    res.json({ ok: true });
  })
);

router.post(
  "/unsubscribe",
  asyncHandler(async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint obrigatório" });
    await db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(req.user.uid, endpoint);
    res.json({ ok: true });
  })
);

// Envia uma notificação de teste para confirmar que o push funciona.
router.post(
  "/test",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT lat, lon, tz FROM users WHERE id = ?").get(req.user.uid);
    const subs = await db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(req.user.uid);
    if (subs.length === 0) return res.status(400).json({ error: "Nenhuma inscrição de push" });

    let weather = null;
    if (row && row.lat != null) {
      try {
        weather = await fetchWeather(row.lat, row.lon, row.tz || "auto");
      } catch {
        weather = null;
      }
    }
    const alert = weather?.alerts?.[0];
    const payload = alert
      ? { title: `[Teste] ${alert.title}`, body: alert.body, url: "/clima", tag: "teste" }
      : { title: "Agrolote — notificações ativas", body: "Você receberá alertas climáticos aqui.", url: "/clima", tag: "teste" };

    let sent = 0;
    for (const s of subs) {
      const ok = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      if (!ok) await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
      else sent++;
    }
    res.json({ ok: true, sent });
  })
);

export default router;
