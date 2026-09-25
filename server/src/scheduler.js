import { col } from "./db.js";
import { randomBytes } from "node:crypto";
import { fetchWeather, normalizeWeatherLocation, ALERT_DEBOUNCE, isPushable } from "./weather.js";
import { sendPush } from "./push.js";
import { getSystemRole, idToString, normalizePermissions, PERMISSIONS } from "./authz.js";
import { getPlanFeatures, resolveEffectivePlan } from "./plans.js";
import { findProjectOwnerUser } from "./projectScope.js";

const INTERVAL = 15 * 60 * 1000;
const CRON_KEY_KV = "cron_key";

export async function getCronKey() {
  if (process.env.CRON_KEY) return process.env.CRON_KEY;
  const kvCol = await col("kv");
  const row = await kvCol.findOne({ key: CRON_KEY_KV });
  if (row) return row.value;
  const k = randomBytes(24).toString("hex");
  await kvCol.updateOne(
    { key: CRON_KEY_KV },
    { $set: { value: k } },
    { upsert: true }
  );
  return k;
}

export async function logCronKey() {
  const key = await getCronKey();
  const base = process.env.PUBLIC_URL || "https://agrolote.marcostuliogc.com.br";
  const masked = key && key.length > 4 ? "****" + key.slice(-4) : "****";
  console.log(`[cron] CRON_KEY em uso: ${masked} (valor completo disponível no painel da Render / env CRON_KEY)`);
  console.log(`[cron] Agende o push 24/7 com GET ${base}/api/cron/weather usando o header x-cron-key: <CRON_KEY> (sem logar a chave)`);
}

function scalarVariants(value) {
  if (value === undefined || value === null) return [];
  const values = [value, String(value)];
  const seen = new Set();
  return values.filter((item) => {
    const key = `${typeof item}:${String(item)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function activeWeatherSubscriptions(project, projectId, subscriptions) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return [];
  const membersCol = await col("project_members");
  const rolesCol = await col("roles");
  const projectValues = [projectId, project?._id, project?.id].flatMap(scalarVariants);
  const members = await membersCol.find({
    $and: [
      { $or: projectValues.map((value) => ({ project_id: value })) },
      { $or: [{ status: { $exists: false } }, { status: null }, { status: "active" }] },
    ],
  }).toArray();
  const roles = await rolesCol.find({ $or: projectValues.map((value) => ({ project_id: value })) }).toArray();
  const roleMap = new Map();
  for (const role of roles) {
    const id = idToString(role.id || role.role_id || role._id).toLowerCase();
    if (id) roleMap.set(id, role);
  }
  const allowed = new Set();
  for (const member of members) {
    const roleId = idToString(member.role_id || member.role).toLowerCase();
     if (roleId === "owner") {
       for (const value of [member.user_key, member.user_id]) {
         const key = idToString(value);
         if (key) allowed.add(key);
       }
       continue;
     }
    const system = getSystemRole(roleId);
    const custom = roleMap.get(roleId);
    const permissions = normalizePermissions(system?.permissions || custom?.permissions || []);
     if (permissions.includes(PERMISSIONS.WEATHER_READ)) {
       for (const value of [member.user_key, member.user_id]) {
         const key = idToString(value);
         if (key) allowed.add(key);
       }
     }
  }
  const ownerSeeds = [project?.owner_id, project?.owner_key, project?.created_by]
    .flatMap(scalarVariants)
    .map(idToString)
    .filter(Boolean);
  for (const owner of ownerSeeds) allowed.add(owner);

  const active = [];
  for (const subscription of subscriptions) {
    const key = idToString(subscription.user_id || subscription.actor);
    if (allowed.has(key)) {
      active.push(subscription);
    } else {
      await pushColDelete(subscription);
    }
  }
  return active;
}

async function pushColDelete(subscription) {
  if (!subscription) return;
  const id = subscription._id || subscription.id;
  if (!id) return;
  const subscriptions = await col("push_subscriptions");
  await subscriptions.deleteOne({ _id: id });
}

export async function runWeatherChecks() {
  const lockCollection = await col("scheduler_locks");
  const lockToken = randomBytes(16).toString("hex");
  let lock;
  try {
    lock = await lockCollection.findOneAndUpdate(
      {
        _id: "weather-checks",
        $or: [
          { expires_at: { $exists: false } },
          { expires_at: { $lte: new Date() } },
          { owner: lockToken },
        ],
      },
      { $set: { owner: lockToken, expires_at: new Date(Date.now() + 30 * 60 * 1000) } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    if (error?.code === 11000) return;
    throw error;
  }
  const lockDocument = lock?.value || lock;
  if (!lockDocument) return;

  try {
    const deadline = Date.now() + 45 * 1000;
    const projectsCol = await col("projects");
  const projects = await projectsCol.find({
    $or: [
       { "fields.lat": { $ne: null }, "fields.lon": { $ne: null } },
       { lat: { $ne: null }, lon: { $ne: null } },
       { is_default: true },
    ],
  }).toArray();
  const pushCol = await col("push_subscriptions");
  const alertCol = await col("weather_alerts");

   for (const project of projects) {
     if (Date.now() >= deadline) break;
     const projectId = project.id || project._id;
     let location = normalizeWeatherLocation(project.fields || project);
     if (!location && project.is_default === true) {
       try {
         const owner = await findProjectOwnerUser({ project });
         location = normalizeWeatherLocation(owner?.fields || owner);
       } catch {
         location = null;
       }
     }
     if (!location || !projectId) continue;
     const ownerId = project.owner_id || project.owner_key || project.created_by;
     if (!ownerId) continue;
     try {
       const effective = await resolveEffectivePlan(ownerId, projectId);
       if (!getPlanFeatures(effective.plan).climaAlertas) {
         await pushCol.deleteMany({
           $or: [{ project_id: projectId }, { project_id: project._id }],
         });
         continue;
       }
     } catch {
       // Falha de leitura do plano não deve disparar push potencialmente indevido.
       continue;
     }
     try {
       const projectValues = [projectId, project._id].flatMap(scalarVariants);
       const ownerKeys = [project.owner_id, project.owner_key, project.created_by].flatMap(scalarVariants);
       const subscriptionFilter = project.is_default === true
         ? {
             $or: [
               { project_id: { $in: projectValues } },
               { project_id: { $exists: false }, $or: [{ user_id: { $in: ownerKeys } }, { actor: { $in: ownerKeys } }] },
             ],
           }
         : { project_id: { $in: projectValues } };
       const subscriptions = await pushCol.find(subscriptionFilter).toArray();
       const subs = await activeWeatherSubscriptions(project, projectId, subscriptions);
       if (subs.length === 0) continue;
      const weather = await fetchWeather(location.lat, location.lon, location.tz || "auto", { projectId: String(projectId) });
      for (const alert of weather.alerts) {
        if (!isPushable(alert)) continue;
        const windowMs = ALERT_DEBOUNCE[alert.severity] || ALERT_DEBOUNCE.medium;
        const cutoff = new Date(Date.now() - windowMs).toISOString();
         const recent = await alertCol.findOne({
           project_id: String(projectId),
          type: alert.type,
          severity: alert.severity,
          sent_at: { $gt: cutoff },
        });
        if (recent) continue;

        const payload = {
          title: alert.title,
          body: alert.body,
          url: `/clima?project_id=${encodeURIComponent(String(projectId))}`,
          tag: `${projectId}:${alert.type}`,
          project_id: String(projectId),
        };
          let delivered = 0;
          let retryPending = false;
          for (const subscription of subs) {
           if (Date.now() >= deadline) {
             retryPending = true;
             break;
           }
           const result = await sendPush({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload);
            if (result === "invalid" && subscription._id) await pushCol.deleteOne({ _id: subscription._id });
           else if (result === "sent") delivered++;
           else if (result === "retry") retryPending = true;
         }
         if (delivered > 0 && !retryPending) {
          await alertCol.insertOne({
            project_id: String(projectId),
            type: alert.type,
            severity: alert.severity,
            title: alert.title,
            body: alert.body,
            sent_at: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      console.error("weather check falhou p/ projeto", String(projectId), error.message);
     }
   }
  } finally {
    await lockCollection.deleteOne({ _id: "weather-checks", owner: lockToken });
  }
}

let running = false;

export function startScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runWeatherChecks();
    } catch (e) {
      console.error("scheduler:", e.message);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, INTERVAL);
}
