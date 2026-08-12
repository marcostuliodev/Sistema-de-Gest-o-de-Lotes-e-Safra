import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { db, migrate } from "./db.js";
import { createDemoAccount } from "./routes/auth.js";
import authRouter from "./routes/auth.js";
import crudRouter from "./routes/crud.js";
import reportsRouter from "./routes/reports.js";
import syncRouter from "./routes/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

migrate();

// Banco novo? Cria conta demo com dados para visualização (só o primeiro boot).
if (process.env.SEED_DEMO !== "false") {
  const users = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (users === 0) {
    console.log("🌾 Banco novo — semeando dados demo...");
    // usamos dynamic import porque seed.js executa tudo no carregamento
    import("./seed.js").catch((err) => console.error("Falha no seed:", err.message));
  } else {
    createDemoAccount();
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, name: "agrolote-api", time: new Date().toISOString() }));

app.use("/api/auth", authRouter);
app.use("/api/lotes", crudRouter("lotes"));
app.use("/api/plantios", crudRouter("plantios"));
app.use("/api/insumos", crudRouter("insumos"));
app.use("/api/gastos", crudRouter("gastos"));
app.use("/api/colheitas", crudRouter("colheitas"));
app.use("/api/reports", reportsRouter);
app.use("/api/sync", syncRouter);

// Serve static PWA build if it exists (single-node deploy, works offline after install)
const distDir = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.listen(PORT, async () => {
  const demoId = createDemoAccount();
  console.log(`🌱 Agrolote API em http://localhost:${PORT}`);
  console.log(`   Conta demo: demo@agrolote.app / demo123 (id ${demoId})`);
});