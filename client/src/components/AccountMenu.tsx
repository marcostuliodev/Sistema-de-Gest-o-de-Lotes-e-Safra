/**
 * Menu lateral sanduíche (drawer) — conta, verificação de e-mail,
 * plano, atalhos, sincronização e sair.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../store/auth";
import { usePlan } from "../store/plan";
import { Badge, Button } from "./ui";
import {
  Chart,
  CloudCheck,
  CloudOff,
  Grid,
  Leaf,
  Logout,
  Mail,
  Users,
  WifiOff,
  X,
} from "./icons";

const PLAN_BADGES: Record<string, { label: string; tone: "gray" | "green" | "blue" | "amber" }> = {
  free: { label: "Free", tone: "gray" },
  basico: { label: "Básico", tone: "green" },
  pro: { label: "Pro", tone: "blue" },
  premium: { label: "Premium", tone: "amber" },
};

const SHORTCUTS: { to: string; label: string; icon: React.ReactNode }[] = [
  { to: "/", label: "Painel", icon: <Grid /> },
  { to: "/relatorios", label: "Relatórios", icon: <Chart /> },
  { to: "/analytics", label: "Analytics", icon: <Chart /> },
  { to: "/historico", label: "Histórico", icon: <Chart /> },
  { to: "/upgrade", label: "Planos & Upgrade", icon: <Leaf /> },
  { to: "/colaboradores", label: "Colaboradores", icon: <Users /> },
];

function MenuIcon({}: {}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="1em" height="1em">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function HamburgerButton({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Abrir menu da conta"
      className={`flex h-9 w-9 items-center justify-center rounded-xl text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-800 ${className}`}
    >
      <span className="text-xl">
        <MenuIcon />
      </span>
    </button>
  );
}

interface AccountMenuProps {
  open: boolean;
  onClose: () => void;
}

export function AccountMenu({ open, onClose }: AccountMenuProps) {
  const { session, logout, pendingSync, online, resendVerification } = useAuth();
  const { plan, features, status, trialRemaining } = usePlan();
  const navigate = useNavigate();
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !session) return null;

  const emailVerified = session.user.email_verified !== false;
  const planBadge = PLAN_BADGES[plan] || PLAN_BADGES.free;
  const synced = pendingSync === 0 && online;
  const initials = (session.user.name || session.user.email || "?")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function handleResend() {
    setResendBusy(true);
    setResendMsg("");
    try {
      const data = await resendVerification(session!.user.email);
      setResendMsg(data.message);
    } catch {
      setResendMsg("Erro ao reenviar.");
    } finally {
      setResendBusy(false);
    }
  }

  function go(path: string) {
    onClose();
    navigate(path);
  }

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Menu da conta">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Painel — esquerda */}
      <div className="absolute inset-y-0 left-0 flex w-[300px] max-w-[88vw] flex-col overflow-y-auto bg-white shadow-2xl">
        {/* Cabeçalho */}
        <div className="flex items-start justify-between gap-2 border-b border-stone-200 bg-gradient-to-br from-green-700 to-emerald-700 px-4 py-5 text-white">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-bold">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{session.user.name}</p>
              <p className="truncate text-xs text-green-100">{session.user.email}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar menu"
            className="rounded-lg p-1.5 text-white/80 hover:bg-white/15 hover:text-white"
          >
            <X />
          </button>
        </div>

        <div className="flex-1 space-y-5 px-4 py-4">
          {/* ── Conta / Verificação ── */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-400">Conta</h3>
            {emailVerified ? (
              <div className="flex items-center gap-2 rounded-xl bg-green-50 px-3 py-2.5 text-sm text-green-800">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-600 text-xs text-white">✓</span>
                E-mail verificado
              </div>
            ) : (
              <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-800">
                  <Mail />
                  E-mail não verificado
                </div>
                <p className="text-xs text-amber-700">
                  Confirme seu e-mail para garantir o acesso à conta.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="subtle"
                    className="!text-xs"
                    disabled={resendBusy}
                    onClick={() => void handleResend()}
                  >
                    {resendBusy ? "Enviando…" : resendMsg || "Reenviar e-mail"}
                  </Button>
                  <Button
                    className="!text-xs"
                    onClick={() => go("/verify-email")}
                  >
                    Verificar agora
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* ── Plano ── */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-400">Plano</h3>
            <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={planBadge.tone}>{planBadge.label}</Badge>
                  {status === "trial" && (
                    <Badge tone="blue">
                      Trial{trialRemaining >= 0 ? ` ${trialRemaining}d` : ""}
                    </Badge>
                  )}
                </div>
                <button
                  onClick={() => go("/upgrade")}
                  className="text-xs font-semibold text-green-700 underline-offset-2 hover:underline"
                >
                  Gerenciar →
                </button>
              </div>
              <ul className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-stone-600">
                <li>Lotes: {features.maxLotes === 0 ? "—" : features.maxLotes}</li>
                <li>Plantios: {features.maxPlantios}</li>
                <li>Fotos: {features.maxFotos >= 10000 ? "∞" : features.maxFotos}</li>
                <li>Colab.: {features.maxColaboradores}</li>
                <li>IA/dia: {features.maxIaDia >= 10000 ? "∞" : features.maxIaDia}</li>
                <li>Clima: {features.climaAlertas ? "✔" : "—"}</li>
              </ul>
              {plan === "free" && (
                <Button className="w-full !text-xs" onClick={() => go("/upgrade")}>
                  Fazer upgrade
                </Button>
              )}
            </div>
          </section>

          {/* ── Atalhos ── */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-400">Atalhos</h3>
            <div className="space-y-1">
              {SHORTCUTS.map((s) => (
                <button
                  key={s.to}
                  onClick={() => go(s.to)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100"
                >
                  <span className="text-lg text-stone-500">{s.icon}</span>
                  {s.label}
                </button>
              ))}
            </div>
          </section>

          {/* ── Sincronização ── */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-400">Status</h3>
            <div
              className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium ${
                online
                  ? synced
                    ? "bg-green-50 text-green-700"
                    : "bg-amber-50 text-amber-700"
                  : "bg-stone-100 text-stone-500"
              }`}
              title={
                synced
                  ? "Dados sincronizados"
                  : online
                    ? `${pendingSync} alteração(ões) aguardando envio`
                    : "Offline — dados salvos no aparelho"
              }
            >
              {online ? synced ? <CloudCheck /> : <CloudOff /> : <WifiOff />}
              {online
                ? synced
                  ? "Sincronizado"
                  : `Sincronizando (${pendingSync})`
                : "Offline (salvo localmente)"}
            </div>
          </section>
        </div>

        {/* Rodapé — sair */}
        <div className="border-t border-stone-200 p-4">
          <button
            onClick={() => {
              onClose();
              logout();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100"
          >
            <Logout />
            Sair da conta
          </button>
        </div>
      </div>
    </div>
  );
}
