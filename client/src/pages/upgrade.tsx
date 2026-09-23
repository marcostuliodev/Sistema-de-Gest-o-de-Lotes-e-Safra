/**
 * Página de upgrade/planos.
 * Mostra todos os planos, trial e assinatura atual.
 */

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { usePlan } from "../store/plan";
import { Button, Card, Badge } from "../components/ui";
import { Leaf } from "../components/icons";

const PLANS = [
  {
    id: "basico",
    label: "Básico",
    price: "R$ 49,90",
    annualPrice: "R$ 39,90",
    features: [
      "5 lotes",
      "15 plantios",
      "30 análises de IA/dia",
      "Relatórios avançados",
    ],
    notIncluded: ["Clima & Alertas"],
  },
  {
    id: "pro",
    label: "Pro",
    price: "R$ 149,90",
    annualPrice: "R$ 119,90",
    features: [
      "20 lotes",
      "50 plantios",
      "120 análises de IA/dia",
      "Relatórios avançados",
    ],
    notIncluded: ["Clima & Alertas"],
  },
  {
    id: "premium",
    label: "Premium",
    price: "R$ 399,90",
    annualPrice: "R$ 319,90",
    features: [
      "40 lotes",
      "100 plantios",
      "IA ilimitada (10k/dia)",
      "Relatórios avançados",
      "Clima & Alertas",
    ],
    notIncluded: [],
  },
];

const PLAN_ORDER = ["free", "basico", "pro", "premium"];

export default function Upgrade() {
  const { plan: currentPlan, status, trialEnd, trialRemaining, startTrial, openCheckout } = usePlan();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [busy, setBusy] = useState<string | null>(null);

  const success = searchParams.get("success");
  const cancelled = searchParams.get("cancelled");

  async function handleStartTrial(planId: string) {
    setBusy(planId);
    try {
      await startTrial(planId);
      navigate("/upgrade?trial=1");
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

  function planLevel(p: string) {
    return PLAN_ORDER.indexOf(p);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-stone-800">Planos & Assinatura</h1>
        <p className="text-sm text-stone-500">
          Escolha o plano ideal para sua propriedade.
        </p>
      </div>

      {/* Status atual */}
      {currentPlan !== "free" && (
        <Card className="bg-gradient-to-r from-green-50 to-emerald-50">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-stone-500">Plano atual</p>
              <p className="text-lg font-bold text-stone-800">
                {PLANS.find((p) => p.id === currentPlan)?.label || currentPlan}
              </p>
              {status === "trial" && trialEnd && (
                <p className="text-sm text-amber-600">
                  Trial: {trialRemaining} dia(s) restante(s)
                </p>
              )}
            </div>
            <div className="text-3xl">
              <Leaf />
            </div>
          </div>
        </Card>
      )}

      {/* Success/Cancel message */}
      {success && (
        <div className="rounded-2xl bg-green-50 p-4 text-center">
          <p className="font-semibold text-green-800">Pagamento confirmado!</p>
          <p className="text-sm text-green-700">Seu plano foi ativado. Aproveite!</p>
        </div>
      )}
      {cancelled && (
        <div className="rounded-2xl bg-amber-50 p-4 text-center">
          <p className="font-semibold text-amber-800">Pagamento cancelado.</p>
          <p className="text-sm text-amber-700">Você pode tentar novamente quando quiser.</p>
        </div>
      )}

      {/* Toggle billing */}
      <div className="flex items-center justify-center gap-3">
        <span className={`text-sm font-medium ${billing === "monthly" ? "text-stone-800" : "text-stone-400"}`}>
          Mensal
        </span>
        <button
          onClick={() => setBilling(billing === "monthly" ? "annual" : "monthly")}
          className={`relative h-6 w-11 rounded-full transition-colors ${billing === "annual" ? "bg-green-600" : "bg-stone-300"}`}
        >
          <span
            className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
            style={{ left: billing === "annual" ? "22px" : "2px" }}
          />
        </button>
        <span className={`text-sm font-medium ${billing === "annual" ? "text-stone-800" : "text-stone-400"}`}>
          Anual <Badge tone="green">-20%</Badge>
        </span>
      </div>

      {/* Planos */}
      <div className="grid gap-4 sm:grid-cols-3">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p.id;
          const canUpgrade = planLevel(currentPlan) < planLevel(p.id);
          const price = billing === "annual" ? p.annualPrice : p.price;
          const period = billing === "annual" ? "/mês (anual)" : "/mês";

          return (
            <Card key={p.id} className={`relative ${isCurrent ? "ring-2 ring-green-500" : ""}`}>
              {isCurrent && (
                <div className="absolute -top-3 left-4">
                  <Badge tone="green">Atual</Badge>
                </div>
              )}
              <h3 className="text-lg font-bold text-stone-800">{p.label}</h3>
              <div className="mt-2 flex flex-wrap items-baseline gap-1">
                <span className="text-2xl font-extrabold text-stone-800">{price}</span>
                <span className="text-sm text-stone-500">{period}</span>
              </div>
              <ul className="mt-4 space-y-2">
                {p.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-stone-600">
                    <span className="text-green-600">✓</span> {f}
                  </li>
                ))}
                {p.notIncluded.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-stone-400">
                    <span className="text-stone-300">—</span> {f}
                  </li>
                ))}
              </ul>
              <div className="mt-5 space-y-2">
                {!isCurrent && canUpgrade && (
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
                  <p className="text-center text-sm font-medium text-green-700">
                    ✓ Seu plano atual
                  </p>
                )}
                {!isCurrent && !canUpgrade && (
                  <p className="text-center text-sm text-stone-400">
                    Plano inferior ao atual
                  </p>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Trial info */}
      {currentPlan === "free" && status !== "trial" && (
        <div className="text-center">
          <p className="text-sm text-stone-500">
            Comece com <strong>10 dias grátis</strong> de qualquer plano. Sem compromisso.
          </p>
        </div>
      )}

      {/* Detalhes do plano Free */}
      <Card>
        <h3 className="font-bold text-stone-800">Plano Gratuito</h3>
        <p className="mt-1 text-sm text-stone-500">
          Incluído para sempre. Limitado a 1 lote e 5 plantios.
        </p>
        <ul className="mt-3 space-y-1">
          <li className="flex items-center gap-2 text-sm text-stone-600">
            <span className="text-green-600">✓</span> 1 lote
          </li>
          <li className="flex items-center gap-2 text-sm text-stone-600">
            <span className="text-green-600">✓</span> 5 plantios
          </li>
          <li className="flex items-center gap-2 text-sm text-stone-400">
            <span className="text-stone-300">—</span> Relatórios básicos
          </li>
          <li className="flex items-center gap-2 text-sm text-stone-400">
            <span className="text-stone-300">—</span> Clima & Alertas
          </li>
        </ul>
      </Card>
    </div>
  );
}
