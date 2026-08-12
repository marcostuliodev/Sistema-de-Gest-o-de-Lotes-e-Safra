import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./store/auth";
import { startSyncWatcher } from "./db/sync";
import "./index.css";

startSyncWatcher();

// Registro do service worker é feito pelo vite-plugin-pwa
import("virtual:pwa-register").catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);