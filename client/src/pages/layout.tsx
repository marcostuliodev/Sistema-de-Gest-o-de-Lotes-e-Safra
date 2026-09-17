import { NavLink, Outlet, Navigate, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../store/auth";
import { usePlan } from "../store/plan";
import { Chart, CloudCheck, CloudOff, Grid, Leaf, Logout, Basket, Box, WifiOff, Users } from "../components/icons";
import { Badge } from "../components/ui";
import { useState } from "react";
import { UpgradeModal } from "../components/UpgradeModal";

const PLAN_BADGES: Record<string, { label: string; tone: "gray" | "green" | "blue" | "amber" }> = {
  free: { label: "Free", tone: "gray" },
  basico: { label: "Básico", tone: "green" },
  pro: { label: "Pro", tone: "blue" },
  premium: { label: "Premium", tone: "amber" },
};

const nav: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  { to: "/", label: "Painel", icon: <Grid />, end: true },
  { to: "/lotes", label: "Lotes", icon: <Map /> },
  { to: "/plantios", label: "Plantios", icon: <Leaf /> },
  { to: "/insumos", label: "Insumos", icon: <Box /> },
  { to: "/gastos", label: "Gastos", icon: <Chart /> },
  { to: "/colheitas", label: "Colheitas", icon: <Basket /> },
  { to: "/relatorios", label: "Relatórios", icon: <Chart /> },
  { to: "/clima", label: "Clima", icon: <Cloud /> },
  { to: "/colaboradores", label: "Colaboradores", icon: <Users /> },
];

function Map({}: {}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="1em" height="1em">
      <path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3ZM9 7v13M15 4v13" />
    </svg>
  );
}

function Cloud({}: {}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="1em" height="1em">
      <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 6.5 19h11Z" />
      <path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2" />
    </svg>
  );
}

export default function Layout() {
  const { session, logout, pendingSync, online } = useAuth();
  const { plan, trialRemaining, status, blocked, clockWarning } = usePlan();
  const navigate = useNavigate();
  const [showUpgrade, setShowUpgrade] = useState(false);
  if (!session) {
    return <Navigate to="/login" replace />;
  }

  const synced = pendingSync === 0 && online;
  const planBadge = PLAN_BADGES[plan] || PLAN_BADGES.free;

  // Bloqueio de integridade
  if (blocked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-red-50 p-4">
        <div className="max-w-md text-center">
          <div className="mb-4 text-6xl">🚫</div>
          <h1 className="text-xl font-bold text-red-800">Acesso Bloqueado</h1>
          <p className="mt-2 text-sm text-red-600">
            Detectamos atividade suspeita nesta conta. Se você acha que isso é um erro, entre em contato com o suporte.
          </p>
          <button onClick={logout} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
            Sair
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
      {/* Clock warning banner */}
      {clockWarning && (
        <div className="bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-800">
          ⚠️ Possível manipulação de relógio detectada. Verifique a data/hora do seu dispositivo.
        </div>
      )}

      {/* Trial expiring soon banner */}
      {status === "trial" && trialRemaining >= 0 && trialRemaining <= 3 && (
        <div className="bg-blue-50 px-4 py-2 text-center text-xs font-medium text-blue-800">
          Seu trial termina em {trialRemaining} dia(s).{" "}
          <button onClick={() => navigate("/upgrade")} className="underline hover:text-blue-600">
            Assine agora
          </button>
        </div>
      )}

      {/* Sidebar (somente desktop) */}
      <aside className="hidden lg:flex lg:w-60 lg:flex-col lg:border-r lg:border-stone-200 lg:bg-white">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-700 text-white">
            <Leaf />
          </div>
          <div>
            <p className="text-base font-extrabold leading-tight text-stone-800">Agrolote</p>
            <p className="text-[11px] text-stone-400">Lotes & Safra</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive ? "bg-green-700 text-white shadow-sm" : "text-stone-600 hover:bg-stone-100"
                }`
              }
            >
              <span className="text-lg">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t border-stone-200 p-4">
          {/* Plano badge + upgrade */}
          <button
            onClick={() => plan === "free" ? navigate("/upgrade") : setShowUpgrade(true)}
            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
              plan === "free"
                ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                : "bg-stone-50 text-stone-600 hover:bg-stone-100"
            }`}
          >
            <Badge tone={planBadge.tone}>{planBadge.label}</Badge>
            {plan === "free" && <span className="ml-auto text-[10px]">Upgrade →</span>}
          </button>
          <div
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium ${
              online ? (synced ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700") : "bg-stone-100 text-stone-500"
            }`}
            title={synced ? "Dados sincronizados" : online ? `${pendingSync} alteração(ões) aguardando envio` : "Offline — dados salvos no aparelho"}
          >
            {online ? (synced ? <CloudCheck /> : <CloudOff />) : <WifiOff />}
            {online ? (synced ? "Sincronizado" : `Sincronizando (${pendingSync})`) : "Offline (salvo localmente)"}
          </div>
          <div className="flex items-center justify-between gap-2 px-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-stone-700">{session.user.name}</p>
              <p className="truncate text-xs text-stone-400">{session.user.email}</p>
            </div>
            <button onClick={logout} title="Sair" className="rounded-lg p-2 text-stone-400 hover:bg-red-50 hover:text-red-600">
              <Logout />
            </button>
          </div>
        </div>
      </aside>

      {/* Coluna de conteúdo + menu (mobile) / conteúdo (desktop) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <Outlet />
          </div>
        </main>

        {/* Barra de navegação inferior (mobile) — em fluxo, nunca cobre o conteúdo */}
        <nav className="border-t border-stone-200 bg-white/95 backdrop-blur pb-safe-nav lg:hidden">
          <div className="grid grid-cols-9 px-1 py-1">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex min-w-0 flex-col items-center gap-0.5 rounded-lg py-2.5 text-[10px] font-medium active:bg-stone-100 ${
                    isActive ? "text-green-700" : "text-stone-400"
                  }`
                }
              >
                <span className="text-lg leading-none">{item.icon}</span>
                <span className="w-full break-words text-center leading-none">{item.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>
      </div>

      <UpgradeModal open={showUpgrade} onClose={() => setShowUpgrade(false)} />
    </div>
  );
}
