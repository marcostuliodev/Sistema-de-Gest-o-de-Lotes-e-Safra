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
    price: "R$ 49,90",
    annualPrice: "R$ 39,90",
     features: ["5 lotes", "15 plantios", "Relatórios avançados", "Clima & Alertas"],
    color: "green",
  },
  {
    id: "pro",
    label: "Pro",
    price: "R$ 149,90",
    annualPrice: "R$ 119,90",
     features: ["20 lotes", "50 plantios", "Relatórios avançados", "Clima & Alertas"],
    color: "blue",
  },
  {
    id: "premium",
    label: "Premium",
    price: "R$ 399,90",
    annualPrice: "R$ 319,90",
    features: ["40 lotes", "100 plantios", "Relatórios avançados", "Clima & Alertas"],
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

  async function handleStartTrial(planId: string) {
    setBusy(planId);
    try {
      await startTrial(planId);
      onClose();
      window.location.reload();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCheckout(planId: string) {
    setBusy(planId);
    try {
      const url = await openCheckout(planId, billing);
      if (url) window.location.href = url;
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Escolha seu plano" wide>
      {/* Toggle mensal/anual */}
      <div className="mb-5 flex items-center justify-center gap-3">
        <span className={`text-sm font-medium ${billing === "monthly" ? "text-stone-800" : "text-stone-400"}`}>
          Mensal
        </span>
        <button
          onClick={() => setBilling(billing === "monthly" ? "annual" : "monthly")}
          className={`relative h-6 w-11 rounded-full transition-colors ${billing === "annual" ? "bg-green-600" : "bg-stone-300"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              billing === "annual" ? "left-5.5 translate-x-0" : "left-0.5"
            }`}
            style={{ left: billing === "annual" ? "22px" : "2px" }}
          />
        </button>
        <span className={`text-sm font-medium ${billing === "annual" ? "text-stone-800" : "text-stone-400"}`}>
          Anual <Badge tone="green">-20%</Badge>
        </span>
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

      <p className="mt-4 text-center text-xs text-stone-400">
        Trial de 10 dias sem compromisso. Cancele quando quiser.
      </p>
    </Modal>
  );
}
