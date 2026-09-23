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

// Valida endpoint de Web Push antes de qualquer request do servidor (SSRF).
// Só aceita URLs https públicas — bloqueia localhost, IPs privados/link-local
// (ex.: 169.254.169.254 metadata cloud), *.internal e *.local.
function isBlockedHostname(hostnameRaw) {
  let h = String(hostnameRaw || "").toLowerCase();
  if (!h) return true;
  // URL.hostname traz IPv6 entre colchetes: "[::1]"
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // "localhost." (trailing dot DNS) é o mesmo host que "localhost"
  h = h.replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv4 mapeado em IPv6 → avalia só a parte IPv4.
  // O parser WHATWG canonicaliza para forma hex ("::ffff:c0a8:101"),
  // mas aceitamos também a forma dotted ("::ffff:192.168.1.1").
  const mappedDotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedDotted) {
    h = mappedDotted[1];
  } else if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    h = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  // IPv6: loopback, ULA (fc00::/7) e link-local (fe80::/10)
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    if (/^f[cd]/.test(h)) return true;
    if (/^fe[89ab]/.test(h)) return true;
    return false;
  }
  // IPv4 (o parser WHATWG de URL já normaliza formas decimais/octais p/ dotted quad)
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const parts = m.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8 (privado), 127/8 (loopback)
    if (a === 169 && b === 254) return true; // link-local / metadata cloud
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 (privado)
    if (a === 192 && b === 168) return true; // 192.168/16 (privado)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
    if (a >= 224) return true; // multicast/reservado
    return false;
  }
  // Hostname público (FCM, Mozilla, Apple…) → permitido (https obrigatório acima)
  return false;
}

export function isValidPushEndpoint(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 4096) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (isBlockedHostname(url.hostname)) return false;
  return true;
}

export async function getVapidPublic() {
  await ensureVapid();
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").get("vapid_public");
  return row?.value;
}

// Envia uma notificação. Retorna true em sucesso, false se a inscrição
// expirou/está inválida (deve ser removida).
export async function sendPush(subscription, payload) {
  // Guarda extra anti-SSRF: nunca fazer request para endpoint não-https/público
  // (ex.: inscrições antigas gravadas antes da validação em subscribe).
  if (!isValidPushEndpoint(subscription?.endpoint)) {
    console.warn("[push] Endpoint inválido/bloqueado — inscrição será removida.");
    return false;
  }
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
