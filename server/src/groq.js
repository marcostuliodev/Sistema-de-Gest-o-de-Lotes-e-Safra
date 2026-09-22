/**
 * Cliente da API Groq (compatível com OpenAI Chat Completions).
 * Focado em análise de imagens e texto para orquídeas e plantações.
 * Usa UM ÚNICO modelo Qwen para ambas as funções (visão e texto).
 *
 * Env var obrigatória:
 *   GROQ_API_KEY        — chave gsk_... (console.groq.com/keys)
 *
 * Opcional (para trocar de modelo):
 *   GROQ_MODEL          — modelo a usar (padrão: qwen/qwen3.6-27b). Se não definida,
 *                       usa-se qwen/qwen3.6-27b para ambas as funções.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

export { MODEL };

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
 * Usa sempre o modelo MODEL (padrão: qwen/qwen3.6-27b) para ambos os casos.
 * @param {{messages: Array, json?: boolean, maxTokens?: number, temperature?: number}} opts
 */
export async function groqChat({
  messages,
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
        model: MODEL,
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
      throw httpError(502, `Erro na IA: ${msg}`);
    }

    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) throw httpError(502, "A IA retornou uma resposta vazia.");
    return { content, model: data.model || MODEL };
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