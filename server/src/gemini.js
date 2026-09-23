/**
 * Cliente Google Gemini — texto e visão com rotação de chaves e fallbacks.
 *
 * Variáveis de ambiente:
 *   GEMINI_API_KEY       — primeira chave (obrigatória)
 *   GEMINI_API_KEY_2..10 — chaves adicionais (opcionais)
 *   GEMINI_MODEL         — modelo principal de texto (opcional)
 *   GEMINI_VISION_MODEL  — modelo principal de análise de imagem (opcional)
 *   GEMINI_MODELS        — lista de fallbacks separada por vírgula (opcional)
 *
 * Estratégia:
 * - Round-robin entre chaves sadias, com failover para outra chave no mesmo modelo.
 * - Cooldown local por modelo/chave após 429, 5xx, timeout ou resposta vazia.
 * - Modelos são tentados em sequência quando indisponíveis (404/400/413).
 * - Prazos globais mantêm a função abaixo do limite de 60s da Vercel.
 *
 * As cotas do Gemini são avaliadas por projeto GCP. Várias chaves do mesmo
 * projeto não aumentam a cota; projetos distintos são necessários para
 * aumentar a capacidade.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TEXT_DEFAULT_MODEL = "gemini-3-flash-preview";

const DEFAULT_FALLBACK_MODELS = Object.freeze([
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
]);

const REQUEST_LIMITS = Object.freeze({
  text: { callTimeoutMs: 15_000, budgetMs: 32_000, maxCalls: 6 },
  // Imagens são mais lentas: a visão medida levou ~26s. O budget deixa
  // margem para cold start e para o processador antes do limite de 60s.
  vision: { callTimeoutMs: 30_000, budgetMs: 42_000, maxCalls: 3 },
});

const RATE_LIMIT_COOLDOWN_MS = 30_000;
const TIMEOUT_COOLDOWN_MS = 60_000;

const configuredTextModel = process.env.GEMINI_MODEL || TEXT_DEFAULT_MODEL;
const configuredVisionModel = process.env.GEMINI_VISION_MODEL || configuredTextModel;

export const MODEL = configuredTextModel;

function safeModel(value) {
  return typeof value === "string" && /^gemini-[a-z0-9._-]+$/i.test(value.trim());
}

function uniqueModels(values) {
  return [...new Set(values.filter(safeModel).map((value) => value.trim()))];
}

/** Lista de modelos preference customizável, sem expor valores sensíveis. */
export function geminiModels({ vision = false } = {}) {
  const primary = vision ? configuredVisionModel : configuredTextModel;
  const configured = typeof process.env.GEMINI_MODELS === "string"
    ? process.env.GEMINI_MODELS.split(",").map((value) => value.trim())
    : [];

  return uniqueModels([primary, ...configured, ...DEFAULT_FALLBACK_MODELS]);
}

/** Todas as chaves configuradas. A ordenação é preservada e duplicatas são removidas. */
export function geminiKeys() {
  const keys = [];
  const primary = process.env.GEMINI_API_KEY;
  if (typeof primary === "string" && primary.trim()) keys.push(primary.trim());

  for (let index = 2; index <= 10; index++) {
    const value = process.env[`GEMINI_API_KEY_${index}`];
    if (typeof value === "string" && value.trim()) keys.push(value.trim());
  }

  return [...new Set(keys)];
}

/** Mantido para compatibilidade com integrações que consultam a chave principal. */
export function geminiKey() {
  return geminiKeys()[0] || "";
}

// Estado local por instância. Em serverless, um cold start começa vazio.
const keyState = new Map();
let roundRobinIndex = 0;
let lastGoodKey = null;

function stateKey(model, key) {
  return `${model}\u0000${key}`;
}

function stateFor(model, key) {
  const id = stateKey(model, key);
  if (!keyState.has(id)) keyState.set(id, { cooldownUntil: 0, aborts: 0, disabled: false });
  return keyState.get(id);
}

function isHealthy(model, key) {
  const state = stateFor(model, key);
  return !state.disabled && state.cooldownUntil <= Date.now();
}

function markFailure(model, key, reason) {
  const state = stateFor(model, key);
  if (reason === "auth") {
    state.disabled = true;
    return;
  }
  if (reason === "timeout") {
    state.aborts += 1;
    state.cooldownUntil = Date.now() + TIMEOUT_COOLDOWN_MS * Math.min(state.aborts, 3);
    return;
  }
  state.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
}

function markSuccess(model, key) {
  const state = stateFor(model, key);
  state.cooldownUntil = 0;
  state.aborts = 0;
  lastGoodKey = key;
}

/**
 * Distribui a carga entre chaves saudáveis. Se todas estiverem em cooldown,
 * usa apenas uma última chave comprovadamente sadia; nunca tenta uma chave já
 * excluída da request atual.
 */
function pickKey(keys, model, failedKeys) {
  const healthy = keys.filter((key) => isHealthy(model, key) && !failedKeys.has(key));
  if (healthy.length > 0) {
    const key = healthy[roundRobinIndex % healthy.length];
    roundRobinIndex = (roundRobinIndex + 1) % healthy.length;
    return key;
  }

  if (lastGoodKey && healthy.length === 0 && isHealthy(model, lastGoodKey) && !failedKeys.has(lastGoodKey)) {
    return lastGoodKey;
  }

  return null;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error?.code === "ABORT_ERR";
}

async function callModel(model, key, body, timeoutMs) {
  const response = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Gemini request failed");
    error.status = response.status;
    throw error;
  }

  const content = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("");

  if (!content.trim()) {
    const error = new Error("Gemini returned an empty response");
    error.status = 502;
    throw error;
  }

  return { content, model };
}

function stripUnsupportedConfig(body) {
  const generationConfig = { ...(body.generationConfig || {}) };
  delete generationConfig.thinkingConfig;
  return { ...body, generationConfig };
}

/**
 * Envia uma solicitação ao Gemini, alternando chaves e modelos conforme o erro.
 * operation = "text" | "vision".
 */
export async function aiChat({
  system,
  messages,
  imageBase64,
  imageMime = "image/jpeg",
  maxTokens = 800,
  temperature = 0.5,
  json = false,
  operation = imageBase64 ? "vision" : "text",
} = {}) {
  const keys = geminiKeys();
  if (keys.length === 0) {
    const error = new Error("GEMINI_API_KEY não configurada");
    error.status = 503;
    throw error;
  }

  const mode = operation === "vision" ? "vision" : "text";
  const limits = REQUEST_LIMITS[mode];
  const startedAt = Date.now();
  const deadline = startedAt + limits.budgetMs;

  const contents = messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  if (imageBase64) {
    const lastUserMessage = [...contents].reverse().find((message) => message.role === "user");
    lastUserMessage?.parts.push({
      inline_data: { mime_type: imageMime, data: imageBase64 },
    });
  }

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  const tried = [];
  let lastStatus = null;
  let totalCalls = 0;

  for (const model of geminiModels({ vision: mode === "vision" })) {
    if (Date.now() >= deadline || totalCalls >= limits.maxCalls) break;

    const failedKeys = new Set();
    let bodyToTry = body;
    let configWasStripped = false;

    // +1 permite uma tentativa extra apenas para remover thinkingConfig.
    for (let attempt = 0; attempt <= keys.length; attempt++) {
      if (Date.now() >= deadline || totalCalls >= limits.maxCalls) break;

      const key = pickKey(keys, model, failedKeys);
      if (!key) break;

      totalCalls++;
      try {
        const result = await callModel(model, key, bodyToTry, limits.callTimeoutMs);
        markSuccess(model, key);
        return result;
      } catch (error) {
        const timedOut = isAbortError(error);
        const status = timedOut ? 0 : Number(error.status) || 0;
        lastStatus = status;
        const keyIndex = keys.indexOf(key) + 1;
        tried.push(`${model}:k${keyIndex}:${timedOut ? "timeout" : status || "network"}`);

        // Alguns modelos rejeitam thinkingConfig; uma única remoção e nova tentativa.
        if (status === 400 && !configWasStripped && body.generationConfig?.thinkingConfig) {
          bodyToTry = stripUnsupportedConfig(body);
          configWasStripped = true;
          continue;
        }

        // Erros do modelo ou do pedido: próximo modelo, sem repetir outra chave.
        if (status === 404 || status === 400 || status === 413) break;

        failedKeys.add(key);
        if (status === 401 || status === 403) markFailure(model, key, "auth");
        else if (timedOut) markFailure(model, key, "timeout");
        else markFailure(model, key, "rate");
      }
    }
  }

  const elapsed = Date.now() - startedAt;
  const error = new Error("A IA está temporariamente indisponível. Tente novamente em alguns instantes.");
  error.status = 503;
  error.publicMessage = elapsed >= limits.budgetMs - 250
    ? "A IA demorou para responder. Tente novamente em alguns instantes."
    : "A IA está temporariamente indisponível. Tente novamente em alguns instantes.";

  // Não registra conteúdo da resposta nem chaves. Apenas o diagnóstico seguro.
  console.warn("[gemini] request failed", {
    operation: mode,
    elapsedMs: elapsed,
    calls: totalCalls,
    lastStatus,
    tried,
  });
  throw error;
}

/** Extrai o primeiro objeto JSON de uma resposta possivelmente acompanhada de texto. */
export function parseAiJson(content) {
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}
