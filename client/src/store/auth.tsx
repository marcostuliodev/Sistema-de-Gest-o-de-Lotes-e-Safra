import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getSession, login, register, setSession, logout, resendVerification, type AuthSession } from "../db/api";
import { db } from "../db/db";
import { pullServer, runSync } from "../db/sync";

const LAST_USER_KEY = "agrolote_last_user";

/** Registra a última conta usada neste aparelho.
 *  IMPORTANTE: não apagamos mais o banco local ao trocar de conta. O app é
 *  offline-first e os dados vivem no dispositivo; o sync reenvia tudo para a
 *  conta logada. Apagar causaria perda de dados do produtor (ex.: após o banco
 *  do servidor ser recriado e o usuário registrar uma conta nova). */
async function prepareFreshStore(userId: number) {
  localStorage.setItem(LAST_USER_KEY, String(userId));
}

interface AuthCtx {
  session: AuthSession | null;
  pendingSync: number;
  online: boolean;
  syncError: string | null;
  login: (email: string, pass: string) => Promise<void>;
  register: (name: string, email: string, pass: string) => Promise<AuthSession>;
  logout: () => void;
  resendVerification: (email: string) => Promise<{ ok: boolean; message: string }>;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(getSession());
  const [pendingSync, setPendingSync] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncError, setSyncError] = useState<string | null>(null);

const refreshOutbox = useCallback(() => {
    db.outbox.count().then(setPendingSync).catch(() => setPendingSync(0));
  }, []);

  useEffect(() => {
    const onOnline = () => { setOnline(true); };
    const onOffline = () => setOnline(false);
    const onSync = () => {
      setSyncError(null);
      refreshOutbox();
    };
    const onOutboxChange = () => refreshOutbox();
    const onSyncError = (event: Event) => {
      setSyncError((event as CustomEvent<string>).detail || "Não foi possível sincronizar agora.");
    };
    const onLogout = () => setSessionState(null);
    const onReauthRequired = () => setSessionState(null);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("agrolote:synced", onSync);
    window.addEventListener("agrolote:outbox-change", onOutboxChange);
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
      window.removeEventListener("agrolote:logout", onLogout);
      window.removeEventListener("agrolote:reauth-required", onReauthRequired);
      window.removeEventListener("agrolote:sync-error", onSyncError);
      clearInterval(outboxInterval);
    };
  }, [refreshOutbox]);

  const doLogin = async (email: string, pass: string) => {
    const s = await login(email, pass);
    setSyncError(null);
    setSessionState(s);
    void prepareFreshStore(s.user.id);
    // A sessão e os dados locais já estão prontos; não bloqueia o login
    // aguardando o snapshot remoto. Depois do pull, envia imediatamente
    // qualquer operação que ficou pendente enquanto o cookie expirava.
    void pullServer().then(() => runSync());
  };
  // Register NÃO cria sessão (sem cookie no body) — o fluxo de UI de cadastro
  // é login.tsx, que mostra a tela genérica e manda o usuário logar depois.
  const doRegister = async (name: string, email: string, pass: string): Promise<AuthSession> => {
    const s = await register(name, email, pass);
    setSession(null);
    setSessionState(null);
    return s;
  };
  const doLogout = () => {
    void logout();
    setSession(null);
    setSessionState(null);
    void db.outbox.clear().then(() => {
      window.dispatchEvent(new Event("agrolote:outbox-change"));
    });
  };

  const doResendVerification = async (email: string) => {
    return resendVerification(email);
  };

  return (
      <Ctx.Provider value={{ session, pendingSync, online, syncError, login: doLogin, register: doRegister, logout: doLogout, resendVerification: doResendVerification }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
