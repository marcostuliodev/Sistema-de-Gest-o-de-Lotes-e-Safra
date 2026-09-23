/**
 * Cliente Google Gemini — texto + visão (foto) num modelo só.
 *
 * Env vars:
 *   GEMINI_API_KEY — obrigatória (aistudio.google.com/apikey)
 *   GEMINI_MODEL   — opcional (padrão: gemini-2.0-flash)
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

export { MODEL };

export function geminiKey() {
  return process.env.GEMINI_API_KEY || "";
}

/**
 * Envia conversa ao Gemini.
 * @param {Object} opts
 * @param {string} opts.system        — prompt de sistema
 * @param {Array}  opts.messages      — [{role:"user"|"assistant", content:"..."}]
 * @param {string} opts.imageBase64   — opcional, base64 SEM prefixo data:
 * @param {string} opts.imageMime     — ex: "image/jpeg"
 * @param {number} opts.maxTokens
 * @param {number} opts.temperature
 * @param {boolean} opts.json         — força saída JSON
 * @returns {Promise<{content:string, model:string}>}
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

  // Monta contents: converte messages para formato Gemini
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // Se tem imagem, anexa na última mensagem do usuário
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
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
    ...(system
      ? { systemInstruction: { parts: [{ text: system }] } }
      : {}),
  };

  const url = `${BASE}/${MODEL}:generateContent?key=${key}`;
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
    throw err;
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || "").join("");
  return { content, model: MODEL };
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
