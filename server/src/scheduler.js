import { col } from "./db.js";
import { randomBytes } from "node:crypto";
import { fetchWeather, ALERT_DEBOUNCE, isPushable } from "./weather.js";
import { sendPush } from "./push.js";

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

export async function runWeatherChecks() {
  const usersCol = await col("users");
  const users = await usersCol.find({ lat: { $ne: null }, lon: { $ne: null } }).toArray();

  const pushCol = await col("push_subscriptions");
  const alertCol = await col("weather_alerts");

  for (const u of users) {
    try {
      const subs = await pushCol.find({ user_id: u.id }).toArray();
      if (subs.length === 0) continue;
      const weather = await fetchWeather(u.lat, u.lon, u.tz || "auto");
      for (const alert of weather.alerts) {
        if (!isPushable(alert)) continue;
        const windowMs = ALERT_DEBOUNCE[alert.severity] || ALERT_DEBOUNCE.medium;
        const cutoff = new Date(Date.now() - windowMs).toISOString();
        const recent = await alertCol.findOne({
          user_id: u.id,
          type: alert.type,
          severity: alert.severity,
          sent_at: { $gt: cutoff },
        });
        if (recent) continue;

        const payload = { title: alert.title, body: alert.body, url: "/clima", tag: alert.type };
        let delivered = 0;
        for (const s of subs) {
          const ok = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          if (!ok) await pushCol.deleteOne({ _id: s._id });
          else delivered++;
        }
        if (delivered > 0) {
          await alertCol.insertOne({
            user_id: u.id,
            type: alert.type,
            severity: alert.severity,
            title: alert.title,
            body: alert.body,
            sent_at: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.error("weather check falhou p/ user", u.id, e.message);
    }
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
