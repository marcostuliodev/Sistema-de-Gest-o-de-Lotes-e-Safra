/**
 * Cliente da API Groq (compatível com OpenAI Chat Completions).
 * Focado em análise de imagens e texto para orquídeas e plantações.
 *
 * Env vars:
 *   GROQ_API_KEY        — obrigatória (chave gsk_...)
 *   GROQ_MODEL_VISION   — modelo de visão (padrão: qwen/qwen3.6-27b)
 *   GROQ_MODEL_TEXT     — modelo de texto (padrão: llama-3.3-70b-versatile)
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const TEXT_MODEL = process.env.GROQ_MODEL_TEXT || "llama-3.3-70b-versatile";
export const VISION_MODEL = process.env.GROQ_MODEL_VISION || "qwen/qwen3.6-27b";

export function groqKey() {
  return process.env.GROQ_API_KEY || "";
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Chama a Groq e devolve o conteúdo textual da resposta.
 * @param {{messages: Array, model?: string, json?: boolean, maxTokens?: number, temperature?: number}} opts
 */
export async function groqChat({
  messages,
  model = TEXT_MODEL,
  json = false,
  maxTokens = 1200,
  temperature = 0.4,
}) {
  if (!groqKey()) {
    throw httpError(503, "IA não configurada. Defina a env var GROQ_API_KEY no servidor.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey()}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data?.error?.message || `Groq retornou ${res.status}`;
      if (res.status === 429) throw httpError(429, "Muitas requisições à IA. Aguarde um momento e tente novamente.");
      if (res.status === 401 || res.status === 403) throw httpError(503, "Credenciais da IA inválidas (GROQ_API_KEY).");
      if (res.status === 404) throw httpError(502, `Modelo de IA indisponível: ${model}`);
      throw httpError(502, `Erro na IA: ${msg}`);
    }

    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) throw httpError(502, "A IA retornou uma resposta vazia.");
    return { content, model: data.model || model };
  } catch (err) {
    if (err.name === "AbortError") throw httpError(504, "A IA demorou demais para responder. Tente novamente.");
    if (err.status) throw err;
    throw httpError(502, `Falha ao consultar a IA: ${err.message || "erro desconhecido"}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Extrai e parseia a resposta JSON da IA com fallback seguro. */
export function parseAiJson(content) {
  try {
    let text = String(content).trim();
    // Remove cercas de código ```json ... ``` se o modelo ignorar o JSON mode
    if (text.startsWith("```")) {
      text = text.replace(/^```(json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
