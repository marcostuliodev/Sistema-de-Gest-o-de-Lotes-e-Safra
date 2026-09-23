/**
 * Assistente de IA (Google Gemini) — orquídeas e plantações.
 *
 * POST /api/ai/chat     — conversa em texto
 * POST /api/ai/analyze  — análise de imagem (multipart: campo "photo")
 * GET  /api/ai/usage    — uso diário do usuário
 * GET  /api/ai/status   — status da configuração
 *
 * Otimizações de tokens:
 * - Imagem comprimida para max 1024x1024 JPEG 80% antes do envio
 * - System prompts encurtados (~60% menores)
 * - maxTokens reduzido (800 para foto, 600 para chat)
 * - Cache de análise por hash de imagem (evita re-analisar mesma foto)
 */

import { Router } from "express";
import { createHash } from "crypto";
import sharp from "sharp";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { getPlanFeatures } from "../plans.js";
import { aiChat, parseAiJson, MODEL, geminiKey } from "../gemini.js";

const router = Router();
router.use(authMiddleware);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_CHAT_MESSAGES = 15;
const MAX_CONTENT_CHARS = 3000;

// ── System prompts (encurtados para economizar tokens) ────────────────

const SYSTEM_PROMPT = `Você é o AgroIA, assistente agrícola do Agrolote. Responda SEMPRE em português do Brasil, de forma clara e prática.

Orquídeas: considere gênero, substrato, rega, adubação, luz, pragas (cochinilha, ácaros, fungos).
Plantas: solo, clima, irrigação, pragas, calendário de plantio.
Indique ações concretas. Se não tiver certeza, diga honestamente. Nunca invente doses de defensivos sem contexto.

Não responda assuntos fora do agronegócio, orquídeas ou plantas.`;

const ANALYZE_SYSTEM_PROMPT = `Analise a foto e responda APENAS com JSON válido (sem texto fora).

EXEMPLO de resposta correta para uma orquídea:
{
  "resumo": "Orquídea Phalaenopsis com flores rosa e brancas, saudável.",
  "identificacao": {"especie": "Phalaenopsis (Orquídea Borboleta)", "confianca": "alta"},
  "saude": "saudavel",
  "problemas": [],
  "cuidados": ["Manter vaso com boa ventilação"],
  "rega": "Regar 2x por semana, substrato deve secar entre regas",
  "adubacao": "Adubo para orquídeas 1x por semana na fase de crescimento",
  "luminosidade": "Luz indireta forte, sem sol direto",
  "substrato": "Casca de pinus e esfagno"
}

REGRAS:
- identificacao.especie: SE você identificou a planta na foto, PREENCHA com o nome. Só use "Não identificada" se realmente não conseguir ver.
- identificacao.confianca: "alta" se tem certeza, "media" se quase certeza, "baixa" se duvidosa.
- Preencha TODOS os campos: resumo, identificacao, saude, problemas, cuidados, rega, adubacao, luminosidade, substrato.
- Se não for planta: especie "Não identificada", saude "atencao", problemas [], cuidados [], campos de cuidado vazios.`;

// ── Cache de análise (evita re-analisar mesma foto) ───────────────────

const analysisCache = new Map(); // hash → { result, ts }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function cacheKey(buffer, question) {
  return createHash("sha256")
    .update(buffer)
    .update(question || "")
    .digest("hex")
    .slice(0, 32);
}

function getCached(key) {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    analysisCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key, result) {
  if (analysisCache.size > 500) {
    // limpa entradas mais antigas
    const oldest = [...analysisCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < 100; i++) analysisCache.delete(oldest[i][0]);
  }
  analysisCache.set(key, { result, ts: Date.now() });
}

// ── Compressão de imagem (economia de ~70% tokens) ────────────────────

async function compressImage(buffer) {
  try {
    const compressed = await sharp(buffer)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();
    return compressed;
  } catch {
    // se falhar, usa original
    return buffer;
  }
}

// ── Uso diário ────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function resolveActivePlan(userId) {
  const sub = await (await col("subscriptions")).findOne({ user_id: userId });
  return sub?.status === "trial" ? sub.trial_plan : (sub?.plan || "free");
}

async function getUsage(userId) {
  const activePlan = await resolveActivePlan(userId);
  const features = getPlanFeatures(activePlan);
  const doc = await (await col("ai_usage")).findOne({ user_id: userId, date: today() });
  return {
    used: doc?.count || 0,
    limit: features.maxIaDia,
    plan: activePlan,
  };
}

async function checkAiLimit(userId) {
  const usage = await getUsage(userId);
  if (usage.limit === 0) {
    const e = new Error("Seu plano não inclui análises de IA. Faça upgrade para usar o AgroIA.");
    e.status = 403;
    e.payload = { limit: 0, current: usage.used, plan: usage.plan, upgrade: true };
    throw e;
  }
  if (usage.limit !== Infinity && usage.used >= usage.limit) {
    const e = new Error(`Limite diário de IA atingido (${usage.limit} por dia). Faça upgrade do seu plano.`);
    e.status = 403;
    e.payload = { limit: usage.limit, current: usage.used, plan: usage.plan, upgrade: true };
    throw e;
  }
  return usage;
}

async function incrUsage(userId) {
  await (await col("ai_usage")).updateOne(
    { user_id: userId, date: today() },
    { $inc: { count: 1 }, $setOnInsert: { created_at: new Date().toISOString() } },
    { upsert: true }
  );
}

function sendError(res, err) {
  const status = err?.status || 500;
  return res.status(status).json({ error: err?.message || "Erro interno", ...(err?.payload || {}) });
}

// ── GET /api/ai/usage ─────────────────────────────────────────────────

router.get("/usage", asyncHandler(async (req, res) => {
  try {
    res.json(await getUsage(req.user.uid));
  } catch (err) {
    sendError(res, err);
  }
}));

// ── POST /api/ai/chat ─────────────────────────────────────────────────

router.post("/chat", asyncHandler(async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Envie 'messages' como lista de mensagens." });
    }
    if (messages.length > MAX_CHAT_MESSAGES) {
      return res.status(400).json({ error: `Máximo de ${MAX_CHAT_MESSAGES} mensagens por conversa.` });
    }

    const clean = [];
    for (const m of messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) {
        return res.status(400).json({ error: "Papéis permitidos: 'user' e 'assistant'." });
      }
      if (typeof m.content !== "string" || !m.content.trim()) {
        return res.status(400).json({ error: "Cada mensagem precisa de 'content' não vazio." });
      }
      clean.push({ role: m.role, content: m.content.slice(0, MAX_CONTENT_CHARS) });
    }
    if (clean[clean.length - 1].role !== "user") {
      return res.status(400).json({ error: "A última mensagem deve ser do usuário." });
    }

    const usage = await checkAiLimit(req.user.uid);

    const { content, model } = await aiChat({
      system: SYSTEM_PROMPT,
      messages: clean,
      maxTokens: 600,
      temperature: 0.5,
    });

    await incrUsage(req.user.uid);
    res.json({
      reply: content,
      model,
      usage: { used: usage.used + 1, limit: usage.limit, plan: usage.plan },
    });
  } catch (err) {
    sendError(res, err);
  }
}));

// ── Multipart parser ──────────────────────────────────────────────────

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(delimiter, start);
    if (idx === -1) break;
    if (start > 0) {
      const part = buffer.slice(start, idx - 2);
      if (part.length > 0) parts.push(part);
    }
    start = idx + delimiter.length + 2;
  }
  return parts;
}

function parseMultipart(req, contentType) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error("Boundary do multipart ausente."));
    const boundary = boundaryMatch[1];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      try {
        const fullBuffer = Buffer.concat(chunks);
        const parts = splitBuffer(fullBuffer, Buffer.from(`--${boundary}`));
        const fields = {};

        for (const part of parts) {
          const str = part.toString("utf-8");
          const headerEnd = str.indexOf("\r\n\r\n");
          if (headerEnd === -1) continue;
          const headerSection = str.slice(0, headerEnd);
          const nameMatch = headerSection.match(/name="([^"]+)"/);
          const filenameMatch = headerSection.match(/filename="([^"]+)"/);
          const contentTypeMatch = headerSection.match(/Content-Type:\s*(.+)/i);
          if (!nameMatch) continue;

          const rawData = part.slice(Buffer.byteLength(str.slice(0, headerEnd + 4)));
          if (filenameMatch) {
            fields[nameMatch[1]] = {
              originalname: filenameMatch[1],
              mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
              buffer: rawData,
              size: rawData.length,
            };
          } else {
            fields[nameMatch[1]] = rawData.toString("utf-8").trim();
          }
        }
        resolve(fields);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ── POST /api/ai/analyze ──────────────────────────────────────────────

router.post("/analyze", asyncHandler(async (req, res) => {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return res.status(400).json({ error: "Use multipart/form-data com o campo 'photo'." });
    }

    const fields = await parseMultipart(req, contentType);
    const file = fields.photo;
    if (!file || !file.buffer?.length) {
      return res.status(400).json({ error: "Nenhuma imagem enviada. Use o campo 'photo'." });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: "Imagem excede o limite de 5MB." });
    }
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ error: `Tipo não permitido: ${file.mimetype}. Use JPEG, PNG ou WebP.` });
    }

    const question = typeof fields.question === "string" && fields.question.trim()
      ? fields.question.trim().slice(0, 500)
      : "";

    // Verifica cache antes de gastar tokens
    const cKey = cacheKey(file.buffer, question);
    const cached = getCached(cKey);
    if (cached) {
      const usage = await getUsage(req.user.uid);
      return res.json({
        ...cached,
        cached: true,
        usage,
      });
    }

    const usage = await checkAiLimit(req.user.uid);

    // Comprime imagem para economizar tokens
    const compressed = await compressImage(file.buffer);
    const imageBase64 = compressed.toString("base64");

    const userText = question
      ? `Analise esta foto. Pergunta do produtor: "${question}". Responda com o JSON.`
      : "Analise esta foto e responda com o JSON.";

    const { content, model } = await aiChat({
      system: ANALYZE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
      imageBase64,
      imageMime: "image/jpeg",
      maxTokens: 800,
      temperature: 0.3,
      json: true,
    });

    const analysis = parseAiJson(content) || {
      resumo: content.slice(0, 400),
      identificacao: { especie: "Não identificada", confianca: "baixa" },
      saude: "atencao",
      problemas: [],
      cuidados: [],
      rega: "",
      adubacao: "",
      luminosidade: "",
      substrato: "",
    };

    const result = { analysis, model };
    setCache(cKey, result);

    await incrUsage(req.user.uid);
    res.json({
      ...result,
      usage: { used: usage.used + 1, limit: usage.limit, plan: usage.plan },
    });
  } catch (err) {
    sendError(res, err);
  }
}));

// ── GET /api/ai/status ────────────────────────────────────────────────

router.get("/status", (_req, res) => {
  res.json({
    configured: !!geminiKey(),
    model: MODEL,
    optimizations: {
      imageCompression: "1024x1024 JPEG 80%",
      cache: "24h por hash de imagem",
      maxTokens: { chat: 600, analyze: 800 },
    },
  });
});

export default router;
