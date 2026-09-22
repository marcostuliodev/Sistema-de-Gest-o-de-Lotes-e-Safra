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
  // Confere atualização periodicamente para puxar novos deploys sem
  // exigir limpeza manual de cache do navegador.
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    setInterval(() => {
      registration.update().catch(() => undefined);
    }, 15 * 60 * 1000);
    // Assim que um novo SW assume, recarrega para servir o bundle novo.
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "activated" && navigator.serviceWorker.controller) {
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