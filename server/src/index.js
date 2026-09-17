import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { col, migrate } from "./db.js";
import { createDemoAccount } from "./routes/auth.js";
import authRouter from "./routes/auth.js";
import crudRouter from "./routes/crud.js";
import reportsRouter from "./routes/reports.js";
import syncRouter from "./routes/sync.js";
import weatherRouter from "./routes/weather.js";
import pushRouter from "./routes/push.js";
import cronRouter from "./routes/cron.js";
import upgradeRouter from "./routes/upgrade.js";
import { startScheduler, logCronKey } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
const IS_PROD = process.env.NODE_ENV === "production";
const IS_VERCEL = !!process.env.VERCEL;

// Render / Vercel ficam atrás de proxy; confiar em 1 hop
app.set("trust proxy", 1);

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
  ? ["https://agrolote.onrender.com", "https://agrolote.marcostuliogc.com.br", "https://agrolote.vercel.app"]
  : ["http://localhost:5173", "http://localhost:4000", "http://127.0.0.1:5173"];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin))) return cb(null, true);
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

// ═══════════════════════════════════════════════════════════════════════
// Bootstrap (roda uma vez — cold start no Vercel, startup no Render/VPS)
// ═══════════════════════════════════════════════════════════════════════
let bootstrapped = false;

async function bootstrap() {
  if (bootstrapped) return;

  await migrate();
  bootstrapped = true;
  await logCronKey().catch(() => {});

  if (process.env.SEED_DEMO !== "false") {
    const usersCol = await col("users");
    const count = await usersCol.countDocuments();
    if (count === 0) {
      console.log("Banco novo — semeando dados demo...");
      const { seed } = await import("./seed.js");
      await seed();
    } else {
      await createDemoAccount();
    }
  }
}

// Garante bootstrap antes de processar requests (wrapper middleware)
app.use(async (_req, _res, next) => {
  try {
    await bootstrap();
  } catch (err) {
    console.error("Falha no bootstrap:", err.message);
  }
  next();
});

// Em dev, mantemos o scheduler interno
if (!IS_PROD && !IS_VERCEL) {
  startScheduler();
}

// ═══════════════════════════════════════════════════════════════════════
// Rotas da API
// ═══════════════════════════════════════════════════════════════════════
app.get("/api/health", async (_req, res) => {
  const hasDb = !!process.env.MONGODB_URI;
  let dbOk = false;
  if (hasDb) {
    try {
      const c = await col("users");
      await c.findOne({});
      dbOk = true;
    } catch { dbOk = false; }
  }
  res.json({ ok: true, name: "agrolote-api", time: new Date().toISOString(), hasDb, dbOk });
});

app.use("/api/auth", authRouter);
app.use("/api/lotes", crudRouter("lotes"));
app.use("/api/plantios", crudRouter("plantios"));
app.use("/api/insumos", crudRouter("insumos"));
app.use("/api/gastos", crudRouter("gastos"));
app.use("/api/colheitas", crudRouter("colheitas"));
app.use("/api/reports", reportsRouter);
app.use("/api/sync", syncRouter);
app.use("/api/weather", weatherRouter);
app.use("/api/push", pushRouter);
app.use("/api/cron", cronRouter);
app.use("/api/upgrade", upgradeRouter);

// ═══════════════════════════════════════════════════════════════════════
// Static files (apenas em ambientes que servem SPA — NÃO no Vercel)
// ═══════════════════════════════════════════════════════════════════════
if (!IS_VERCEL) {
  const distDir = path.join(__dirname, "..", "..", "client", "dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { maxAge: IS_PROD ? "1y" : 0, etag: true }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Error handler
// ═══════════════════════════════════════════════════════════════════════
app.use((err, _req, res, _next) => {
  console.error("Erro:", err);
  res.status(500).json({ error: "Erro interno" });
});

// ═══════════════════════════════════════════════════════════════════════
// Listen (apenas fora do Vercel — no Vercel o serverless manager cuida)
// ═══════════════════════════════════════════════════════════════════════
if (!IS_VERCEL) {
  app.listen(PORT, async () => {
    if (!IS_PROD) {
      const demoId = await createDemoAccount();
      console.log(`Agrolote API em http://localhost:${PORT}`);
      console.log(`Conta demo: demo@agrolote.app / demo123 (id ${demoId})`);
    }
  });
}

export default app;
