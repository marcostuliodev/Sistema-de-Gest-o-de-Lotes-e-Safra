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
 * - Limites de output: 2048 tokens para chat, 1200 para análise de imagem
 * - Cache de análise por hash de imagem (evita re-analisar mesma foto)
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "crypto";
import sharp from "sharp";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";
import { aiChat, parseAiJson, geminiKeys, geminiModels } from "../gemini.js";

const router = Router();
router.use(authMiddleware);

// O Vercel pode ter NODE_ENV development configurado; presence do runtime
// ainda exige os limites e a postura de produção.
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.VERCEL;

// VULN-006: rate limit por IP nas rotas de IA (independente de index.js)
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 30 : 200,
  message: { error: "Muitas requisições de IA, tente mais tarde" },
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(aiLimiter);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
// Teto do corpo multipart: 5MB (arquivo) + 50KB de margem p/ fields/boundary
const MULTIPART_BODY_LIMIT = MAX_IMAGE_BYTES + 50 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_CHAT_MESSAGES = 20; // alinhado com cliente (ia.tsx envia slice(-20))
const MAX_CONTENT_CHARS = 3000;

// ── System prompts (encurtados para economizar tokens) ────────────────

const SYSTEM_PROMPT = `Você é o AgroIA, assistente agrícola especializado do Agrolote, um sistema de gestão de lotes e safras.

## Sua identidade
- Nome: AgroIA
- Especialista em orquídeas e plantações em geral (hortaliças, frutas, flores, cultivo em vaso e campo)
- Responda SEMPRE em português do Brasil

## Como responder
- De forma clara, prática e objetiva
- Use parágrafos curtos e fáceis de ler
- Sempre que útil, indique ações concretas: o que fazer, quanto, com que frequência
- Se não tiver certeza, diga honestamente e sugira o que observar
- Nunca invente números de doses de defensivos sem contexto; quando citar dosagens, oriente a confirmar no rótulo do produto

## Conhecimento técnico
- **Orquídeas**: gênero (Phalaenopsis, Cattleya, Dendrobium, Oncidium, Vanda, Miltonia etc.), substrato, irrigação, adubação, luminosidade, umidade, fase de floração, pragas comuns (cochinilha, cochonilha, ácaros, fungos)
- **Plantações em geral**: solo, clima, irrigação, adubação, pragas e doenças, calendário de plantio, boas práticas agrícolas
- **Gestão agrícola**: plantios, lotes, colheitas, insumos, custos

## Limites
- Não responda a pedidos alheios ao agronegócio, orquídeas ou plantas
- Não forneça conselhos médicos, jurídicos ou financeiros não relacionados ao campo`;

const ANALYZE_SYSTEM_PROMPT = `Analise a foto e responda APENAS com JSON válido (sem texto fora).

EXEMPLO de resposta completa e detalhada:
{
  "resumo": "Orquídea Phalaenopsis com 5 flores rosa e brancas, folhas verdes sem manchas, raízes aéreas visíveis. Planta saudável em vaso plástico.",
  "identificacao": {"especie": "Phalaenopsis (Orquídea Borboleta)", "confianca": "alta"},
  "saude": "saudavel",
  "problemas": [],
  "cuidados": ["Manter vaso com boa ventilação", "Não regar sobre a raiz", "Remover haste seca após floração"],
  "rega": "Regar 2x por semana em verão, 1x por semana em inverno. O substrato deve secar entre regas.",
  "adubacao": "Adubo para orquídeas NPK 20-20-20 diluído 1/4 da dose, 1x por semana durante crescimento.",
  "luminosidade": "Luz indireta forte (janela leste ou oeste). Sem sol direto que queima as folhas.",
  "substrato": "Casca de pinus grosso + esfagno + perlite. Trocar a cada 2 anos."
}

REGRAS OBRIGATÓRIAS:
1. identificacao.especie: SE identificou a planta, PREENCHA com nome comum e científico. Só use "Não identificada" se realmente não conseguir ver a planta.
2. identificacao.confianca: "alta" se tem certeza, "media" se quase certeza, "baixa" se duvidosa.
3. TODOS os campos DEVEM ter conteúdo real e específico:
   - resumo: descreva o que VEU na foto (não genérico)
   - problemas: liste problemas visíveis OU array vazio [] se saudável
   - cuidados: pelo menos 2-3 ações práticas específicas
   - rega: frequência concreta (ex: "2x por semana")
   - adubacao: tipo e frequência (ex: "NPK 20-20-20, 1x por semana")
   - luminosidade: tipo de luz (ex: "indireta forte")
   - substrato: composição (ex: "casca de pinus + esfagno")
4. saude: "saudavel" | "atencao" | "doente" (baseado no que VEU)
5. NÃO deixe campos vazios ou com texto genérico. Seja específico e prático.

Se não for planta: especie "Não identificada", saude "atencao", problemas [], cuidados ["Não identificado como planta"], rega/adubacao/luminosidade/substrato com "Não aplicável".`;

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
  const { resolveEffectivePlan } = await import("../plans.js");
  const { plan } = await resolveEffectivePlan(userId);
  return plan;
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
  const usage = await getUsage(userId);
  const coll = await col("ai_usage");
  const date = today();
  const createdAt = new Date().toISOString();

  // Plano ilimitado: incrementa sem filtro de limite
  if (!Number.isFinite(usage.limit)) {
    await coll.updateOne(
      { user_id: userId, date },
      { $inc: { count: 1 }, $setOnInsert: { created_at: createdAt } },
      { upsert: true }
    );
    return usage;
  }

  // Garante o documento do dia (se não existir)
  await coll.updateOne(
    { user_id: userId, date },
    { $setOnInsert: { count: 0, created_at: createdAt } },
    { upsert: true }
  );

  // VULN-006: incremento atômico — só incrementa se abaixo do limite
  const result = await coll.updateOne(
    { user_id: userId, date, count: { $lt: usage.limit } },
    { $inc: { count: 1 } }
  );

  if (result.matchedCount === 0) {
    const e = new Error(`Limite diário de IA atingido (${usage.limit} por dia). Faça upgrade do seu plano.`);
    e.status = 429;
    e.payload = { limit: usage.limit, current: usage.used, plan: usage.plan, upgrade: true };
    throw e;
  }
  return usage;
}

function sendError(res, err) {
  const status = err?.status || 500;
  // Erros 5xx podem conter detalhes de infraestrutura; nunca são enviados ao cliente.
  const message = err?.publicMessage || (status < 500 ? err?.message : "Erro interno");
  return res.status(status).json({ error: message, ...(err?.payload || {}) });
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
      maxTokens: 2048,
      temperature: 0.7,
      operation: "text",
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

function parseMultipart(req, res, contentType) {
  return new Promise((resolve, reject) => {
    // VULN-004: aborta cedo se o Content-Length declarado já excede o limite
    const declaredLength = Number.parseInt(req.headers["content-length"] || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MULTIPART_BODY_LIMIT) {
      const err = new Error("Corpo da requisição excede o limite de 5MB.");
      err.status = 413;
      return reject(err);
    }

    const chunks = [];
    let receivedBytes = 0;
    let aborted = false;
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error("Boundary do multipart ausente."));
    const boundary = boundaryMatch[1];

    req.on("data", (chunk) => {
      if (aborted) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MULTIPART_BODY_LIMIT) {
        aborted = true;
        const err = new Error("Corpo da requisição excede o limite de 5MB.");
        err.status = 413;
        if (res && !res.headersSent) res.status(413).json({ error: err.message });
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
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

    const fields = await parseMultipart(req, res, contentType);
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
      maxTokens: 1200,
      temperature: 0.3,
      json: true,
      operation: "vision",
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
    if (res.headersSent) return;
    sendError(res, err);
  }
}));

// ── GET /api/ai/status ────────────────────────────────────────────────

router.get("/status", (_req, res) => {
  const keys = geminiKeys();
  const textModels = geminiModels();
  const visionModels = geminiModels({ vision: true });
  res.json({
    configured: keys.length > 0,
    keyCount: keys.length,
    model: textModels[0],
    visionModel: visionModels[0],
    fallbackModels: textModels.slice(1),
    optimizations: {
      imageCompression: "1024x1024 JPEG 80%",
      cache: "24h por hash de imagem",
      maxTokens: { chat: 2048, analyze: 1200 },
    },
  });
});

export default router;
