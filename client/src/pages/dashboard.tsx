import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router-dom";
import { db } from "../db/db";
import { Badge, Card, Money, StatCard } from "../components/ui";
import { Warning } from "../components/icons";

const st = (p: { status: string }) =>
  ({ planejado: ["Planejado", "blue"], ativo: ["Em campo", "green"], colhido: ["Colhido", "gray"], perdido: ["Perdido", "red"] })[p.status] as any;

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function localDateTime(value?: string | null): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

function daysUntil(iso?: string | null) {
  const time = localDateTime(iso);
  if (time === null) return null;
  const target = new Date(time);
  const today = new Date();
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((targetDay - todayDay) / 864e5);
}

export default function Dashboard() {
  const plantios = useLiveQuery(() => db.plantios.toArray(), []);
  const lotes = useLiveQuery(() => db.lotes.toArray(), []);
  const gastos = useLiveQuery(() => db.gastos.toArray(), []);
  const colheitas = useLiveQuery(() => db.colheitas.toArray(), []);

  const active = (plantios ?? []).filter((p) => p.status !== "colhido" && p.status !== "perdido");
  const custoTotal = (gastos ?? []).reduce((s, g) => s + numeric(g.quantidade) * numeric(g.valor_unitario), 0);
  const receitaTotal = (colheitas ?? []).reduce((s, c) => s + numeric(c.quantidade) * numeric(c.preco_venda), 0);
  const lucro = receitaTotal - custoTotal;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthAgo = todayStart - 30 * 864e5;
  const isAfterMonthAgo = (value?: string | null) => {
    const time = localDateTime(value);
    return time !== null && time > monthAgo;
  };
  const isUpcoming = (value?: string | null) => {
    const time = localDateTime(value);
    return time !== null && time >= todayStart;
  };
  const isOverdue = (value?: string | null) => {
    const time = localDateTime(value);
    return time !== null && time < todayStart;
  };

  const custo30 = (gastos ?? []).filter((g) => isAfterMonthAgo(g.data)).reduce((s, g) => s + numeric(g.quantidade) * numeric(g.valor_unitario), 0);
  const receita30 = (colheitas ?? []).filter((c) => isAfterMonthAgo(c.data)).reduce((s, c) => s + numeric(c.quantidade) * numeric(c.preco_venda), 0);

  const upcoming = (plantios ?? [])
    .filter((p) => (p.status === "ativo" || p.status === "planejado") && isUpcoming(p.data_colheita_prevista))
    .sort((a, b) => (localDateTime(a.data_colheita_prevista) ?? 0) - (localDateTime(b.data_colheita_prevista) ?? 0))
    .slice(0, 8);
  const attAntigas = (plantios ?? [])
    .filter((p) => p.status === "ativo" && isOverdue(p.data_colheita_prevista))
    .sort((a, b) => (localDateTime(a.data_colheita_prevista) ?? 0) - (localDateTime(b.data_colheita_prevista) ?? 0));

  const loteNome = (id: string) => (lotes ?? []).find((l) => l.id === id)?.nome ?? "—";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-stone-800">Painel da safra</h1>
        <p className="text-sm text-stone-500">Visão geral de lotes, plantios ativos e financeiro.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Plantios ativos" value={String(active.length)} accent="green" sub={`${(lotes ?? []).length} lotes/bancadas`} />
        <StatCard label="Custo total" value={<Money value={custoTotal} />} accent="stone" sub={`${custo30.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} nos últimos 30 dias`} />
        <StatCard label="Receita" value={<Money value={receitaTotal} />} accent={lucro >= 0 ? "amber" : "red"} sub={`${receita30.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} nos últimos 30 dias`} />
        <StatCard label="Lucro" value={<Money value={lucro} />} accent={lucro >= 0 ? "green" : "red"} />
      </div>

      {attAntigas.length > 0 && (
        <Card className="border-amber-300 bg-amber-50">
          <div className="flex flex-wrap items-center gap-2 font-semibold text-amber-800">
            <Warning /> {attAntigas.length} colheita(s) previsão vencida
          </div>
          <ul className="mt-2 space-y-1 text-sm text-amber-700">
            {attAntigas.slice(0, 4).map((p) => (
              <li key={p.id}>
                {p.cultura} · {loteNome(p.lote_id)} — deveria ser hoje ou ontem ({(daysUntil(p.data_colheita_prevista) ?? 0) * -1}d atraso)
              </li>
            ))}
          </ul>
          <Link to="/plantios" className="mt-2 inline-block text-sm font-medium text-amber-800 underline">Atualizar plantios →</Link>
        </Card>
      )}

      <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-stone-800">Próximas colheitas</h2>
          <Link to="/colheitas" className="text-sm font-medium text-green-700 hover:underline">Registrar colheita</Link>
        </div>
        {upcoming.length === 0 ? (
          <p className="py-6 text-center text-sm text-stone-400">Nenhuma colheita prevista. Cadastre um plantio com data prevista.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {upcoming.map((p) => {
              const d = daysUntil(p.data_colheita_prevista);
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-stone-800">
                      {p.cultura} {p.cultivar && <span className="text-stone-400">· {p.cultivar}</span>}
                    </p>
                    <p className="truncate text-xs text-stone-400">{loteNome(p.lote_id)} · plantado em {p.data_plantio}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {d !== null && d > 7 && <Badge tone="gray">em {d}d</Badge>}
                    {d !== null && d <= 7 && d >= 0 && <Badge tone="amber">em até {d}d</Badge>}
                    {d !== null && d < 0 && <Badge tone="red">vencido</Badge>}
                    <Badge tone={st(p)[1]}>{st(p)[0]}</Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}