/**
 * Cliente Google Gemini — texto + visão (foto) num modelo só.
 *
 * Env vars:
 *   GEMINI_API_KEY    — chave 1 (obrigatória; aistudio.google.com/apikey)
 *   GEMINI_API_KEY_2.._5 — chaves adicionais (opcional; rotação round-robin)
 *   GEMINI_MODEL      — opcional (padrão: gemini-3.5-flash-lite)
 *
 * Estratégia anti-erro / anti-timeout:
 *   1. Modelo primário vivo (gemini-3.5-flash-lite — 1-4s em produção)
 *   2. Timeout por call (8s) + prazo global da request (~18s) — SEMPRE
 *      responde JSON antes do maxDuration:30 do Vercel (504)
 *   3. Rotação de chaves: round-robin + failover imediato em 429/401
 *   4. Fallback de modelos se o modelo estiver indisponível (404)
 *
 * IMPORTANTE (5 chaves): a cota RPM/TPM do Gemini é por PROJETO GCP,
 * não por API key. Chaves do MESMO projeto não multiplicam a cota —
 * crie chaves em projetos GCP distintos para ganho real de throughput.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Primário: modelo comprovadamente vivo e rápido em produção (~1-4s).
// gemini-3.6-flash morria/retragava e estourava o budget de 30s → 504.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// Modelos fallback (tentados em ordem se o primário falhar).
// NÃO incluir gemini-2.0-flash, gemini-2.5-pro nem gemini-2.5-flash-lite —
// a API retorna 404 "no longer available to new users" e sugere 3.x.
const FALLBACK_MODELS = [
  MODEL,
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-preview",
].filter((m, i, a) => a.indexOf(m) === i); // remove duplicados

const MAX_RETRIES = 1; // tentativas extras por modelo (total = MAX_RETRIES+1)
const RETRY_DELAY = 1000; // 1s entre retries de último recurso
const CALL_TIMEOUT_MS = 8_000; // timeout por call ao Gemini
const GLOBAL_BUDGET_MS = 18_000; // prazo total da cadeia (Vercel mata aos 30s)
const KEY_COOLDOWN_MS = 30_000; // cooldown da chave após 429
const MAX_TOTAL_CALLS = 15; // teto absoluto de calls por request

export { MODEL };

/**
 * Carrega todas as chaves Gemini configuradas (round-robin).
 * Formato: GEMINI_API_KEY (1), GEMINI_API_KEY_2.._10 (extras).
 */
export function geminiKeys() {
  const keys = [];
  const k1 = process.env.GEMINI_API_KEY;
  if (k1 && k1.trim()) keys.push(k1.trim());
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  // Remove duplicatas preservando ordem
  return [...new Set(keys)];
}

/** Compat: chave primária (primeira). Usada pelo /api/ai/status. */
export function geminiKey() {
  return geminiKeys()[0] || "";
}

// ── Estado de saúde das chaves (in-memory, por instância serverless) ──
const keyState = new Map(); // key → { cooldownUntil: number, disabled?: boolean }
let rrIndex = 0; // índice round-robin

function markCooldown(key) {
  const s = keyState.get(key) || {};
  s.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
  keyState.set(key, s);
}

function markDisabled(key, reason) {
  const s = keyState.get(key) || {};
  s.disabled = true;
  s.reason = reason;
  keyState.set(key, s);
}

function isHealthy(key) {
  const s = keyState.get(key);
  if (!s) return true;
  if (s.disabled) return false;
  if (s.cooldownUntil && Date.now() < s.cooldownUntil) return false;
  return true;
}

/**
 * Escolhe a próxima chave saudável (round-robin).
 * @param {string[]} keys - todas as chaves
 * @param {Set<string>} [exclude] - chaves a evitar nesta request (ex.: já falharam)
 * @returns {string|null}
 */
function pickKey(keys, exclude) {
  const healthy = keys.filter((k) => isHealthy(k) && !(exclude && exclude.has(k)));
  if (healthy.length > 0) {
    const key = healthy[rrIndex % healthy.length];
    rrIndex = (rrIndex + 1) % Math.max(healthy.length, 1);
    return key;
  }
  // Todas em cooldown/disable → tenta qualquer não-excluída (último recurso)
  const any = keys.filter((k) => !(exclude && exclude.has(k)));
  if (any.length > 0) {
    const key = any[rrIndex % any.length];
    rrIndex = (rrIndex + 1) % Math.max(any.length, 1);
    return key;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callModel(model, key, body) {
  const url = `${BASE}/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // FIX (bug IA): timeout por call — um fetch pendurado matava os 30s do Vercel.
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    const err = new Error(`Gemini API error ${res.status}: ${msg}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status === 503;
    err.body = data;
    throw err;
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || "").join("");
  return { content, model };
}

/** Alguns modelos rejeitam thinkingConfig/400 — remove e tenta de novo. */
function stripUnsupportedConfig(body) {
  const g = { ...(body.generationConfig || {}) };
  delete g.thinkingConfig;
  return { ...body, generationConfig: g };
}

/**
 * Envia conversa ao Gemini com:
 * - rotação de chaves (round-robin + failover 429/401)
 * - fallback de modelos
 * - prazo global para nunca estourar o maxDuration do Vercel.
 */
export async function aiChat({
  system,
  messages,
  imageBase64,
  imageMime = "image/jpeg",
  maxTokens = 800,
  temperature = 0.5,
  json = false,
} = {}) {
  const keys = geminiKeys();
  if (keys.length === 0) throw new Error("GEMINI_API_KEY não configurada");

  const startedAt = Date.now();
  const deadline = startedAt + GLOBAL_BUDGET_MS;

  // Monta contents no formato Gemini
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  if (imageBase64) {
    const lastUser = [...contents].reverse().find((c) => c.role === "user");
    if (lastUser) {
      lastUser.parts.push({
        inline_data: { mime_type: imageMime, data: imageBase64 },
      });
    }
  }

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 }, // desativa thinking (economiza tokens)
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  // Chaves que já falharam NESTA request (evita loop na mesma)
  const triedKeys = new Set();
  const tried = [];
  let lastErr;
  let totalCalls = 0;
  let allKeysDisabled = false;

  // Modelo-externo × chave-interno: 404 = problema do modelo (pula modelo),
  // 429/401 = problema da chave (troca chave, mesmo modelo).
  for (const model of FALLBACK_MODELS) {
    if (Date.now() >= deadline || totalCalls >= MAX_TOTAL_CALLS) break;
    if (allKeysDisabled) break;

    let bodyTry = body;
    let stripped = false;
    let keyHops = 0; // trocas de chave neste modelo (evita loop infinito)
    const maxKeyHops = keys.length; // no máximo 1 volta pelas chaves

    for (let attempt = 0; attempt <= MAX_RETRIES + 1; attempt++) {
      if (Date.now() >= deadline || totalCalls >= MAX_TOTAL_CALLS) break;

      // Escolhe chave a cada tentativa (round-robin / pula cooldown)
      let key = pickKey(keys, triedKeys);
      if (!key) {
        // Todas as chaves excluídas nesta request → limpa e tenta de novo
        triedKeys.clear();
        key = pickKey(keys);
      }
      if (!key) break;

      totalCalls++;
      try {
        return await callModel(model, key, bodyTry);
      } catch (err) {
        lastErr = err;
        const keyIdx = keys.indexOf(key) + 1;
        tried.push(`${model}:k${keyIdx}:${err.status ?? "net"}`);

        // AbortError/timeout da rede → trata como retryable (não é status HTTP)
        const isAbort = err.name === "AbortError" || err.name === "TimeoutError";
        const status = isAbort ? 0 : err.status;

        // 400 com thinkingConfig → remove config e tenta o MESMO modelo
        if (!stripped && status === 400) {
          bodyTry = stripUnsupportedConfig(body);
          stripped = true;
          attempt = -1;
          continue;
        }

        // ── Problema da CHAVE → troca chave, mesmo modelo, sem sleep ──
        // 429: rate limit desta chave/project → cooldown + próxima chave
        // 401/403: chave inválida → disable permanente (instância)
        const keyProblem = status === 429 || status === 401 || status === 403 || isAbort;
        if (keyProblem) {
          if (status === 401 || status === 403) {
            markDisabled(key, `http_${status}`);
          } else if (status === 429) {
            markCooldown(key);
          } else {
            // timeout/rede: cooldown curto
            const s = keyState.get(key) || {};
            s.cooldownUntil = Date.now() + 5_000;
            keyState.set(key, s);
          }
          triedKeys.add(key);

          const next = pickKey(keys, triedKeys);
          if (next && keyHops < maxKeyHops) {
            keyHops++;
            attempt = -1; // troca de chave não conta como retry do modelo
            continue; // MESMO modelo, NOVA chave, SEM sleep
          }
          // Sem chave livre → sai para o próximo modelo
          if (keys.every((k) => !isHealthy(k) && triedKeys.has(k))) {
            allKeysDisabled = keys.every((k) => {
              const s = keyState.get(k);
              return s && s.disabled;
            });
          }
          break;
        }

        // ── Problema do MODELO → próximo fallback (sem retry) ──
        // 404 / 400 residual / 413 / erros não-retryable
        const tryNextModel =
          status === 404 ||
          (status === 400 && stripped) ||
          status === 413 ||
          (!err.retryable && !isAbort);
        if (tryNextModel) break;

        // 503 etc retryable → backoff curto e retry (último recurso)
        if (attempt < MAX_RETRIES) {
          const wait = RETRY_DELAY * (attempt + 1);
          if (Date.now() + wait >= deadline) break; // não estoura o budget
          await sleep(wait);
        }
      }
    }
    // Modelo falhou, tenta o próximo fallback
  }

  if (allKeysDisabled && keys.length > 1) {
    const e = new Error("Todas as chaves Gemini estão indisponíveis. Verifique as env vars GEMINI_API_KEY_*.");
    e.status = 502;
    throw e;
  }

  if (lastErr) {
    const elapsed = Date.now() - startedAt;
    const detail = `${lastErr.message || lastErr} [tried: ${tried.join(", ")} | ${elapsed}ms | ${totalCalls} calls]`;
    // Timeout global → erro amigável em vez de estourar o Vercel
    if (elapsed >= GLOBAL_BUDGET_MS - 100) {
      const e = new Error("IA demorou para responder. Tente novamente.");
      e.status = 504;
      e.original = detail;
      throw e;
    }
    // NÃO atribuir lastErr.message — Error.message é getter-only em alguns runtimes
    const e = new Error(detail);
    e.status = lastErr.status || 500;
    e.retryable = lastErr.retryable;
    e.payload = lastErr.payload;
    throw e;
  }
  throw new Error("Falha na IA");
}

/**
 * Extrai JSON válido de uma resposta (mesmo com texto ao redor).
 */
export function parseAiJson(content) {
  try {
    const s = content.indexOf("{");
    const e = content.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return null;
    return JSON.parse(content.slice(s, e + 1));
  } catch {
    return null;
  }
}
