import { db } from "./db.js";
import { fetchWeather, ALERT_DEBOUNCE, isPushable } from "./weather.js";
import { sendPush } from "./push.js";

const INTERVAL = 15 * 60 * 1000;

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
