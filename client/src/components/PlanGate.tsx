/**
 * PlanGate — Componente que bloqueia funcionalidades por plano.
 *
 * Se o usuário não tem acesso, renderiza um CTA de upgrade
 * em vez do conteúdo protegido.
 */

import type { ReactNode } from "react";
import { usePlan, type PlanFeatures } from "../store/plan";
import { Button } from "./ui";
import { useNavigate } from "react-router-dom";

interface PlanGateProps {
  /** Feature a verificar. Se null, usa children sem gate. */
  feature?: keyof PlanFeatures;
  /** Plano mínimo necessário (se não usar feature). */
  minPlan?: string;
  /** Conteúdo a renderizar se tiver acesso. */
  children: ReactNode;
  /** Conteúdo alternativo quando bloqueado. Se não fornecido, mostra CTA padrão. */
  fallback?: ReactNode;
  /** Título do card de bloqueio. */
  blockedTitle?: string;
  /** Descrição do card de bloqueio. */
  blockedDescription?: string;
}

const PLAN_ORDER = ["free", "basico", "pro", "premium"];

function planLevel(plan: string): number {
  const idx = PLAN_ORDER.indexOf(plan);
  return idx >= 0 ? idx : 0;
}

export function PlanGate({
  feature,
  minPlan,
  children,
  fallback,
  blockedTitle,
  blockedDescription,
}: PlanGateProps) {
  const { plan, features, loading, isCollaborator } = usePlan();
  const navigate = useNavigate();

  if (loading) {
    return <p className="text-sm text-stone-400">Carregando...</p>;
  }

  // Verifica por feature específica
  if (feature) {
    if (features[feature] === true) return <>{children}</>;
    if (typeof features[feature] === "number" && features[feature] > 0) return <>{children}</>;
  }

  // Verifica por plano mínimo
  if (minPlan && planLevel(plan) >= planLevel(minPlan)) {
    return <>{children}</>;
  }

  // Sem nenhuma condição atendida — bloqueia
  if (!feature && !minPlan) return <>{children}</>;

  // Colaborador: recurso definido pelo proprietário, sem CTA de upgrade.
  // Verificado ANTES do fallback para nunca exibir "Ver planos" a colaboradores.
  if (isCollaborator) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-stone-50 px-6 py-12 text-center">
        <div className="mb-3 text-4xl">🔒</div>
        <p className="font-semibold text-stone-700">
          {blockedTitle || "Recurso definido pelo proprietário da conta"}
        </p>
        <p className="mt-1 max-w-sm text-sm text-stone-500">
          {blockedDescription || "Este recurso é gerenciado pelo proprietário da conta."}
        </p>
      </div>
    );
  }

  // Bloqueado — renderiza fallback ou CTA padrão
  if (fallback) return <>{fallback}</>;

  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-amber-300 bg-amber-50/50 px-6 py-12 text-center">
      <div className="mb-3 text-4xl">🔒</div>
      <p className="font-semibold text-stone-700">
        {blockedTitle || "Recurso disponível em planos superiores"}
      </p>
      <p className="mt-1 max-w-sm text-sm text-stone-500">
        {blockedDescription || "Faça upgrade do seu plano para acessar esta funcionalidade."}
      </p>
      <Button onClick={() => navigate("/upgrade")} className="mt-4">
        Ver planos
      </Button>
    </div>
  );
}
