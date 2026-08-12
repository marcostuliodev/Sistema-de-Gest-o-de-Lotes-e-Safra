import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getSession, login, register, setSession, type AuthSession } from "../db/api";
import { clearLocal, db } from "../db/db";
import { pullServer } from "../db/sync";

const LAST_USER_KEY = "agrolote_last_user";

/** Se o usuário mudou (outra conta logando neste aparelho), zera o banco local
 *  para não misturar dados entre contas. */
async function prepareFreshStore(userId: number) {
  const last = localStorage.getItem(LAST_USER_KEY);
  if (last && last !== String(userId)) await clearLocal();
  localStorage.setItem(LAST_USER_KEY, String(userId));
}

interface AuthCtx {
  session: AuthSession | null;
  pendingSync: number;
  online: boolean;
  login: (email: string, pass: string) => Promise<void>;
  register: (name: string, email: string, pass: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(getSession());
  const [pendingSync, setPendingSync] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

const refreshOutbox = useCallback(() => {
    db.outbox.count().then(setPendingSync).catch(() => setPendingSync(0));
  }, []);

  useEffect(() => {
    const onOnline = () => { setOnline(true); };
    const onOffline = () => setOnline(false);
    const onSync = () => refreshOutbox();
    const onLogout = () => setSessionState(null);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("agrolote:synced", onSync);
    window.addEventListener("agrolote:logout", onLogout);
    refreshOutbox();
    setInterval(refreshOutbox, 10000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("agrolote:synced", onSync);
      window.removeEventListener("agrolote:logout", onLogout);
    };
  }, [refreshOutbox]);

const doLogin = async (email: string, pass: string) => {
    const s = await login(email, pass);
    setSessionState(s);
    await prepareFreshStore(s.user.id);
    await pullServer().catch(() => undefined);
  };
  const doRegister = async (name: string, email: string, pass: string) => {
    const s = await register(name, email, pass);
    setSessionState(s);
    await prepareFreshStore(s.user.id);
    await pullServer().catch(() => undefined);
  };
  const doLogout = () => {
    setSession(null);
    setSessionState(null);
    void db.outbox.clear();
  };

  return (
    <Ctx.Provider value={{ session, pendingSync, online, login: doLogin, register: doRegister, logout: doLogout }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
