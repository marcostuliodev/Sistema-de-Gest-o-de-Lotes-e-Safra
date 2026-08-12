import { type ReactNode, type FormEvent } from "react";
import { X } from "./icons";

export function Button({ children, onClick, type = "button", variant = "primary", disabled, className = "", title }: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "danger" | "subtle";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const styles = {
    primary: "bg-green-700 text-white hover:bg-green-800 disabled:bg-green-700/40 shadow-sm",
    ghost: "text-stone-600 hover:bg-stone-200/70",
    danger: "bg-red-50 text-red-700 hover:bg-red-100",
    subtle: "bg-white text-stone-700 border border-stone-300 hover:bg-stone-50",
  }[variant];
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children, required, hint }: { label: string; children: ReactNode; required?: boolean; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-400">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-stone-400 focus:border-green-600 focus:ring-2 focus:ring-green-500/30";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Modal({ open, onClose, title, children, wide }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold text-stone-800">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600" aria-label="Fechar">
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Badge({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "amber" | "red" | "gray" | "blue" }) {
  const tones = {
    green: "bg-green-100 text-green-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-700",
    gray: "bg-stone-200 text-stone-700",
    blue: "bg-blue-100 text-blue-800",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tones}`}>{children}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-stone-200 bg-white p-5 shadow-sm ${className}`}>{children}</div>;
}

export function StatCard({ label, value, accent, sub }: { label: string; value: ReactNode; accent: "green" | "red" | "amber" | "stone"; sub?: ReactNode }) {
  const color = {
    green: "text-green-700",
    red: "text-red-600",
    amber: "text-amber-600",
    stone: "text-stone-800",
  }[accent];
  return (
    <Card>
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-stone-400">{sub}</p>}
    </Card>
  );
}

export function EmptyState({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-white px-6 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl">🌱</div>
      <p className="font-semibold text-stone-700">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-stone-400">{subtitle}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Money({ value }: { value: number }) {
  return <span className="tabular-nums">{value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>;
}

export function formDateValue(iso?: string | null) {
  return iso ? iso.slice(0, 10) : "";
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function currencyToNumber(raw: string | number | undefined): number {
  if (typeof raw === "number") return raw;
  if (!raw) return 0;
  const n = parseFloat(String(raw).replace(/\./g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
}

export function Form({ onSubmit, children }: { onSubmit: (e: FormEvent) => void; children: ReactNode }) {
  return <form onSubmit={onSubmit} className="space-y-4">{children}</form>;
}