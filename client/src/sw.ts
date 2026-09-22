import { precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

// Em projetos com lib DOM, `self` não é tipado como ServiceWorkerGlobalScope.
// Cast para any evita conflito de libs e mantém o SW funcional.
const sw: any = self;

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (event: any) => event.waitUntil(sw.clients.claim()));

// Navegações (HTML) SEMPRE tentam a rede primeiro — senão o precache de
// index.html segura o shell antigo e novos deploys (ex.: botão AgroIA)
// nunca aparecem até o usuário limpar o cache.
registerRoute(
  ({ request }: { request: Request }) => request.mode === "navigate",
  new NetworkFirst({
    cacheName: "pages",
    networkTimeoutSeconds: 4,
  })
);

precacheAndRoute(((self as any).__WB_MANIFEST) || []);

// Cache de API (exceto auth) em NetworkFirst.
registerRoute(
  ({ url }: { url: URL }) => url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth"),
  new NetworkFirst({ cacheName: "api-cache" })
);

sw.addEventListener("push", (event: any) => {
  let payload: any = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: "Agrolote", body: event.data.text() };
    }
  }
  const title = payload.title || "Agrolote";
  // Garante body não-vazio: alguns SOs silenciam/ignoram notificação sem texto.
  const body =
    typeof payload.body === "string" && payload.body.length > 0
      ? payload.body
      : "Toque para ver os detalhes no app.";
  const options: any = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.tag || "clima",
    // Re-alerta (som/vibração) mesmo com tag repetida, em vez de substituir
    // silenciosamente; e mantém a notificação visível até o usuário agir.
    renotify: true,
    requireInteraction: true,
    timestamp: Date.now(),
    data: { url: payload.url || "/clima" },
  };
  event.waitUntil(
    sw.registration
      .showNotification(title, options)
      .catch((e: any) => console.error("[sw] Falha ao exibir notificação:", e))
  );
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
