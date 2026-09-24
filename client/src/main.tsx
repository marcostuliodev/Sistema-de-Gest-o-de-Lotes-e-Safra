import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./store/auth";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { startSyncWatcher } from "./db/sync";
import "./index.css";

startSyncWatcher();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <UpdatePrompt />
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);