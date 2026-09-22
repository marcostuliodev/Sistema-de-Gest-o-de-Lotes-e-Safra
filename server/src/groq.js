/**
 * Cliente da API Groq (compatível com OpenAI Chat Completions).
 * Focado em análise de imagens e texto para orquídeas e plantações.
 *
 * Env vars:
 *   GROQ_API_KEY        — obrigatória (chave gsk_...)
 *   GROQ_TEXT_MODEL     — modelo de texto (padrão: openai/gpt-oss-120b)
 *   GROQ_VISION_MODEL   — modelo de visão (padrão: qwen/qwen3.6-27b)
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";

export { TEXT_MODEL, VISION_MODEL };

export function groqKey() {
  return process.env.GROQ_API_KEY || "";
}