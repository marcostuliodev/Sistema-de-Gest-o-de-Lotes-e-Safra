import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
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

// Render fica atrás de proxy; sem isso, req.ip seria o IP do proxy e o
// rate-limit contaria todos os usuários como um só.
app.set("trust proxy", true);

const IS_PROD = process.env.NODE_ENV === "production";

app.disable("x-powered-by");

app.use(
  helmet({
    hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    contentSecurityPolicy: IS_PROD
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    noSniff: true,
    frameguard: { action: "deny" },
    xssFilter: true,
    hidePoweredBy: true,
  })
);

const allowedOrigins = IS_PROD
  ? ["https://agrolote.onrender.com"]
  : ["http://localhost:5173", "http://localhost:4000", "http://127.0.0.1:5173"];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "256kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 10 : 100,
  message: { error: "Muitas tentativas, tente novamente mais tarde" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

async function bootstrap() {
  await migrate();

  if (process.env.SEED_DEMO !== "false") {
    const users = await db.prepare("SELECT COUNT(*) AS c FROM users").get();
    if (users.c === 0) {
      console.log("Banco novo — semeando dados demo...");
      const { seed } = await import("./seed.js");
      await seed();
    } else {
      await createDemoAccount();
    }
  }
}
bootstrap().catch((err) => console.error("Falha na inicialização:", err.message));

app.get("/api/health", (_req, res) => res.json({ ok: true, name: "agrolote-api", time: new Date().toISOString() }));

app.use("/api/auth", authRouter);
app.use("/api/lotes", crudRouter("lotes"));
app.use("/api/plantios", crudRouter("plantios"));
app.use("/api/insumos", crudRouter("insumos"));
app.use("/api/gastos", crudRouter("gastos"));
app.use("/api/colheitas", crudRouter("colheitas"));
app.use("/api/reports", reportsRouter);
app.use("/api/sync", syncRouter);

const distDir = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: IS_PROD ? "1y" : 0, etag: true }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.use((err, _req, res, _next) => {
  console.error("Erro:", err);
  // TEMPORÁRIO (debug): expõe a mensagem real do erro para diagnosticar o 500.
  res.status(500).json({ error: err?.message || "Erro interno" });
});

app.listen(PORT, async () => {
  if (!IS_PROD) {
    const demoId = await createDemoAccount();
    console.log(`Agrolote API em http://localhost:${PORT}`);
    console.log(`Conta demo: demo@agrolote.app / demo123 (id ${demoId})`);
  }
});

export default app;