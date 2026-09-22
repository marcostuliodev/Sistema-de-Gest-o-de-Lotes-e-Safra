import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./store/auth";
import { startSyncWatcher } from "./db/sync";
import "./index.css";

startSyncWatcher();

// Registro do service worker (necessário porque usamos injectRegister: false)
import { registerSW } from "virtual:pwa-register";
registerSW({
  immediate: true,
  // Atualização automática agressiva:
  // - Checa a cada 10s enquanto a aba está aberta para puxar novos deploys
  // - Recarrega imediatamente quando um novo SW é encontrado
  // - Evita que o usuário precise limpar o cache manualmente
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    // Checa novas versões a cada 10 segundos enquanto o app estiver aberto
    setInterval(() => {
      registration.update().catch(() => undefined);
    }, 10 * 1000);
    // Quando um novo SW é instalado, recarrega imediatamente
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          // Novo conteúdo disponível — recarrega na hora
          window.location.reload();
        }
      });
    });
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);