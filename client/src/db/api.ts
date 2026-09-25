import { getActiveScope, type ActiveScope } from "./db";
import { getScopedStorageItem, removeScopedStorageItem, setScopedStorageItem } from "../lib/scoped-storage";
import type { DashboardData, EntityName, PerformanceRow, Snapshot, SyncDeleteResult, SyncOp, SyncTombstone } from "./types";

export interface AuthUser {
  id: number | string;
  user_key?: string;
  name: string;
  email: string;
  email_verified: boolean;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

export interface Project {
  id: string;
  name: string;
  nome: string;
  role: string | null;
  role_id: string | null;
  permissions: string[];
  isOwner: boolean;
  is_default: boolean;
}

const USER_KEY = "agrolote_user";
const CURRENT_USER_POINTER_KEY = "agrolote_current_user_id";
const SESSION_SCOPE_PROJECT = "__session__";
const PROJECTS_CACHE_KEY = "projects_cache";

function userIdOf(user: Partial<AuthUser> | null | undefined): string | null {
  const value = user?.id ?? user?.user_key;
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  return normalized.trim() ? normalized : null;
}

function parseUser(raw: string | null): AuthUser | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthUser>;
    const id = userIdOf(parsed);
    if (!id) return null;
    return {
      id: parsed.id ?? id,
      user_key: parsed.user_key === undefined ? undefined : String(parsed.user_key),
      name: typeof parsed.name === "string" ? parsed.name : "",
      email: typeof parsed.email === "string" ? parsed.email : "",
      email_verified: parsed.email_verified !== false,
    };
  } catch {
    return null;
  }
}

function sessionScope(userId: string) {
  return { userId, projectId: SESSION_SCOPE_PROJECT };
}

function readLocal(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function removeLocal(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

function normalizeSession(payload: unknown): AuthSession {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const user = parseUser(JSON.stringify((data as { user?: unknown }).user));
  if (!user) throw new Error("Resposta de autenticação inválida");
  return { token: "", user };
}

export function getSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  const pointer = readLocal(CURRENT_USER_POINTER_KEY);
  if (pointer) {
    const raw = getScopedStorageItem(sessionScope(pointer), USER_KEY, "local", false);
    const user = parseUser(raw);
    if (user && userIdOf(user) === pointer) return { token: "", user };
    removeLocal(CURRENT_USER_POINTER_KEY);
    return null;
  }

  const legacyUser = parseUser(readLocal(USER_KEY));
  if (!legacyUser) return null;
  const userId = userIdOf(legacyUser);
  if (!userId) return null;
  setScopedStorageItem(sessionScope(userId), USER_KEY, JSON.stringify(legacyUser), "local");
  writeLocal(CURRENT_USER_POINTER_KEY, userId);
  removeLocal(USER_KEY);
  return { token: "", user: legacyUser };
}

export function setSession(s: AuthSession | null) {
  if (!s) {
    const pointer = readLocal(CURRENT_USER_POINTER_KEY);
    if (pointer) removeScopedStorageItem(sessionScope(pointer), USER_KEY, "local");
    removeLocal(CURRENT_USER_POINTER_KEY);
    removeLocal(USER_KEY);
    return;
  }

  const userId = userIdOf(s.user);
  if (!userId) return;
  setScopedStorageItem(sessionScope(userId), USER_KEY, JSON.stringify(s.user), "local");
  // Hint exclusivo para migración do IndexedDB legado; nunca usado para autorização.
  writeLocal("agrolote_last_user", userId);
  writeLocal(CURRENT_USER_POINTER_KEY, userId);
  removeLocal(USER_KEY);
}

function addDefaultHeaders(headers: Headers, options: RequestInit) {
  if (options.body && !(typeof FormData !== "undefined" && options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
}

async function request(
  path: string,
  options: RequestInit = {},
  projectId: string | null = getActiveScope()?.projectId ?? null,
): Promise<Response> {
  const headers = new Headers(options.headers);
  addDefaultHeaders(headers, options);
  if (projectId) headers.set("X-Project-Id", projectId);
  const res = await fetch(path, { ...options, headers, credentials: "include" });
  const isSyncRequest = path === "/api/sync" || path.startsWith("/api/sync/");
  if (res.status === 401 && !path.includes("/auth/login")) {
    setSession(null);
    window.dispatchEvent(new CustomEvent(isSyncRequest ? "agrolote:reauth-required" : "agrolote:logout"));
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
  const session = normalizeSession(data);
  setSession(session);
  return session;
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
  return normalizeSession(data);
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
}

export async function fetchProjects(): Promise<Project[]> {
  const session = getSession();
  const userId = userIdOf(session?.user);
  const cacheContext = userId ? { userId, projectId: null } : null;
  let res: Response;
  try {
    res = await request("/api/projects", {}, null);
  } catch (error) {
    const cached = cacheContext ? getScopedStorageItem(cacheContext, PROJECTS_CACHE_KEY, "local", false) : null;
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed as Project[];
      } catch {
        // remove cache inválido somente neste escopo
        if (cacheContext) removeScopedStorageItem(cacheContext, PROJECTS_CACHE_KEY, "local");
      }
    }
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error(data.error || "Sessão expirada");
    const cached = cacheContext ? getScopedStorageItem(cacheContext, PROJECTS_CACHE_KEY, "local", false) : null;
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed as Project[];
      } catch {
        // mantém o erro original
      }
    }
    throw new Error(data.error || "Erro ao carregar projetos");
  }
  if (!Array.isArray(data)) throw new Error("Resposta inválida de projetos");
  if (cacheContext) setScopedStorageItem(cacheContext, PROJECTS_CACHE_KEY, JSON.stringify(data), "local");
  return data as Project[];
}

export async function createProject(name: string): Promise<Project> {
  const res = await request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  }, null);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erro ao criar projeto");
  return data as Project;
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

export interface TombstoneCursor {
  seq?: number;
  updatedAt?: string;
  id?: string | null;
}

export interface SyncResult {
  snapshot: Snapshot;
  serverTime: string;
  appliedOpIndexes?: number[];
  failedOps?: { index: number; entity: string | null; action: string | null; code: string; error?: string; count?: number; retryable?: boolean; dependents?: Record<string, number> }[];
  results?: ({ index: number } & Partial<SyncDeleteResult>)[];
  tombstones?: SyncTombstone[];
  tombstoneCursor?: TombstoneCursor;
  tombstoneHasMore?: boolean;
  deletedCount?: number;
  deletedIds?: string[];
  deletedEntities?: { entity: EntityName | "photos_metadata"; id: string }[];
}

function requireSyncScope(expectedScope?: ActiveScope | null): ActiveScope {
  const session = getSession();
  const activeScope = getActiveScope();
  const scope = expectedScope || activeScope;
  const scopeIsCurrent = !expectedScope || (
    !!activeScope
    && activeScope.userId === expectedScope.userId
    && activeScope.projectId === expectedScope.projectId
    && activeScope.accountId === expectedScope.accountId
  );
  const sessionAccountId = String(session?.user.user_key || session?.user.id || "");
  if (!session || !scope || !scopeIsCurrent || String(session.user.id) !== scope.userId || sessionAccountId !== scope.accountId) {
    const error = new Error("Sessão ou projeto ausente") as Error & { code?: string };
    error.code = "PROJECT_SCOPE_REQUIRED";
    throw error;
  }
  return scope;
}

export async function pushSync(
  ops: SyncOp[],
  expectedScope?: ActiveScope | null,
  tombstoneCursor?: TombstoneCursor | null,
): Promise<SyncResult | null> {
  const scope = requireSyncScope(expectedScope);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await request("/api/sync", {
      method: "POST",
      body: JSON.stringify({ ops, tombstoneCursor }),
      signal: controller.signal,
    }, scope.projectId);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const error = new Error(data.error || "Falha na sincronização") as Error & {
        status?: number;
        code?: string;
      };
      error.status = res.status;
      error.code = data.code;
      if (res.status === 403 && (data.code === "PROJECT_ACCESS_DENIED" || data.code === "PROJECT_NOT_FOUND" || data.code === "PROJECT_SELECTION_REQUIRED")) {
        window.dispatchEvent(new CustomEvent("agrolote:project-access-revoked", { detail: { projectId: scope.projectId } }));
      }
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

export async function openBillingPortal(): Promise<{ url: string }> {
  const res = await request("/api/upgrade/portal", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao abrir portal de assinatura");
  return data;
}
