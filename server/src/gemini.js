/**
 * Cliente Google Gemini — texto + visão (foto) num modelo só.
 *
 * Env vars:
 *   GEMINI_API_KEY — obrigatória (aistudio.google.com/apikey)
 *   GEMINI_MODEL   — opcional (padrão: gemini-3.6-flash)
 *
 * Estratégia anti-erro:
 *   1. Tenta o modelo primário (gemini-3.6-flash)
 *   2. Se 503/429, espera e tenta de novo (retry)
 *   3. Se falhar de novo, cai para modelos fallback automaticamente
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// Modelos fallback (tentados em ordem se o primário falhar).
// NÃO incluir gemini-2.0-flash — API retorna 404 "no longer available".
const FALLBACK_MODELS = [
  MODEL,
  "gemini-2.5-flash",
  "gemini-2.5-pro",
].filter((m, i, a) => a.indexOf(m) === i); // remove duplicados

const MAX_RETRIES = 2;
const RETRY_DELAY = 1500; // 1.5s entre retries

export { MODEL };

export function geminiKey() {
  return process.env.GEMINI_API_KEY || "";
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
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    const err = new Error(`Gemini API error ${res.status}: ${msg}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status === 503;
    throw err;
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || "").join("");
  return { content, model };
}

/**
 * Envia conversa ao Gemini com retry + fallback automático.
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
  const key = geminiKey();
  if (!key) throw new Error("GEMINI_API_KEY não configurada");

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

  // Tenta cada modelo com retries
  let lastErr;
  for (const model of FALLBACK_MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callModel(model, key, body);
      } catch (err) {
        lastErr = err;
        // 404 = modelo indisponível → tenta o próximo fallback (não retries)
        // 400/413 etc = request inválido neste modelo → próximo fallback
        // 429/503 = rate limit → retry com backoff
        const tryNextModel =
          err.status === 404 ||
          err.status === 400 ||
          err.status === 413 ||
          (!err.retryable && err.status !== 429 && err.status !== 503);
        if (tryNextModel) break;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY * (attempt + 1));
        }
      }
    }
    // Modelo falhou, tenta o próximo fallback
  }

  throw lastErr;
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
