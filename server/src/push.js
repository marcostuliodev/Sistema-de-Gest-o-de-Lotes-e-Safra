import webpush from "web-push";
import { db } from "./db.js";

const MAILTO = process.env.VAPID_MAILTO || "mailto:noreply@agrolote.app";

let initialized = false;

async function ensureVapid() {
  if (initialized) return;
  let pub = await db.prepare("SELECT value FROM kv WHERE key = ?").get("vapid_public");
  let priv = await db.prepare("SELECT value FROM kv WHERE key = ?").get("vapid_private");
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = { value: keys.publicKey };
    priv = { value: keys.privateKey };
    await db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?").run(
      "vapid_public",
      keys.publicKey,
      keys.publicKey
    );
    await db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?").run(
      "vapid_private",
      keys.privateKey,
      keys.privateKey
    );
  }
  webpush.setVapidDetails(MAILTO, pub.value, priv.value);
  initialized = true;
}

export async function getVapidPublic() {
  await ensureVapid();
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").get("vapid_public");
  return row?.value;
}

// Envia uma notificação. Retorna true em sucesso, false se a inscrição
// expirou (deve ser removida).
export async function sendPush(subscription, payload) {
  await ensureVapid();
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return false;
    console.error("Falha ao enviar push:", err.message);
    return true; // mantém a inscrição em caso de erro transitório
  }
}
