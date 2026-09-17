import { Router } from "express";
import { v4 as uuid } from "uuid";
import { col } from "../db.js";
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
    const subsCol = await col("push_subscriptions");
    await subsCol.deleteMany({ user_id: req.user.uid, endpoint });
    await subsCol.insertOne({
      _id: uuid(),
      user_id: req.user.uid,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  })
);

router.post(
  "/unsubscribe",
  asyncHandler(async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint obrigatório" });
    const subsCol = await col("push_subscriptions");
    await subsCol.deleteMany({ user_id: req.user.uid, endpoint });
    res.json({ ok: true });
  })
);

router.post(
  "/test",
  asyncHandler(async (req, res) => {
    const usersCol = await col("users");
    const subsCol = await col("push_subscriptions");

    const row = await usersCol.findOne({ _id: req.user.uid });
    const subs = await subsCol.find({ user_id: req.user.uid }).toArray();
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
      if (!ok) await subsCol.deleteOne({ _id: s._id || s.id });
      else sent++;
    }
    res.json({ ok: true, sent });
  })
);

export default router;
