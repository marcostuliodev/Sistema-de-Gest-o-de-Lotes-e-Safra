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
// expirou/está inválida (deve ser removida).
export async function sendPush(subscription, payload) {
  await ensureVapid();
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    const code = err.statusCode;
    // 404/410: inscrição inexistente/expirada.
    // 401/403: falha de autenticação VAPID — a inscrição está quebrada (as
    // chaves VAPID no servidor não batem mais com a inscrição do dispositivo).
    // Em ambos, a inscrição deve ser removida. Antes retornávamos `true` nesses
    // casos, mascarando a falha: o servidor "emitia" mas o dispositivo nunca
    // recebia a notificação.
    if (code === 404 || code === 410 || code === 401 || code === 403) {
      console.warn(`[push] Inscrição inválida (HTTP ${code}) — será removida. Se persistir, o usuário precisa reativar o push no app.`);
      return false;
    }
    // 429/5xx/erro de rede: transitório, mantém a inscrição para retry no
    // próximo ciclo, mas NÃO conta como entregue.
    console.error(`[push] Falha transitória ao enviar push (HTTP ${code || "?"}):`, err.message);
    return true;
  }
}
