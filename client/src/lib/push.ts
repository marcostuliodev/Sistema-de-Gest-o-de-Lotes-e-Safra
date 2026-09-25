import { getActiveScope } from "../db/db";
import { getScopedStorageItem, removeScopedStorageItem, setScopedStorageItem } from "./scoped-storage";

const ACTIVE_PUSH_KEY = "active_push_endpoint";

function projectHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const scope = getActiveScope();
  if (scope) headers.set("X-Project-Id", scope.projectId);
  return headers;
}

function pushStorageContext() {
  const scope = getActiveScope();
  return scope ? { userId: scope.userId, projectId: scope.projectId } : null;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function getVapid(): Promise<string> {
  const res = await fetch("/api/push/vapid", { credentials: "include", headers: projectHeaders() });
  if (!res.ok) throw new Error("Falha ao obter chave VAPID");
  const data = await res.json();
  return data.publicKey;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function subscribePush(): Promise<void> {
  if (!isPushSupported()) throw new Error("Push não suportado neste navegador");
  if (Notification.permission === "denied") throw new Error("Notificações bloqueadas pelo navegador");
  if (Notification.permission === "default") {
    const p = await Notification.requestPermission();
    if (p !== "granted") throw new Error("Permissão de notificação negada");
  }
  const reg = await navigator.serviceWorker.ready;
  const vapid = await getVapid();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid),
  });
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: projectHeaders({ "Content-Type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys }),
  });
   if (!res.ok) throw new Error("Falha ao salvar inscrição");
   const context = pushStorageContext();
   if (context) setScopedStorageItem(context, ACTIVE_PUSH_KEY, sub.endpoint, "local");
 }

export async function unsubscribePush(): Promise<void> {
  const context = pushStorageContext();
  if (!isPushSupported()) {
    if (context) removeScopedStorageItem(context, ACTIVE_PUSH_KEY, "local");
    return;
  }
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Service worker indisponível")), 1500)),
    ]);
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: projectHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
  } finally {
    if (context) removeScopedStorageItem(context, ACTIVE_PUSH_KEY, "local");
  }
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const context = pushStorageContext();
  if (!context) return null;
  const activeEndpoint = getScopedStorageItem(context, ACTIVE_PUSH_KEY, "local", false);
  return activeEndpoint === sub.endpoint ? sub : null;
}

export async function sendTestPush(): Promise<void> {
  const res = await fetch("/api/push/test", {
    method: "POST",
    headers: projectHeaders(),
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Falha ao enviar teste");
  }
  const data = await res.json().catch(() => ({}));
  if (!data.sent) {
    throw new Error("Nenhuma inscrição ativa recebeu o push — reative as notificações no app.");
  }
}
