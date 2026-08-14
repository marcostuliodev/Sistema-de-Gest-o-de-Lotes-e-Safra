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
registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);