/**
 * React Context para gerenciamento de planos.
 *
 * Fornece:
 * - Plano atual do usuário
 * - Features/limites do plano
 * - Status de trial
 * - Funções para upgrade/trial
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { validateStoredLicense, setStoredLicense } from "../lib/license";
import { initClockGuard, sendHeartbeat } from "../lib/clock-guard";
import { runIntegrityCheck, startIntegrityMonitoring } from "../lib/integrity";
import { getMyAccess } from "../db/collaborators";

export interface PlanFeatures {
  maxLotes: number;
  maxPlantios: number;
  maxFotos: number;
  maxColaboradores: number;
  maxIaDia: number;
  relatoriosAvancados: boolean;
  climaAlertas: boolean;
  label: string;
}

interface PlanCtx {
  plan: string;
  features: PlanFeatures;
  status: string; // 'active' | 'trial' | 'expired' | 'free' | 'cancelled' | 'past_due'
  trialEnd: string | null;
  trialRemaining: number; // dias restantes, -1 se não está em trial
  loading: boolean;
  blocked: boolean; // integrity check falhou
  clockWarning: boolean;
  isCollaborator: boolean;
  ownerName: string | null;
  cancelAtPeriodEnd: boolean; // cancelamento agendado (Stripe Portal)
  currentPeriodEnd: string | null; // fim do período pago
  refresh: () => Promise<void>;
  startTrial: (plan: string) => Promise<void>;
  openCheckout: (plan: string, billing: string) => Promise<string | null>;
  openPortal: () => Promise<string | null>; // Stripe Customer Portal
}

const FREE_FEATURES: PlanFeatures = {
  maxLotes: 1,
  maxPlantios: 5,
  maxFotos: 0,
  maxColaboradores: 0,
  maxIaDia: 3,
  relatoriosAvancados: false,
  climaAlertas: false,
  label: "Gratuito",
};

const Ctx = createContext<PlanCtx>(null as unknown as PlanCtx);

export function PlanProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [plan, setPlan] = useState("free");
  const [features, setFeatures] = useState<PlanFeatures>(FREE_FEATURES);
  const [status, setStatus] = useState("free");
  const [trialEnd, setTrialEnd] = useState<string | null>(null);
  const [trialRemaining, setTrialRemaining] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [clockWarning, setClockWarning] = useState(false);
  const [isCollaborator, setIsCollaborator] = useState(false);
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null);

  const fetchLicense = useCallback(async () => {
    if (!session) return;
    setLoading(true);

    try {
      // 1. Valida licença local primeiro (funciona offline)
      const localResult = await validateStoredLicense(session.user.id);
      if (localResult.valid) {
        setPlan(localResult.plan);
        setFeatures({ ...FREE_FEATURES, ...(localResult.features || {}) });
        setStatus("active");
      }

      // 2. Busca licença atualizada do servidor (quando online).
      // O /license é a FONTE AUTORITATIVA de isCollaborator/plano.
      let licenseIsCollab: boolean | null = null;
      if (navigator.onLine) {
        const res = await fetch("/api/upgrade/license", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setPlan(data.plan);
          setFeatures({ ...FREE_FEATURES, ...(data.features || {}) });
          setStatus(data.status || "free");
          setTrialEnd(data.trialEnd || null);
          setCancelAtPeriodEnd(!!data.cancelAtPeriodEnd);
          setCurrentPeriodEnd(data.currentPeriodEnd || null);
          licenseIsCollab = !!data.isCollaborator;
          setIsCollaborator(licenseIsCollab);

          if (data.license) {
            setStoredLicense(data.license);
          } else {
            setStoredLicense(null);
          }

          // Calcula dias restantes do trial
          if (data.trialEnd) {
            const end = new Date(data.trialEnd);
            const now = new Date();
            const remaining = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            setTrialRemaining(Math.max(0, remaining));
          } else {
            setTrialRemaining(-1);
          }
        }
      }

      // 3. Complementa com o nome do dono (ownerName) e reforça isCollaborator.
      // REGRA: getMyAccess() NUNCA sobrescreve isCollaborator=true vindo do
      // /license com false (resposta vazia/stale não pode apagar o estado real).
      try {
        const access = await getMyAccess();
        if (access.length > 0) {
          setIsCollaborator(true);
          setOwnerName(access[0].owner_name || null);
        } else if (licenseIsCollab === true) {
          // /license disse colaborador — mantém true; só limpa o nome do dono.
          setOwnerName(null);
        } else {
          setIsCollaborator(false);
          setOwnerName(null);
        }
      } catch {
        // silencioso — mantém o que tinha
      }
    } catch {
      // Em caso de erro, mantém o que tinha
    } finally {
      setLoading(false);
    }
  }, [session]);

  // Inicialização: clock guard + integrity + license
  useEffect(() => {
    if (!session) return;

    // Clock guard
    const clockResult = initClockGuard();
    if (!clockResult.ok) {
      setClockWarning(true);
      if (clockResult.reason === "clock_rolled_back") {
        setBlocked(true);
      }
    }

    // Integrity check
    runIntegrityCheck().then((result) => {
      if (result.blocked) setBlocked(true);
    });
    const stopIntegrity = startIntegrityMonitoring();

    // Heartbeat periódico (online)
    const heartbeatInterval = setInterval(() => {
      if (navigator.onLine) {
        sendHeartbeat().then((r) => {
          if (!r.ok) setClockWarning(true);
        });
      }
    }, 5 * 60 * 1000);

    // Busca licença
    fetchLicense();

    return () => {
      clearInterval(heartbeatInterval);
      clockResult.cleanup?.();
      stopIntegrity();
    };
  }, [session, fetchLicense]);

  const startTrial = useCallback(async (planId: string) => {
    const res = await fetch("/api/upgrade/trial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ plan: planId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao iniciar trial");
    if (data.license) setStoredLicense(data.license);
    await fetchLicense();
  }, [fetchLicense]);

  const openCheckout = useCallback(async (planId: string, billing: string): Promise<string | null> => {
    const res = await fetch("/api/upgrade/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ plan: planId, billing }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao criar sessão de pagamento");
    return data.url;
  }, []);

  const openPortal = useCallback(async (): Promise<string | null> => {
    const res = await fetch("/api/upgrade/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao abrir portal de assinatura");
    return data.url;
  }, []);

  return (
    <Ctx.Provider value={{
      plan, features, status, trialEnd, trialRemaining,
      loading, blocked, clockWarning, isCollaborator, ownerName,
      cancelAtPeriodEnd, currentPeriodEnd,
      refresh: fetchLicense, startTrial, openCheckout, openPortal,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const usePlan = () => useContext(Ctx);
