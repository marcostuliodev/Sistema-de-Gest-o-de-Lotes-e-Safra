import { db } from "./db.js";
import { randomBytes } from "node:crypto";
import { fetchWeather, ALERT_DEBOUNCE, isPushable } from "./weather.js";
import { sendPush } from "./push.js";

const INTERVAL = 15 * 60 * 1000;
const CRON_KEY_KV = "cron_key";

// Resolve a chave do cron: usa CRON_KEY do ambiente (render.yaml) ou, se não
// existir (serviço já existente onde o generateValue não criou a var), gera e
// persiste uma no kv para ter sempre uma chave estável.
export async function getCronKey() {
  if (process.env.CRON_KEY) return process.env.CRON_KEY;
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").get(CRON_KEY_KV);
  if (row) return row.value;
  const k = randomBytes(24).toString("hex");
  await db
    .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value")
    .run(CRON_KEY_KV, k);
  return k;
}

// Imprime a chave no log de startup para o produtor copiar p/ o agendador.
// A chave completa NUNCA é exposta em log (apenas os 4 últimos caracteres),
// evitando vazamento de segredo em agregadores de log (Render, etc.).
export async function logCronKey() {
  const key = await getCronKey();
  const base = process.env.PUBLIC_URL || "https://agrolote.marcostuliogc.com.br";
  const masked = key && key.length > 4 ? "****" + key.slice(-4) : "****";
  console.log(`[cron] CRON_KEY em uso: ${masked} (valor completo disponível no painel da Render / env CRON_KEY)`);
  console.log(`[cron] Agende o push 24/7 com: GET ${base}/api/cron/weather?key=<CRON_KEY>`);
}

// Verifica o clima de todos os usuários com localização + inscrição de push e
// envia alertas acionáveis (com debounce por tipo/severidade).
export async function runWeatherChecks() {
  const users = await db
    .prepare("SELECT id, lat, lon, tz FROM users WHERE lat IS NOT NULL AND lon IS NOT NULL")
    .all();
  for (const u of users) {
    try {
      const subs = await db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(u.id);
      if (subs.length === 0) continue;
      const weather = await fetchWeather(u.lat, u.lon, u.tz || "auto");
      for (const alert of weather.alerts) {
        if (!isPushable(alert)) continue;
        const windowMs = ALERT_DEBOUNCE[alert.severity] || ALERT_DEBOUNCE.medium;
        const recent = await db
          .prepare(
            "SELECT 1 FROM weather_alerts WHERE user_id = ? AND type = ? AND severity = ? AND (sent_at::timestamptz) > (now() - (? || ' milliseconds')::interval)"
          )
          .get(u.id, alert.type, alert.severity, String(windowMs));
        if (recent) continue;

        const payload = { title: alert.title, body: alert.body, url: "/clima", tag: alert.type };
        let delivered = 0;
        for (const s of subs) {
          const ok = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          if (!ok) await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
          else delivered++;
        }
        if (delivered > 0) {
          await db
            .prepare(
              "INSERT INTO weather_alerts (user_id, type, severity, title, body, sent_at) VALUES (?, ?, ?, ?, ?, now()::text)"
            )
            .run(u.id, alert.type, alert.severity, alert.title, alert.body);
        }
      }
    } catch (e) {
      console.error("weather check falhou p/ user", u.id, e.message);
    }
  }
}

export function startScheduler() {
  const tick = () => void runWeatherChecks().catch((e) => console.error("scheduler:", e.message));
  setTimeout(tick, 30 * 1000); // primeira varredura 30s após subir
  setInterval(tick, INTERVAL);
}
