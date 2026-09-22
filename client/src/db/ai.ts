/**
 * Cliente da API de IA (AgroIA — Groq).
 */

export interface AiUsage {
  used: number;
  limit: number;
  plan: string;
}

export interface AiProblem {
  nome: string;
  severidade: "baixa" | "media" | "alta" | string;
  descricao: string;
}

export interface AiAnalysis {
  resumo?: string;
  identificacao?: { especie?: string; confianca?: string };
  saude?: "saudavel" | "atencao" | "doente" | string;
  problemas?: AiProblem[];
  cuidados?: string[];
  rega?: string;
  adubacao?: string;
  luminosidade?: string;
  substrato?: string;
}

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
}

async function errorOf(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return data.error || "Erro na IA. Tente novamente.";
}

export async function fetchAiUsage(): Promise<AiUsage> {
  const res = await request("/api/ai/usage");
  if (!res.ok) throw new Error(await errorOf(res));
  return res.json();
}

export async function sendAiChat(
  messages: AiChatMessage[]
): Promise<{ reply: string; usage: AiUsage }> {
  const res = await request("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Erro na IA. Tente novamente.") as Error & {
      status?: number;
      upgrade?: boolean;
    };
    err.status = res.status;
    err.upgrade = !!data.upgrade;
    throw err;
  }
  return { reply: data.reply, usage: data.usage };
}

export async function analyzePhoto(
  file: File,
  question?: string
): Promise<{ analysis: AiAnalysis; usage: AiUsage }> {
  const form = new FormData();
  form.append("photo", file);
  if (question?.trim()) form.append("question", question.trim());

  const res = await request("/api/ai/analyze", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Erro ao analisar a imagem.") as Error & {
      status?: number;
      upgrade?: boolean;
    };
    err.status = res.status;
    err.upgrade = !!data.upgrade;
    throw err;
  }
  return { analysis: data.analysis, usage: data.usage };
}
