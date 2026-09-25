/**
 * Página de upgrade/planos.
 * Mostra todos os planos, trial e assinatura atual.
 */

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { usePlan } from "../store/plan";
import { Button, Card, Badge } from "../components/ui";
import { Check, Leaf } from "../components/icons";

const PLANS = [
  {
    id: "basico",
    label: "Básico",
    price: "R$ 19,90",
    annualPrice: "R$ 15,92",
    annualTotal: "R$ 191,04/ano",
    features: [
      "5 lotes",
      "15 plantios",
      "5 análises de IA/dia",
       "Relatórios avançados",
       "Clima & Alertas",
     ],
    notIncluded: [],
  },
  {
    id: "pro",
    label: "Pro",
    price: "R$ 29,90",
    annualPrice: "R$ 23,92",
    annualTotal: "R$ 287,04/ano",
    features: [
      "20 lotes",
      "50 plantios",
      "15 análises de IA/dia",
       "Relatórios avançados",
       "Clima & Alertas",
     ],
    notIncluded: [],
  },
  {
    id: "premium",
    label: "Premium",
    price: "R$ 59,90",
    annualPrice: "R$ 47,92",
    annualTotal: "R$ 575,04/ano",
    features: [
      "40 lotes",
      "100 plantios",
      "40 análises de IA/dia",
      "Relatórios avançados",
      "Clima & Alertas",
    ],
    notIncluded: [],
  },
];

const PLAN_ORDER = ["free", "basico", "pro", "premium"];

export default function Upgrade() {
  const {
    plan: currentPlan, status, trialEnd, trialRemaining, startTrial, openCheckout,
    isCollaborator, ownerName, loading, cancelAtPeriodEnd, currentPeriodEnd, openPortal, refresh,
   } = usePlan();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [busy, setBusy] = useState<string | null>(null);

  const success = searchParams.get("success");
  const cancelled = searchParams.get("cancelled");
  const fromPortal = searchParams.get("portal");

  useEffect(() => {
     if (success !== "1") return;
     let attempts = 0;
     let timer = 0;
     const poll = () => {
       attempts += 1;
       void refresh();
       if (attempts < 30) timer = window.setTimeout(poll, 2000);
     };
     timer = window.setTimeout(poll, 500);
     return () => window.clearTimeout(timer);
   }, [success, refresh]);

   // Aguarda o fetch da licença antes de decidir (evita flash de UI de dono)
  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-stone-800">Planos & Assinatura</h1>
        <p className="text-sm text-stone-400">Carregando...</p>
      </div>
    );
  }

  // Colaboradores não podem gerenciar planos — mostra aviso claro
  if (isCollaborator) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Planos & Assinatura</h1>
        </div>
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-green-300 bg-green-50/50 px-6 py-12 text-center">
          <Badge tone="green">Colaborador</Badge>
          <div className="mb-3 mt-3 text-4xl">🤝</div>
          <p className="max-w-sm font-semibold text-stone-700">
            Você é colaborador. O plano é definido pelo proprietário da conta.
          </p>
          {ownerName && (
            <p className="mt-2 text-sm text-stone-500">
              Acesso via: <span className="font-semibold text-stone-700">{ownerName}</span>
            </p>
          )}
          <Button className="mt-5" onClick={() => navigate("/")}>
            Voltar ao Painel
          </Button>
        </div>
      </div>
    );
  }

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

  async function handlePortal() {
    setBusy("portal");
    try {
      const url = await openPortal();
      if (url) window.location.href = url;
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function formatPeriodEnd(iso: string | null): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch {
      return iso;
    }
  }

  function planLevel(p: string) {
    return PLAN_ORDER.indexOf(p);
  }

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[2rem] bg-stone-950 px-5 py-7 text-white shadow-xl shadow-stone-900/10 sm:px-8 sm:py-9">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-green-500/20 blur-3xl" aria-hidden="true" />
        <div className="relative max-w-2xl">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-green-300">Planos & Assinatura</p>
          <h1 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">Escolha o ritmo da sua safra.</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-stone-300">Comece com 10 dias grátis e alterne para o plano que acompanha o tamanho da sua operação.</p>
        </div>
      </section>

      {/* Status atual */}
      {(currentPlan !== "free" || ["unpaid", "incomplete", "incomplete_expired", "paused"].includes(status)) && (
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
              {status === "active" && !cancelAtPeriodEnd && currentPeriodEnd && (
                <p className="text-xs text-stone-500">
                  Renova em: {formatPeriodEnd(currentPeriodEnd)}
                </p>
              )}
              {status === "past_due" && (
                <p className="text-sm font-medium text-red-600">
                  Pagamento pendente — atualize seu cartão.
                </p>
              )}
              {status === "unpaid" && (
                <p className="text-sm font-medium text-red-600">
                  Assinatura suspensa por falta de pagamento.
                </p>
              )}
            </div>
            <div className="text-right">
              <div className="mb-2 text-3xl">
                <Leaf />
              </div>
              {(status === "active" || status === "past_due" || ["unpaid", "incomplete", "incomplete_expired", "paused"].includes(status)) && !isCollaborator && (
                <Button
                  variant="subtle"
                  className="!text-xs !text-red-600 hover:!bg-red-50"
                  disabled={busy !== null}
                  onClick={() => void handlePortal()}
                >
                  {busy === "portal" ? "Abrindo..." : cancelAtPeriodEnd ? "Gerenciar" : "Cancelar assinatura"}
                </Button>
              )}
            </div>
          </div>
          {!cancelAtPeriodEnd && status === "active" && (
            <p className="mt-2 text-xs text-stone-500">
              Ao cancelar, você mantém o acesso até o fim do período pago e depois volta ao plano Gratuito.
            </p>
          )}
        </Card>
      )}

      {/* Banner: cancelamento agendado */}
      {cancelAtPeriodEnd && status === "active" && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="font-semibold text-amber-800">
            Sua assinatura será cancelada em {formatPeriodEnd(currentPeriodEnd)}.
          </p>
          <p className="mt-1 text-sm text-amber-700">
            Depois disso você volta para o plano Gratuito. Seus dados serão mantidos (apenas os limites do free passam a valer).
          </p>
          <Button
            variant="subtle"
            className="mt-3 !text-xs"
            disabled={busy !== null}
            onClick={() => void handlePortal()}
          >
            {busy === "portal" ? "Abrindo..." : "Reativar / Gerenciar →"}
          </Button>
        </div>
      )}

      {/* Banner: voltou do Portal */}
      {fromPortal && !cancelAtPeriodEnd && status === "active" && (
        <div className="rounded-2xl bg-blue-50 p-4 text-center">
          <p className="font-semibold text-blue-800">Portal de assinatura</p>
          <p className="text-sm text-blue-700">Suas alterações foram aplicadas. Pode levar alguns segundos.</p>
        </div>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-black text-stone-900">Compare os planos</h2>
          <p className="text-sm text-stone-500">Valores por mês. No anual, você economiza 20%.</p>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-2xl border border-stone-200 bg-white p-1 shadow-sm" role="group" aria-label="Periodicidade de cobrança">
          <button type="button" onClick={() => setBilling("monthly")} className={`min-h-11 rounded-xl px-4 text-sm font-black transition ${billing === "monthly" ? "bg-stone-900 text-white shadow-sm" : "text-stone-500 hover:bg-stone-50"}`} aria-pressed={billing === "monthly"}>Mensal</button>
          <button type="button" onClick={() => setBilling("annual")} className={`min-h-11 rounded-xl px-4 text-sm font-black transition ${billing === "annual" ? "bg-green-700 text-white shadow-sm" : "text-stone-500 hover:bg-stone-50"}`} aria-pressed={billing === "annual"}>Anual <span className="ml-1 text-[10px] text-green-200">-20%</span></button>
        </div>
      </div>

      {/* Planos */}
      <div className="grid gap-5 lg:grid-cols-3">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p.id;
          const canUpgrade = planLevel(currentPlan) < planLevel(p.id);
          const price = billing === "annual" ? p.annualPrice : p.price;
          const period = billing === "annual" ? "/mês (anual)" : "/mês";
          const featured = p.id === "pro";

          return (
            <Card key={p.id} className={`relative flex h-full flex-col !overflow-visible !p-0 ${featured ? "border-green-500 shadow-xl shadow-green-900/10" : ""} ${isCurrent ? "ring-2 ring-green-500 ring-offset-2" : ""}`}>
              {featured && <div className="absolute -top-3 left-5 rounded-full bg-green-700 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white">Mais escolhido</div>}
              {isCurrent && <div className="absolute -right-3 top-4"><Badge tone="green">Atual</Badge></div>}
              <div className="flex h-full flex-col p-5 sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div><h3 className="text-xl font-black text-stone-900">{p.label}</h3><p className="mt-1 text-xs font-semibold text-stone-400">{featured ? "Para a safra em crescimento" : p.id === "basico" ? "Para começar com controle" : "Para operações que escalam"}</p></div>
                  {featured && <span className="rounded-full bg-green-100 p-2 text-green-700"><Leaf /></span>}
                </div>
                <div className="mt-6 flex flex-wrap items-end gap-1"><span className="text-3xl font-black tracking-tight text-stone-950">{price}</span><span className="pb-1 text-sm text-stone-500">{period}</span></div>
                {billing === "annual" && <p className="mt-1 text-xs font-semibold text-green-700">Total anual: {p.annualTotal}</p>}
                <div className="my-5 h-px bg-stone-100" />
                <ul className="flex-1 space-y-3">
                  {p.features.map((f) => <li key={f} className="flex items-start gap-2 text-sm leading-5 text-stone-600"><Check className="mt-0.5 shrink-0 text-green-600" />{f}</li>)}
                  {p.notIncluded.map((f) => <li key={f} className="flex items-start gap-2 text-sm leading-5 text-stone-400"><span className="mt-0.5">—</span>{f}</li>)}
                </ul>
                <div className="mt-7 space-y-2">
                  {!isCurrent && canUpgrade && <><Button onClick={() => handleCheckout(p.id)} disabled={busy !== null} className="w-full">{busy === p.id ? "Aguarde..." : "Assinar agora"}</Button><Button onClick={() => handleStartTrial(p.id)} disabled={busy !== null} className="w-full" variant="subtle">{busy === p.id ? "Aguarde..." : "Testar 10 dias grátis"}</Button></>}
                  {isCurrent && <p className="rounded-xl bg-green-50 py-3 text-center text-sm font-black text-green-700">✓ Seu plano atual</p>}
                  {!isCurrent && !canUpgrade && <p className="rounded-xl bg-stone-50 py-3 text-center text-sm text-stone-400">Plano inferior ao atual</p>}
                </div>
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
