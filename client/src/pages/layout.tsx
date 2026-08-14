import { NavLink, Outlet, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../store/auth";
import { Chart, CloudCheck, CloudOff, Grid, Leaf, Logout, Basket, Box, WifiOff } from "../components/icons";

const nav: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  { to: "/", label: "Painel", icon: <Grid />, end: true },
  { to: "/lotes", label: "Lotes", icon: <Map /> },
  { to: "/plantios", label: "Plantios", icon: <Leaf /> },
  { to: "/insumos", label: "Insumos", icon: <Box /> },
  { to: "/gastos", label: "Gastos", icon: <Chart /> },
  { to: "/colheitas", label: "Colheitas", icon: <Basket /> },
  { to: "/relatorios", label: "Relatórios", icon: <Chart /> },
  { to: "/clima", label: "Clima", icon: <Cloud /> },
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
  const navigate = useNavigate();
  if (!session) {
    navigate("/login");
    return null;
  }

  const synced = pendingSync === 0 && online;

  return (
    <div className="flex min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-stone-200 bg-white lg:flex">
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

      {/* Barra de navegação inferior (mobile) */}
      <div className="fixed inset-x-0 bottom-0 z-40 overflow-x-hidden border-t border-stone-200 bg-white/95 backdrop-blur pb-safe-nav lg:hidden">
        <div className="grid grid-cols-8 px-1 py-1">
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
      </div>

      <main className="min-h-dvh flex-1 pb-safe pt-safe lg:ml-60 lg:pb-6 lg:pt-0">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}