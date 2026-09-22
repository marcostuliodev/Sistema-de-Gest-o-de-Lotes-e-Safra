const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";

export { TEXT_MODEL, VISION_MODEL };

export function groqKey() { return process.env.GROQ_API_KEY || ""; }

export async function groqChat({ model, messages, json = false, maxTokens = 1000, temperature = 0.7 }) {
  const key = groqKey();
  if (!key) throw new Error("GROQ_API_KEY não configurada");
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Groq API error ${res.status}: ${err}`); }
  const data = await res.json();
  return { content: data.choices[0]?.message?.content || "", model };
}

export function parseAiJson(content) {
  try {
    const s = content.indexOf("{");
    const e = content.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return null;
    return JSON.parse(content.slice(s, e + 1));
  } catch { return null; }
}
