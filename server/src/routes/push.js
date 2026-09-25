import { Router } from "express";
import rateLimit from "express-rate-limit";
import { v4 as uuid } from "uuid";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { getVapidPublic, sendPush, isValidPushEndpoint } from "../push.js";
import { fetchWeather, normalizeWeatherLocation } from "../weather.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";
import { projectMiddleware, requireProjectPermission, PERMISSIONS } from "../authz.js";
import { findProjectOwnerUser, getProjectId } from "../projectScope.js";

const router = Router();
router.use(authMiddleware);
router.use(projectMiddleware);
router.use(requireProjectPermission(PERMISSIONS.WEATHER_READ));

async function requireWeatherFeature(req, res, next) {
  try {
    const { plan } = await resolveEffectivePlan(req.user.uid, req.projectId);
    if (!getPlanFeatures(plan).climaAlertas) {
      return res.status(403).json({ error: "Alertas climáticos exigem um plano pago.", code: "PLAN_LIMIT" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

// Evita força bruta / abuso do endpoint de subscribe (SSRF probe).
const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Muitas tentativas de inscrição, tente novamente mais tarde" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get(
  "/vapid",
  asyncHandler(async (_req, res) => {
    const pub = await getVapidPublic();
    res.json({ publicKey: pub });
  })
);

router.post(
  "/subscribe",
  subscribeLimiter,
  requireWeatherFeature,
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (
      typeof endpoint !== "string" || !endpoint ||
      !keys || typeof keys !== "object" ||
      typeof keys.p256dh !== "string" || !keys.p256dh ||
      typeof keys.auth !== "string" || !keys.auth
    ) {
      return res.status(400).json({ error: "Inscrição inválida" });
    }
    // SSRF: endpoint precisa ser uma URL https pública (FCM/Mozilla/Apple…).
    // Bloqueia localhost, IPs privados/link-local e *.internal/*.local.
     const endpointValidation = await isValidPushEndpoint(endpoint);
     if (endpointValidation === "retry") {
       return res.status(503).json({ error: "Não foi possível validar o endpoint temporariamente. Tente novamente." });
     }
     if (endpointValidation !== "valid") {
       return res
         .status(400)
         .json({ error: "Endpoint de push inválido: apenas URLs https públicas são permitidas" });
     }
    const subsCol = await col("push_subscriptions");
     const userId = req.projectAccess?.userKey || req.user.uid;
     await subsCol.deleteMany({
       $and: [
         { $or: [{ user_id: userId }, { actor: userId }] },
         { $or: [{ project_id: getProjectId(req) }, { project_id: { $exists: false } }] },
       ],
       endpoint,
     });
     await subsCol.insertOne({
       _id: uuid(),
      user_id: req.projectAccess?.userKey || req.user.uid,
      actor: req.projectAccess?.userKey || req.user.uid,
       project_id: getProjectId(req),
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
    if (typeof endpoint !== "string" || !endpoint) {
      return res.status(400).json({ error: "endpoint obrigatório" });
    }
    const subsCol = await col("push_subscriptions");
     const userId = req.projectAccess?.userKey || req.user.uid;
     await subsCol.deleteMany({
       $and: [
         { $or: [{ user_id: userId }, { actor: userId }] },
         { $or: [{ project_id: getProjectId(req) }, { project_id: { $exists: false } }] },
       ],
       endpoint,
     });
    res.json({ ok: true });
  })
);

router.post(
  "/test",
  requireWeatherFeature,
  asyncHandler(async (req, res) => {
     const subsCol = await col("push_subscriptions");
     const projectId = getProjectId(req);
     const userId = req.projectAccess?.userKey || req.user.uid;
     const subs = await subsCol.find({ $or: [{ user_id: userId }, { actor: userId }], project_id: projectId }).toArray();
     if (subs.length === 0) return res.status(400).json({ error: "Nenhuma inscrição de push" });

     let weather = null;
     const owner = await findProjectOwnerUser(req);
     const location = normalizeWeatherLocation(req.project?.fields || owner);
     if (location) {
       try {
         weather = await fetchWeather(location.lat, location.lon, location.tz || "auto", { projectId });
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
       const result = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        if (result === "invalid" && (s._id || s.id)) await subsCol.deleteOne({ _id: s._id || s.id });
       else if (result === "sent") sent++;
    }
    res.json({ ok: true, sent });
  })
);

export default router;
