import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";

// Em projetos com lib DOM, `self` não é tipado como ServiceWorkerGlobalScope.
// Cast para any evita conflito de libs e mantém o SW funcional.
const sw: any = self;

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (event: any) =>
  event.waitUntil(
    Promise.all([
      sw.clients.claim(),
      // VERSÕES ANTIGAS cacheavam respostas autenticadas em "api-cache".
      // Purga no activate para não deixar dados sensíveis órfãos no dispositivo.
      sw.caches.delete("api-cache"),
    ])
  )
);

// Navegações usam o shell HTML precacheado. Isso permite abrir uma rota
// profunda como /lotes ou /plantios mesmo sem rede e sem visita anterior.
precacheAndRoute(((self as any).__WB_MANIFEST) || []);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//],
  })
);

// Cache de APENAS endpoints públicos/estáticos (NetworkFirst).
// NUNCA cachear respostas autenticadas/sensíveis: /api/sync, /api/auth,
// /api/upgrade/license, /api/collaborators, /api/photos, /api/reports,
// /api/ai/*, /api/weather (contém localização/alertas do usuário), etc.
// Demais /api/* usam NetworkOnly — o dado sensível vive só no IndexedDB/outbox.
const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/upgrade/plans",
  "/api/upgrade/public-key",
]);

// Registrar ANTES do NetworkOnly: workbox casa a primeira rota registrada.
registerRoute(
  ({ url }: { url: URL }) => PUBLIC_API_PATHS.has(url.pathname),
  new NetworkFirst({ cacheName: "api-cache" })
);

registerRoute(
  ({ url }: { url: URL }) => url.pathname.startsWith("/api/"),
  new NetworkOnly()
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
  const raw = (event.notification.data && event.notification.data.url) || "/clima";
  // Anti open-redirect: só navega para path same-origin ("/..." ou origin igual).
  // Qualquer outra coisa (https://evil.com, //evil.com, javascript:) vira "/".
  let url = "/";
  try {
    const target = new URL(String(raw), sw.location.origin);
    if (target.origin === sw.location.origin) {
      url = target.pathname + target.search + target.hash;
    }
  } catch {
    url = "/";
  }
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
