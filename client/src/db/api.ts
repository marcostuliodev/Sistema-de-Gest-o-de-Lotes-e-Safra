import type { DashboardData, EntityName, PerformanceRow, Snapshot, SyncOp } from "./types";

export interface AuthSession {
  token: string;
  user: { id: number; name: string; email: string; email_verified: boolean };
}

const USER_KEY = "agrolote_user";

// O token JWT NÃO é mais persistido no localStorage (inacessível via JS após a
// migração para cookie HttpOnly). Mantemos apenas os dados do usuário para a UI.
export function getSession(): AuthSession | null {
  const rawUser = localStorage.getItem(USER_KEY);
  if (!rawUser) return null;
  try {
    return { token: "", user: JSON.parse(rawUser) };
  } catch {
    return null;
  }
}

export function setSession(s: AuthSession | null) {
  if (s) {
    localStorage.setItem(USER_KEY, JSON.stringify(s.user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers as Record<string, string>) };
  // Autenticação via cookie HttpOnly (enviado automaticamente pelo navegador).
  const res = await fetch(path, { ...options, headers, credentials: "include" });
  const isSyncRequest = path === "/api/sync";
  if (res.status === 401 && !path.includes("/auth/login")) {
    if (isSyncRequest) {
      // A sessão local pode continuar válida, mas o cookie HttpOnly expirou.
      // Limpa somente a sessão exibida; o IndexedDB/outbox fica preservado.
      setSession(null);
      window.dispatchEvent(new CustomEvent("agrolote:reauth-required"));
    } else {
      setSession(null);
      window.dispatchEvent(new CustomEvent("agrolote:logout"));
    }
  }
  return res;
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Falha no login");
  setSession(data);
  return data;
}

export async function register(name: string, email: string, password: string): Promise<AuthSession> {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Falha no cadastro");
  setSession(data);
  return data;
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
}

export async function resendVerification(email: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/auth/resend-verification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    credentials: "include",
  });
  return res.json();
}

export async function verifyEmail(token: string): Promise<{ ok: boolean; message: string; error?: string }> {
  const res = await fetch("/api/auth/verify-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erro ao verificar e-mail");
  return data;
}

export interface SyncResult {
  snapshot: Snapshot;
  serverTime: string;
  appliedOpIndexes?: number[];
  failedOps?: { index: number; entity: string | null; action: string | null; code: string }[];
}

export async function pushSync(ops: SyncOp[]): Promise<SyncResult | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await request("/api/sync", {
      method: "POST",
      body: JSON.stringify({ ops }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const error = new Error(data.error || "Falha na sincronização") as Error & {
        status?: number;
        code?: string;
      };
      error.status = res.status;
      error.code = data.code;
      throw error;
    }
    return res.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchReports() {
  const res = await request("/api/reports/dashboard");
  if (!res.ok) throw new Error("Erro ao carregar dashboard");
  return res.json() as Promise<DashboardData>;
}

export async function fetchPerformance() {
  const res = await request("/api/reports/performance");
  if (!res.ok) throw new Error("Erro ao carregar relatório");
  return res.json() as Promise<PerformanceRow[]>;
}

export type { EntityName };

// ── Upgrade / Planos ────────────────────────────────────────────────

export interface PlanData {
  id: string;
  label: string;
  features: {
    maxLotes: number;
    maxPlantios: number;
    maxIaDia: number;
    relatoriosAvancados: boolean;
    climaAlertas: boolean;
    label: string;
  };
  price: { monthly: number; annual: number } | null;
}

export async function fetchPlans(): Promise<{ plans: PlanData[]; trialDays: number }> {
  const res = await fetch("/api/upgrade/plans", { credentials: "include" });
  if (!res.ok) throw new Error("Erro ao carregar planos");
  return res.json();
}

export async function fetchLicense(): Promise<{
  plan: string;
  features: PlanData["features"];
  license: string | null;
  status: string;
  trialEnd: string | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
}> {
  const res = await request("/api/upgrade/license");
  if (!res.ok) throw new Error("Erro ao carregar licença");
  return res.json();
}

export async function startTrial(plan: string): Promise<{ plan: string; trialEnd: string; license: string }> {
  const res = await request("/api/upgrade/trial", {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao iniciar trial");
  return data;
}

export async function createCheckout(plan: string, billing: string): Promise<{ url: string; sessionId: string }> {
  const res = await request("/api/upgrade/checkout", {
    method: "POST",
    body: JSON.stringify({ plan, billing }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao criar sessão de pagamento");
  return data;
}

/** Abre o Stripe Customer Portal (cancelar assinatura, trocar cartão, reativar). */
export async function openBillingPortal(): Promise<{ url: string }> {
  const res = await request("/api/upgrade/portal", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao abrir portal de assinatura");
  return data;
}