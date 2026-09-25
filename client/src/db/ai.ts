import { getActiveScope } from "./db";

export interface AiUsage {
  used: number;
  limit: number;
  plan: string;
}

export interface AiContextFlags {
  include_project?: boolean;
  include_location?: boolean;
  include_weather?: boolean;
}

export interface AiContextUsed {
  categories: string[];
  requested_categories?: string[];
  warnings?: string[];
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

export interface AiChatResult {
  reply: string;
  usage: AiUsage;
  context?: AiContextUsed;
}

export interface AiAnalyzeOptions extends AiContextFlags {
  photoId?: string;
  photo_id?: string;
  question?: string;
}

export interface AiAnalyzeResult {
  analysis: AiAnalysis;
  usage: AiUsage;
  context?: AiContextUsed;
}

function projectId(): string {
  const scope = getActiveScope();
  if (!scope) throw new Error("Projeto não selecionado");
  return scope.projectId;
}

function projectHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  headers.set("X-Project-Id", projectId());
  return headers;
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = projectHeaders(options.headers);
  if (options.body && !(typeof FormData !== "undefined" && options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...options, headers, credentials: "include" });
}

async function responseData(res: Response): Promise<Record<string, unknown>> {
  return res.json().catch(() => ({}));
}

function errorMessage(data: Record<string, unknown>, fallback: string): string {
  return typeof data.error === "string" && data.error ? data.error : fallback;
}

function contextFields(flags: AiContextFlags = {}): Required<AiContextFlags> {
  return {
    include_project: flags.include_project !== false,
    include_location: flags.include_location !== false,
    include_weather: flags.include_weather !== false,
  };
}

function contextUsed(value: unknown): AiContextUsed | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const categories = Array.isArray(data.categories)
    ? data.categories.filter((item): item is string => typeof item === "string")
    : [];
  const requested = Array.isArray(data.requested_categories)
    ? data.requested_categories.filter((item): item is string => typeof item === "string")
    : undefined;
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((item): item is string => typeof item === "string")
    : undefined;
  return { categories, ...(requested ? { requested_categories: requested } : {}), ...(warnings ? { warnings } : {}) };
}

function isFile(value: unknown): value is File {
  if (typeof File !== "undefined" && value instanceof File) return true;
  return !!value && typeof value === "object" && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
    && !("photoId" in value)
    && !("photo_id" in value);
}

function mergedOptions(...values: (AiAnalyzeOptions | string | undefined)[]): AiAnalyzeOptions {
  const options: AiAnalyzeOptions = {};
  for (const value of values) {
    if (typeof value === "string") {
      options.photo_id = value;
    } else if (value && typeof value === "object") {
      Object.assign(options, value);
    }
  }
  return options;
}

export async function fetchAiUsage(): Promise<AiUsage> {
  const res = await request("/api/ai/usage");
  const data = await responseData(res);
  if (!res.ok) throw new Error(errorMessage(data, "Erro na IA. Tente novamente."));
  return data as unknown as AiUsage;
}

export async function sendAiChat(
  messages: AiChatMessage[],
  flags: AiContextFlags = {},
): Promise<AiChatResult> {
  const res = await request("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages, ...contextFields(flags) }),
  });
  const data = await responseData(res);
  if (!res.ok) {
    const error = new Error(errorMessage(data, "Erro na IA. Tente novamente.")) as Error & {
      status?: number;
      upgrade?: boolean;
    };
    error.status = res.status;
    error.upgrade = data.upgrade === true;
    throw error;
  }
  return {
    reply: typeof data.reply === "string" ? data.reply : "",
    usage: data.usage as AiUsage,
    context: contextUsed(data.context),
  };
}

export async function analyzePhoto(file: File, question?: string, options?: AiAnalyzeOptions | string): Promise<AiAnalyzeResult>;
export async function analyzePhoto(file: File, options: AiAnalyzeOptions): Promise<AiAnalyzeResult>;
export async function analyzePhoto(options: AiAnalyzeOptions): Promise<AiAnalyzeResult>;
export async function analyzePhoto(
  fileOrOptions: File | AiAnalyzeOptions | null | undefined,
  questionOrOptions?: string | AiAnalyzeOptions,
  optionsOrPhotoId?: AiAnalyzeOptions | string,
): Promise<AiAnalyzeResult> {
  const file = isFile(fileOrOptions) ? fileOrOptions : null;
  const initialOptions: AiAnalyzeOptions | undefined = fileOrOptions
    && typeof fileOrOptions === "object"
    && !isFile(fileOrOptions)
    ? fileOrOptions
    : undefined;
  const options = mergedOptions(
    initialOptions,
    typeof questionOrOptions === "object" ? questionOrOptions : undefined,
    optionsOrPhotoId,
  );
  const question = typeof questionOrOptions === "string"
    ? questionOrOptions
    : typeof options.question === "string"
      ? options.question
      : "";
  const photoId = String(options.photoId || options.photo_id || "").trim();
  if (!file && !photoId) throw new Error("Envie uma imagem ou photoId.");

  const form = new FormData();
  if (file) form.append("photo", file);
  if (photoId) form.append("photo_id", photoId);
  if (question.trim()) form.append("question", question.trim());
  const flags = contextFields(options);
  form.append("include_project", String(flags.include_project));
  form.append("include_location", String(flags.include_location));
  form.append("include_weather", String(flags.include_weather));

  const res = await request("/api/ai/analyze", { method: "POST", body: form });
  const data = await responseData(res);
  if (!res.ok) {
    const error = new Error(errorMessage(data, "Erro ao analisar a imagem.")) as Error & {
      status?: number;
      upgrade?: boolean;
    };
    error.status = res.status;
    error.upgrade = data.upgrade === true;
    throw error;
  }
  return {
    analysis: data.analysis as AiAnalysis,
    usage: data.usage as AiUsage,
    context: contextUsed(data.context),
  };
}
