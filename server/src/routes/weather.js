import { Router } from "express";
import { col } from "../db.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { geocode, fetchWeather } from "../weather.js";
import { sanitizeText } from "../validation.js";
import {
  PERMISSIONS,
  projectMiddleware,
  requireProjectPermission,
} from "../authz.js";
import {
  buildProjectFilter,
  findProjectOwnerUser,
  getProjectId,
  isRecord,
  projectDocumentFilter,
} from "../projectScope.js";

const router = Router();
const WEATHER_UPDATE_PERMISSION = PERMISSIONS.WEATHER_UPDATE || PERMISSIONS.PROJECT_UPDATE;
router.use(authMiddleware);
router.use(projectMiddleware);

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

function validCoordinatePair(lat, lon) {
  if (lat === undefined || lat === null || lat === "" || lon === undefined || lon === null || lon === "") return null;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { lat: la, lon: lo };
}

function normalizeLocation(source) {
  if (!isRecord(source)) return null;
  const coords = validCoordinatePair(source.lat, source.lon);
  if (!coords) return null;
  const city = sanitizeText(String(source.city ?? "").slice(0, 200));
  const tz = sanitizeText(String(source.tz || "auto").slice(0, 64)) || "auto";
  return { ...coords, city, tz };
}

function projectLocation(project) {
  const candidates = [
    project?.fields,
    project?.fields?.location,
    project?.weather_location,
    project?.location,
    project?.weather,
    project,
  ];
  for (const candidate of candidates) {
    const location = normalizeLocation(candidate);
    if (location) return location;
  }
  return null;
}

async function selectedLocation(req) {
  const fromProject = projectLocation(req.project);
  if (fromProject) return fromProject;
  if (req.project?.is_default !== true) return null;

  const owner = await findProjectOwnerUser(req);
  return normalizeLocation(owner);
}

function safeCity(value) {
  return sanitizeText(String(value || "").slice(0, 200));
}

function safeTimezone(value) {
  return sanitizeText(String(value || "auto").slice(0, 64)) || "auto";
}

async function saveProjectLocation(req, location) {
  const projects = await col("projects");
  const currentFields = isRecord(req.project?.fields) ? { ...req.project.fields } : {};
  const fields = {
    ...currentFields,
    lat: location.lat,
    lon: location.lon,
    city: location.city,
    tz: location.tz,
  };
  const canUseDottedFields = req.project?.fields === undefined || isRecord(req.project?.fields);
  const locationUpdate = canUseDottedFields
    ? {
        "fields.lat": location.lat,
        "fields.lon": location.lon,
        "fields.city": location.city,
        "fields.tz": location.tz,
        updated_at: new Date().toISOString(),
      }
    : { fields, updated_at: new Date().toISOString() };
  const result = await projects.updateOne(projectDocumentFilter(req), { $set: locationUpdate });
  if (result.matchedCount === 0) return false;
  req.project.fields = fields;
  return true;
}

router.get(
  "/geocode",
  requireProjectPermission(PERMISSIONS.WEATHER_READ),
  requireWeatherFeature,
  asyncHandler(async (req, res) => {
    const results = await geocode(req.query.q || "");
    res.json({ results });
  })
);

router.get(
  "/location",
  requireProjectPermission(PERMISSIONS.WEATHER_READ),
  asyncHandler(async (req, res) => {
    const location = await selectedLocation(req);
    res.json({ location });
  })
);

router.post(
  "/location",
  requireProjectPermission(WEATHER_UPDATE_PERMISSION),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const coords = validCoordinatePair(body.lat, body.lon);
    if (!coords) return res.status(400).json({ error: "Coordenadas inválidas" });

    const location = {
      ...coords,
      city: safeCity(body.city),
      tz: safeTimezone(body.tz),
    };
    const saved = await saveProjectLocation(req, location);
    if (!saved) return res.status(404).json({ error: "Não foi possível salvar a localização" });
    return res.json({ ok: true, location });
  })
);

router.get(
  "/",
  requireProjectPermission(PERMISSIONS.WEATHER_READ),
  requireWeatherFeature,
  asyncHandler(async (req, res) => {
    try {
      const location = await selectedLocation(req);
      if (!location) return res.status(400).json({ error: "Localização não configurada" });
      const weather = await fetchWeather(location.lat, location.lon, location.tz, {
        projectId: getProjectId(req),
      });
      return res.json({
        location: {
          city: location.city,
          lat: location.lat,
          lon: location.lon,
          tz: location.tz,
        },
        weather,
      });
    } catch {
      return res.status(500).json({
        error: "Erro ao obter dados meteorológicos. Verifique sua conexão e tente novamente.",
      });
    }
  })
);

router.get(
  "/alerts",
  requireProjectPermission(PERMISSIONS.WEATHER_READ),
  requireWeatherFeature,
  asyncHandler(async (req, res) => {
    const scope = await buildProjectFilter(req);
    const alerts = await (await col("weather_alerts"))
      .find(scope)
      .sort({ sent_at: -1 })
      .limit(30)
      .toArray();
    res.json({ alerts });
  })
);

export default router;
