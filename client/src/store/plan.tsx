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

export interface PlanFeatures {
  maxLotes: number;
  maxPlantios: number;
  relatoriosAvancados: boolean;
  climaAlertas: boolean;
  label: string;
}

interface PlanCtx {
  plan: string;
  features: PlanFeatures;
  status: string; // 'active' | 'trial' | 'expired' | 'free'
  trialEnd: string | null;
  trialRemaining: number; // dias restantes, -1 se não está em trial
  loading: boolean;
  blocked: boolean; // integrity check falhou
  clockWarning: boolean;
  refresh: () => Promise<void>;
  startTrial: (plan: string) => Promise<void>;
  openCheckout: (plan: string, billing: string) => Promise<string | null>;
}

const FREE_FEATURES: PlanFeatures = {
  maxLotes: 1,
  maxPlantios: 5,
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

  const fetchLicense = useCallback(async () => {
    if (!session) return;
    setLoading(true);

    try {
      // 1. Valida licença local primeiro (funciona offline)
      const localResult = await validateStoredLicense(session.user.id);
      if (localResult.valid) {
        setPlan(localResult.plan);
        setFeatures(localResult.features);
        setStatus("active");
      }

      // 2. Busca licença atualizada do servidor (quando online)
      if (navigator.onLine) {
        const res = await fetch("/api/upgrade/license", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setPlan(data.plan);
          setFeatures(data.features || FREE_FEATURES);
          setStatus(data.status || "free");
          setTrialEnd(data.trialEnd || null);

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

  return (
    <Ctx.Provider value={{
      plan, features, status, trialEnd, trialRemaining,
      loading, blocked, clockWarning,
      refresh: fetchLicense, startTrial, openCheckout,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const usePlan = () => useContext(Ctx);
