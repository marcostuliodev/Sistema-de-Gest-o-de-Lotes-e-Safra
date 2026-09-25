/**
 * UpgradeModal — Modal mostrando planos disponíveis e opção de upgrade.
 */

import { useState } from "react";
import { Modal, Button, Badge } from "./ui";
import { usePlan } from "../store/plan";

const PLANS = [
  {
    id: "basico",
    label: "Básico",
    price: "R$ 19,90",
    annualPrice: "R$ 15,92",
    annualTotal: "R$ 191,04/ano",
    features: ["5 lotes", "15 plantios", "5 análises de IA/dia", "Relatórios avançados", "Clima & Alertas"],
    color: "green",
  },
  {
    id: "pro",
    label: "Pro",
    price: "R$ 29,90",
    annualPrice: "R$ 23,92",
    annualTotal: "R$ 287,04/ano",
    features: ["20 lotes", "50 plantios", "15 análises de IA/dia", "Relatórios avançados", "Clima & Alertas"],
    color: "blue",
  },
  {
    id: "premium",
    label: "Premium",
    price: "R$ 59,90",
    annualPrice: "R$ 47,92",
    annualTotal: "R$ 575,04/ano",
    features: ["40 lotes", "100 plantios", "40 análises de IA/dia", "Relatórios avançados", "Clima & Alertas"],
    color: "purple",
  },
];

interface UpgradeModalProps {
  open: boolean;
  onClose: () => void;
  highlight?: string; // plano a destacar
}

export function UpgradeModal({ open, onClose, highlight }: UpgradeModalProps) {
  const { plan: currentPlan, startTrial, openCheckout } = usePlan();
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  async function handleStartTrial(planId: string) {
    setBusy(planId);
    setActionError("");
    try {
      await startTrial(planId);
      onClose();
      window.location.reload();
    } catch (err) {
      setActionError((err as Error).message || "Não foi possível ativar o teste.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCheckout(planId: string) {
    setBusy(planId);
    setActionError("");
    try {
      const url = await openCheckout(planId, billing);
      if (url) window.location.href = url;
    } catch (err) {
      setActionError((err as Error).message || "Não foi possível abrir o pagamento.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Escolha seu plano" wide>
      <div className="mb-5 flex justify-center">
        <div className="grid w-full max-w-xs grid-cols-2 gap-1 rounded-2xl border border-stone-200 bg-stone-50 p-1" role="group" aria-label="Periodicidade de cobrança">
          <button type="button" onClick={() => setBilling("monthly")} className={`min-h-11 rounded-xl px-3 text-sm font-black transition ${billing === "monthly" ? "bg-white text-stone-900 shadow-sm" : "text-stone-500"}`} aria-pressed={billing === "monthly"}>Mensal</button>
          <button type="button" onClick={() => setBilling("annual")} className={`min-h-11 rounded-xl px-3 text-sm font-black transition ${billing === "annual" ? "bg-green-700 text-white shadow-sm" : "text-stone-500"}`} aria-pressed={billing === "annual"}>Anual <span className="ml-1 text-[10px] text-green-200">-20%</span></button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p.id;
          const isHighlighted = highlight === p.id;
          const price = billing === "annual" ? p.annualPrice : p.price;
          const period = billing === "annual" ? "/mês (anual)" : "/mês";

          return (
            <div
              key={p.id}
              className={`relative rounded-2xl border-2 p-4 transition-all ${
                isHighlighted
                  ? "border-green-500 shadow-lg"
                  : isCurrent
                  ? "border-green-300 bg-green-50/50"
                  : "border-stone-200 hover:border-stone-300"
              }`}
            >
              {isHighlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge tone="green">Recomendado</Badge>
                </div>
              )}
              <h3 className="text-lg font-bold text-stone-800">{p.label}</h3>
              <div className="mt-2">
                <span className="text-2xl font-extrabold text-stone-800">{price}</span>
                <span className="text-sm text-stone-500">{period}</span>
              </div>
              {billing === "annual" && <p className="mt-1 text-xs font-semibold text-green-700">Total: {p.annualTotal}</p>}
              <ul className="mt-3 space-y-1.5">
                {p.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-stone-600">
                    <span className="text-green-600">✓</span> {f}
                  </li>
                ))}
              </ul>
              <div className="mt-4 space-y-2">
                {!isCurrent && (
                  <>
                    <Button
                      onClick={() => handleStartTrial(p.id)}
                      disabled={busy !== null}
                      className="w-full"
                      variant="subtle"
                    >
                      {busy === p.id ? "Aguarde..." : "Testar 10 dias grátis"}
                    </Button>
                    <Button
                      onClick={() => handleCheckout(p.id)}
                      disabled={busy !== null}
                      className="w-full"
                    >
                      {busy === p.id ? "Aguarde..." : "Assinar agora"}
                    </Button>
                  </>
                )}
                {isCurrent && (
                  <Badge tone="green">Plano atual</Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {actionError && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700" role="alert" aria-live="assertive">
          {actionError}
        </div>
      )}

      <p className="mt-4 text-center text-xs text-stone-400">
        Trial de 10 dias sem compromisso. Cancele quando quiser.
      </p>
    </Modal>
  );
}
