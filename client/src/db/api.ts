import type { DashboardData, EntityName, PerformanceRow, Snapshot, SyncOp } from "./types";

export interface AuthSession {
  token: string;
  user: { id: number; name: string; email: string };
}

const TOKEN_KEY = "agrolote_token";
const USER_KEY = "agrolote_user";

export function getSession(): AuthSession | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const rawUser = localStorage.getItem(USER_KEY);
  if (!token || !rawUser) return null;
  try {
    return { token, user: JSON.parse(rawUser) };
  } catch {
    return null;
  }
}

export function setSession(s: AuthSession | null) {
  if (s) {
    localStorage.setItem(TOKEN_KEY, s.token);
    localStorage.setItem(USER_KEY, JSON.stringify(s.user));
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const session = getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers as Record<string, string>) };
  if (session) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !path.includes("/auth/login")) {
    setSession(null);
    window.dispatchEvent(new CustomEvent("agrolote:logout"));
  }
  return res;
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
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
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Falha no cadastro");
  setSession(data);
  return data;
}

export async function pushSync(ops: SyncOp[]): Promise<{ snapshot: Snapshot; serverTime: string } | null> {
  const res = await request("/api/sync", {
    method: "POST",
    body: JSON.stringify({ ops }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Falha na sincronização");
  }
  return res.json();
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