import { getSession } from "../db/api";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function getVapid(): Promise<string> {
  const session = getSession();
  const res = await fetch("/api/push/vapid", {
    headers: session ? { Authorization: `Bearer ${session.token}` } : {},
  });
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
  const session = getSession();
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session!.token}` },
    body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys }),
  });
  if (!res.ok) throw new Error("Falha ao salvar inscrição");
}

export async function unsubscribePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const session = getSession();
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session!.token}` },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  }
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function sendTestPush(): Promise<void> {
  const session = getSession();
  const res = await fetch("/api/push/test", {
    method: "POST",
    headers: { Authorization: `Bearer ${session!.token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Falha ao enviar teste");
  }
}
