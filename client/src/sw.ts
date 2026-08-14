import { precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

// Em projetos com lib DOM, `self` não é tipado como ServiceWorkerGlobalScope.
// Cast para any evita conflito de libs e mantém o SW funcional.
const sw: any = self;

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (event: any) => event.waitUntil(sw.clients.claim()));

precacheAndRoute(((self as any).__WB_MANIFEST) || []);

// Cache de API (exceto auth) em NetworkFirst.
registerRoute(
  ({ url }: { url: URL }) => url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth"),
  new NetworkFirst({ cacheName: "api-cache" })
);

sw.addEventListener("push", (event: any) => {
  if (!event.data) return;
  let payload: any = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Agrolote", body: event.data.text() };
  }
  const title = payload.title || "Agrolote";
  const options: any = {
    body: payload.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.tag || "clima",
    data: { url: payload.url || "/clima" },
  };
  event.waitUntil(sw.registration.showNotification(title, options));
});

sw.addEventListener("notificationclick", (event: any) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/clima";
  event.waitUntil(
    sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients: any[]) => {
      for (const client of clients) {
        if (client.focus) {
          client.focus();
          if (client.navigate) client.navigate(url);
          return;
        }
      }
      return sw.clients.openWindow(url);
    })
  );
});
