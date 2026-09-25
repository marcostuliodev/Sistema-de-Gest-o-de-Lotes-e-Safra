import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getSession, login, register, setSession, logout, resendVerification, type AuthSession } from "../db/api";
import { getActiveScope, setActiveScope, waitForActiveScope } from "../db/db";
import { outboxCount } from "../db/sync";
import { unsubscribePush } from "../lib/push";

interface AuthCtx {
  session: AuthSession | null;
  pendingSync: number;
  online: boolean;
  syncError: string | null;
  login: (email: string, pass: string) => Promise<void>;
  register: (name: string, email: string, pass: string) => Promise<AuthSession>;
  logout: () => Promise<void>;
  resendVerification: (email: string) => Promise<{ ok: boolean; message: string }>;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(getSession);
  const [pendingSync, setPendingSync] = useState(0);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncError, setSyncError] = useState<string | null>(null);

  const refreshOutbox = useCallback(() => {
    const scope = getActiveScope();
    if (!scope) {
      setPendingSync(0);
      return;
    }
    const session = getSession();
    const accountId = String(session?.user.user_key || session?.user.id || "");
    if (!session || accountId !== scope.accountId) {
      setPendingSync(0);
      return;
    }
    outboxCount().then((count) => {
      const current = getActiveScope();
      if (current && current.userId === scope.userId && current.projectId === scope.projectId) {
        setPendingSync(count);
      }
    }).catch(() => {
      if (getActiveScope()?.projectId === scope.projectId) setPendingSync(0);
    });
  }, []);

  const leaveSession = useCallback(() => {
    void unsubscribePush().catch(() => undefined);
    void fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    setSession(null);
    setSessionState(null);
    void setActiveScope(null);
  }, []);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string } | undefined>).detail;
      if (detail?.projectId && detail.projectId !== getActiveScope()?.projectId) return;
      setSyncError(null);
      refreshOutbox();
    };
    const onOutboxChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string } | undefined>).detail;
      if (detail?.projectId && detail.projectId !== getActiveScope()?.projectId) return;
      refreshOutbox();
    };
    const onSyncError = (event: Event) => {
      const detail = (event as CustomEvent<string | { projectId?: string; message?: string }>).detail;
      if (typeof detail === "object" && detail.projectId && detail.projectId !== getActiveScope()?.projectId) return;
      setSyncError(typeof detail === "object" ? detail.message || "Não foi possível sincronizar agora." : detail || "Não foi possível sincronizar agora.");
    };
    const onLogout = () => leaveSession();
    const onReauthRequired = () => leaveSession();
    const onScopeChange = () => refreshOutbox();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("agrolote:synced", onSync);
    window.addEventListener("agrolote:outbox-change", onOutboxChange);
    window.addEventListener("agrolote:scope-change", onScopeChange);
    window.addEventListener("agrolote:logout", onLogout);
    window.addEventListener("agrolote:reauth-required", onReauthRequired);
    window.addEventListener("agrolote:sync-error", onSyncError);
    refreshOutbox();
    const outboxInterval = setInterval(refreshOutbox, 10000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("agrolote:synced", onSync);
      window.removeEventListener("agrolote:outbox-change", onOutboxChange);
      window.removeEventListener("agrolote:scope-change", onScopeChange);
      window.removeEventListener("agrolote:logout", onLogout);
      window.removeEventListener("agrolote:reauth-required", onReauthRequired);
      window.removeEventListener("agrolote:sync-error", onSyncError);
      clearInterval(outboxInterval);
    };
  }, [leaveSession, refreshOutbox]);

  const doLogin = async (email: string, pass: string) => {
    const loggedSession = await login(email, pass);
    setSyncError(null);
    setSessionState(loggedSession);
    try {
      await waitForActiveScope(String(loggedSession.user.id), loggedSession.user.user_key || loggedSession.user.id);
    } catch (error) {
      // Login/sessão são válidos; falta apenas o projeto (ex.: primeiro uso offline).
      // Não apaga a sessão nem os dados locais nesse caso.
      setSyncError(error instanceof Error ? error.message : "Entre novamente quando o projeto estiver disponível.");
    }
  };

  const doRegister = async (name: string, email: string, pass: string): Promise<AuthSession> => {
    const registeredSession = await register(name, email, pass);
    setSession(null);
    setSessionState(null);
    await setActiveScope(null).catch(() => undefined);
    return registeredSession;
  };

  const doLogout = async () => {
    await unsubscribePush().catch(() => undefined);
    setSession(null);
    setSessionState(null);
    await setActiveScope(null).catch(() => undefined);
    await logout();
  };

  const doResendVerification = async (email: string) => resendVerification(email);

  return (
    <Ctx.Provider value={{
      session,
      pendingSync,
      online,
      syncError,
      login: doLogin,
      register: doRegister,
      logout: doLogout,
      resendVerification: doResendVerification,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
