/**
 * Assistente de IA (Groq) — orquídeas e plantações.
 *
 * POST /api/ai/chat     — conversa em texto (histórico do cliente)
 * POST /api/ai/analyze  — análise de imagem (multipart: campo "photo")
 * GET  /api/ai/usage    — uso diário do usuário
 *
 * Limite diário por plano (features.maxIaDia), controlado na collection ai_usage.
 */

import { Router } from "express";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { getPlanFeatures } from "../plans.js";
import { groqChat, parseAiJson, groqKey, MODEL } from "../groq.js";

const router = Router();
router.use(authMiddleware);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_CHAT_MESSAGES = 20;
const MAX_CONTENT_CHARS = 4000;

const SYSTEM_PROMPT = `Você é o AgroIA, assistente agrícola do Agrolote, especialista em orquídeas e plantações em geral (hortaliças, frutas, flores, cultivo em vaso e campo).

Regras:
- Responda SEMPRE em português do Brasil, de forma clara e prática.
- Para orquídeas: considere gênero (Phalaenopsis, Cattleya, Dendrobium, Oncidium, Vanda, Miltonia etc.), substrato, irrigação, adubação, luminosidade, umidade, fase de floração e pragas comuns (cochinilha, cochonilha, ácaros, fungos).
- Para plantações em geral: considere solo, clima, irrigação, adubação, pragas e doenças, calendário de plantio e boas práticas.
- Sempre que útil, indique ações concretas (o que fazer, quanto, com que frequência).
- Se não tiver certeza, diga honestamente e sugira o que observar.
- Nunca invente números de doses de defensivos sem contexto; quando citar dosagens, indique para o produtor confirmar no rótulo do produto.
- Não responda a pedidos alheios ao agronegócio, orquídeas ou plantas.`;

const ANALYZE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Você receberá uma foto de uma planta/orquídeas e DEVE responder APENAS com um objeto JSON válido (sem texto fora do JSON) com exatamente esta estrutura:
{
  "resumo": "análise objetiva da imagem em 1-3 frases",
  "identificacao": {
    "especie": "nome comum e científico se possível, ou 'Não identificada'",
    "confianca": "alta" | "media" | "baixa"
  },
  "saude": "saudavel" | "atencao" | "doente",
  "problemas": [
    { "nome": "ex: Mancha fúngica", "severidade": "baixa" | "media" | "alta", "descricao": "o que foi observado" }
  ],
  "cuidados": ["ação prática 1", "ação prática 2"],
  "rega": "orientação de rega específica",
  "adubacao": "orientação de adubação",
  "luminosidade": "orientação de luz",
  "substrato": "orientação de substrato/vaso (aplica-se)"
}
Se a imagem não for de uma planta, retorne o mesmo JSON com resumo explicando isso, especie "Não identificada", saude "atencao", problemas [] e listas vazias.`;

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

    const { content, model } = await groqChat({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...clean],
      model: MODEL,
      maxTokens: 1200,
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

// ── Multipart parser (mesmo padrão do photos.js) ──────────────────────

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

    const usage = await checkAiLimit(req.user.uid);

    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
    const userText = question
      ? `Analise esta foto de planta/orquídea considerando esta pergunta do produtor: "${question}". Responda com o JSON solicitado.`
      : "Analise esta foto de planta/orquídea e responda com o JSON solicitado.";

    const { content, model } = await groqChat({
      model: MODEL,
      json: true,
      maxTokens: 1500,
      temperature: 0.3,
      messages: [
        { role: "system", content: ANALYZE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const analysis = parseAiJson(content) || {
      resumo: content.slice(0, 600),
      identificacao: { especie: "Não identificada", confianca: "baixa" },
      saude: "atencao",
      problemas: [],
      cuidados: [],
      rega: "",
      adubacao: "",
      luminosidade: "",
      substrato: "",
    };

    await incrUsage(req.user.uid);
    res.json({
      analysis,
      model,
      usage: { used: usage.used + 1, limit: usage.limit, plan: usage.plan },
    });
  } catch (err) {
    sendError(res, err);
  }
}));

// ── GET /api/ai/models — apenas para diagnóstico de configuração ──────

router.get("/status", (_req, res) => {
  res.json({
    configured: !!groqKey(),
    model: MODEL,
  });
});

export default router;
