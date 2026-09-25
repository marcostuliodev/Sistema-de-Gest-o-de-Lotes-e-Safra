import { NavLink, Outlet, Navigate, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../store/auth";
import { useProject } from "../store/project";
import { usePlan } from "../store/plan";
import { CloudCheck, CloudOff, Grid, Leaf, Logout, WifiOff, Users } from "../components/icons";
import { Badge } from "../components/ui";
import { useState } from "react";
import { UpgradeModal } from "../components/UpgradeModal";
import { AccountMenu, HamburgerButton } from "../components/AccountMenu";

const PLAN_BADGES: Record<string, { label: string; tone: "gray" | "green" | "blue" | "amber" }> = {
  free: { label: "Free", tone: "gray" },
  basico: { label: "Básico", tone: "green" },
  pro: { label: "Pro", tone: "blue" },
  premium: { label: "Premium", tone: "amber" },
};

const nav: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  { to: "/", label: "Painel", icon: <Grid />, end: true },
  { to: "/plantios", label: "Plantios", icon: <Leaf /> },
  { to: "/lotes", label: "Lotes", icon: <Map /> },
  { to: "/insumos", label: "Insumos", icon: <Grid /> },
  { to: "/gastos", label: "Gastos", icon: <Leaf /> },
  { to: "/ia", label: "AgroIA", icon: <Sparkles /> },
  { to: "/clima", label: "Clima", icon: <Cloud /> },
  { to: "/colaboradores", label: "Colab.", icon: <Users /> },
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

function Sparkles({}: {}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="1em" height="1em">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
      <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7L19 15Z" />
    </svg>
  );
}

function roleLabel(isOwner: boolean, role: string | null): string {
  if (isOwner) return "Proprietário";
  if (role === "admin") return "Administrador";
  if (role === "viewer") return "Visualizador";
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : "Sem papel";
}

export default function Layout() {
  const { session, logout, pendingSync, online, resendVerification, syncError } = useAuth();
  const { projects, activeProject, switchProject, switching } = useProject();
  const { plan, trialRemaining, status, blocked, clockWarning, isCollaborator, loading: planLoading } = usePlan();
  const navigate = useNavigate();
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState("");
  if (!session) {
    return <Navigate to="/login" replace />;
  }

  const synced = pendingSync === 0 && online;
  const planBadge = PLAN_BADGES[plan] || PLAN_BADGES.free;
  const emailVerified = session.user.email_verified !== false;

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

  async function handleResendVerification() {
    if (!session) return;
    setResendBusy(true);
    setResendMsg("");
    try {
      const data = await resendVerification(session.user.email);
      setResendMsg(data.message);
    } catch {
      setResendMsg("Erro ao reenviar.");
    } finally {
      setResendBusy(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Banners — topo absoluto, acima de tudo */}
      {clockWarning && (
        <div className="shrink-0 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-800">
          ⚠️ Possível manipulação de relógio detectada. Verifique a data/hora do seu dispositivo.
        </div>
      )}
      {!emailVerified && (
        <div className="shrink-0 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-800 border-b border-amber-200">
          Seu e-mail não foi confirmado. Verifique sua caixa de entrada ou{" "}
          {resendBusy ? (
            <span>Reenviando...</span>
          ) : resendMsg ? (
            <span>{resendMsg}</span>
          ) : (
            <button onClick={() => void handleResendVerification()} className="underline hover:text-amber-600">
              Reenviar
            </button>
          )}
        </div>
      )}
      {syncError && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-800" role="alert">
          {syncError}
        </div>
      )}
      {!planLoading && !isCollaborator && status === "trial" && trialRemaining >= 0 && trialRemaining <= 3 && (
        <div className="shrink-0 bg-blue-50 px-4 py-2 text-center text-xs font-medium text-blue-800">
          Seu trial termina em {trialRemaining} dia(s).{" "}
          <button onClick={() => navigate("/upgrade")} className="underline hover:text-blue-600">
            Assine agora
          </button>
        </div>
      )}

      <header className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-3 py-2 lg:px-4">
        <HamburgerButton onClick={() => setMenuOpen(true)} />
        <div className="flex items-center gap-2 lg:hidden">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-green-700 text-white">
            <Leaf />
          </div>
          <span className="hidden text-sm font-extrabold text-stone-800 sm:inline">Agrolote</span>
        </div>
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <div className="min-w-0 max-w-[10rem] flex-1 sm:w-52 sm:max-w-none sm:flex-none">
            <label htmlFor="active-project" className="sr-only">Projeto ativo</label>
            <select
              id="active-project"
              value={activeProject?.id || ""}
              onChange={(event) => void switchProject(event.target.value)}
              disabled={switching}
              className="h-9 w-full min-w-0 rounded-lg border border-stone-200 bg-stone-50 px-2 text-xs font-semibold text-stone-700 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100 disabled:opacity-60"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name || project.nome} · {roleLabel(project.isOwner, project.role)}
                </option>
              ))}
            </select>
            <p className="mt-0.5 truncate px-0.5 text-[10px] text-stone-400">
              {activeProject ? roleLabel(activeProject.isOwner, activeProject.role) : "Carregando..."}
            </p>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            {planLoading ? null : isCollaborator ? (
              <Badge tone="green">Colaborador</Badge>
            ) : (
              <>
                <Badge tone={planBadge.tone}>{planBadge.label}</Badge>
                {status === "trial" && trialRemaining >= 0 && (
                  <span className="hidden text-xs text-stone-400 lg:inline">Trial {trialRemaining}d</span>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      {/* Conteúdo principal */}
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
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
          {/* Plano badge + upgrade (oculto enquanto carrega e para colaboradores) */}
          {!planLoading && !isCollaborator && (
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
          )}
          {!planLoading && isCollaborator && (
            <div className="flex w-full items-center gap-2 rounded-xl bg-stone-50 px-3 py-2 text-xs font-medium text-stone-600">
              <Badge tone="green">Colaborador</Badge>
            </div>
          )}
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
             <button onClick={() => void logout()} title="Sair" className="flex h-11 w-11 items-center justify-center rounded-lg text-stone-400 hover:bg-red-50 hover:text-red-600">
              <Logout />
            </button>
          </div>
        </div>
      </aside>

      {/* Coluna de conteúdo + menu (mobile) / conteúdo (desktop) */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 sm:px-6">
            <Outlet />
          </div>
        </main>

        {/* Barra de navegação inferior (mobile) — em fluxo, nunca cobre o conteúdo */}
        <nav className="border-t border-stone-200 bg-white/95 backdrop-blur pb-safe-nav lg:hidden">
          <div className="grid grid-cols-6 px-1 py-1">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-xs font-medium active:bg-stone-100 ${
                    isActive ? "text-green-700" : "text-stone-400"
                  }`
                }
              >
                <span className="text-xs leading-none">{item.icon}</span>
                <span className="w-full truncate text-center leading-none">{item.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>
      </div>

      {!planLoading && !isCollaborator && (
        <UpgradeModal open={showUpgrade} onClose={() => setShowUpgrade(false)} />
      )}
      <AccountMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
      </div>
    </div>
  );
}
