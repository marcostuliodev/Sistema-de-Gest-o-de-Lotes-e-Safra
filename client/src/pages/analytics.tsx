import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/db";
import { Card, Money, StatCard } from "../components/ui";
import { PlanGate } from "../components/PlanGate";
import { areaM2, formatAreaM2, numericAreaM2 } from "../lib/area";

const MONTHS_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function monthKey(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(key: string) {
  const [, m] = key.split("-");
  return `${MONTHS_PT[parseInt(m, 10) - 1]}`;
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export default function Analytics() {
  return (
    <PlanGate
      feature="relatoriosAvancados"
      permission="reports.read"
      blockedTitle="Analytics avançado"
      blockedDescription="Faça upgrade para o plano Básico ou superior para acessar gráficos e métricas detalhadas."
    >
      <AnalyticsContent />
    </PlanGate>
  );
}

function AnalyticsContent() {
  const plantios = useLiveQuery(() => db.plantios.toArray(), []);
  const lotes = useLiveQuery(() => db.lotes.toArray(), []);
  const gastos = useLiveQuery(() => db.gastos.toArray(), []);
  const colheitas = useLiveQuery(() => db.colheitas.toArray(), []);

  const custoDe = (pid: string) =>
    (gastos ?? []).filter((g) => g.plantio_id === pid).reduce((s, g) => s + numeric(g.quantidade) * numeric(g.valor_unitario), 0);
  const receitaDe = (pid: string) =>
    (colheitas ?? []).filter((c) => c.plantio_id === pid).reduce((s, c) => s + numeric(c.quantidade) * numeric(c.preco_venda), 0);

  /* ── Cost vs Revenue per month (last 6 months) ── */
  const monthlyData = useMemo(() => {
    const map: Record<string, { custo: number; receita: number }> = {};

    for (const g of gastos ?? []) {
      const key = monthKey(g.data);
      if (!key) continue;
      if (!map[key]) map[key] = { custo: 0, receita: 0 };
      map[key].custo += numeric(g.quantidade) * numeric(g.valor_unitario);
    }
    for (const c of colheitas ?? []) {
      const key = monthKey(c.data);
      if (!key) continue;
      if (!map[key]) map[key] = { custo: 0, receita: 0 };
      map[key].receita += numeric(c.quantidade) * numeric(c.preco_venda);
    }

    const keys = Object.keys(map).sort().slice(-6);
    return keys.map((k) => ({ month: monthLabel(k), key: k, ...map[k] }));
  }, [gastos, colheitas]);

  const maxBar = Math.max(1, ...monthlyData.map((d) => Math.max(d.custo, d.receita)));

  /* ── Crop performance ranking ── */
  const culturaRows = useMemo(() => {
    const perCultura: Record<string, { custo: number; receita: number; plantios: number }> = {};
    for (const p of plantios ?? []) {
      const row = (perCultura[p.cultura] ??= { custo: 0, receita: 0, plantios: 0 });
      row.custo += custoDe(p.id);
      row.receita += receitaDe(p.id);
      row.plantios += 1;
    }
    return Object.entries(perCultura)
      .map(([cultura, v]) => ({
        cultura,
        ...v,
        lucro: v.receita - v.custo,
        margem: v.receita > 0 ? ((v.receita - v.custo) / v.receita) * 100 : 0,
      }))
      .sort((a, b) => b.receita - a.receita);
  }, [plantios, gastos, colheitas]);

  const maxReceita = Math.max(1, ...culturaRows.map((r) => r.receita));

  /* ── Lot productivity ── */
  const loteRows = useMemo(() => {
    return (lotes ?? []).map((l) => {
      const pids = (plantios ?? []).filter((p) => p.lote_id === l.id);
      const custo = pids.reduce((s, p) => s + custoDe(p.id), 0);
      const receita = pids.reduce((s, p) => s + receitaDe(p.id), 0);
      return {
        id: l.id,
        nome: l.nome,
        area_m2: areaM2(l),
        plantios: pids.length,
        custo,
        receita,
        lucro: receita - custo,
      };
    });
  }, [lotes, plantios, gastos, colheitas]);

  /* ── Cumulative profit trend (monthly) ── */
  const trendPoints = useMemo(() => {
    const map: Record<string, number> = {};
    for (const g of gastos ?? []) {
      const key = monthKey(g.data);
      if (!key) continue;
      map[key] = (map[key] ?? 0) - numeric(g.quantidade) * numeric(g.valor_unitario);
    }
    for (const c of colheitas ?? []) {
      const key = monthKey(c.data);
      if (!key) continue;
      map[key] = (map[key] ?? 0) + numeric(c.quantidade) * numeric(c.preco_venda);
    }
    const keys = Object.keys(map).sort();
    let cumulative = 0;
    return keys.map((k) => {
      cumulative += map[k];
      return { month: monthLabel(k), key: k, value: cumulative };
    });
  }, [gastos, colheitas]);

  /* ── Key metrics ── */
  const custoTotal = (gastos ?? []).reduce((s, g) => s + numeric(g.quantidade) * numeric(g.valor_unitario), 0);
  const receitaTotal = (colheitas ?? []).reduce((s, c) => s + numeric(c.quantidade) * numeric(c.preco_venda), 0);
  const lucroTotal = receitaTotal - custoTotal;
  const roi = custoTotal > 0 ? ((receitaTotal - custoTotal) / custoTotal) * 100 : 0;
  const avgReceita = (plantios ?? []).length > 0 ? receitaTotal / (plantios ?? []).length : 0;
  const totalArea = (lotes ?? []).reduce((s, l) => s + numericAreaM2(l), 0);
  const bestCrop = culturaRows.length > 0 ? culturaRows.reduce((best, r) => (r.lucro > best.lucro ? r : best), culturaRows[0]) : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-stone-800">Analytics</h1>
        <p className="text-sm text-stone-500">Visualize métricas financeiras e desempenho da safra.</p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="ROI" value={`${roi.toFixed(1)}%`} accent={roi >= 0 ? "green" : "red"} sub="(receita - custo) / custo" />
        <StatCard label="Receita média/plantio" value={<Money value={avgReceita} />} accent="amber" />
        <StatCard
          label="Cultura mais lucrativa"
          value={bestCrop ? bestCrop.cultura : "—"}
          accent="green"
          sub={bestCrop ? <Money value={bestCrop.lucro} /> : undefined}
        />
        <StatCard label="Área cultivada" value={formatAreaM2({ area_m2: totalArea })} accent="stone" sub={`${(lotes ?? []).length} lotes`} />
      </div>

      {/* Cost vs Revenue Bar Chart */}
      <Card>
        <h2 className="mb-4 font-bold text-stone-800">Custo vs Receita (mensal)</h2>
        {monthlyData.length === 0 ? (
          <p className="py-8 text-center text-sm text-stone-400">Sem dados financeiros para exibir.</p>
        ) : (
          <div className="flex items-end gap-2 h-48 px-1">
            {monthlyData.map((d, i) => (
              <div key={i} className="flex flex-col items-center flex-1 min-w-0">
                <div className="flex w-full gap-0.5 items-end h-full">
                  <div
                    className="flex-1 bg-red-300 rounded-t transition-all"
                    style={{ height: `${(d.custo / maxBar) * 100}%` }}
                    title={`Custo: R$ ${d.custo.toFixed(2)}`}
                  />
                  <div
                    className="flex-1 bg-green-500 rounded-t transition-all"
                    style={{ height: `${(d.receita / maxBar) * 100}%` }}
                    title={`Receita: R$ ${d.receita.toFixed(2)}`}
                  />
                </div>
                <span className="text-[10px] text-stone-400 mt-1.5 whitespace-nowrap">{d.month}</span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-4 justify-center text-xs text-stone-500">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded bg-red-300" /> Custo</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded bg-green-500" /> Receita</span>
        </div>
      </Card>

      {/* Crop Performance Ranking */}
      <Card>
        <h2 className="mb-4 font-bold text-stone-800">Ranking por cultura</h2>
        {culturaRows.length === 0 ? (
          <p className="py-8 text-center text-sm text-stone-400">Cadastre plantios para ver o ranking.</p>
        ) : (
          <div className="space-y-3">
            {culturaRows.map((r, i) => (
              <div key={r.cultura}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-stone-700">
                    {i + 1}. {r.cultura}
                  </span>
                  <span className={`shrink-0 text-xs font-semibold ${r.lucro >= 0 ? "text-green-700" : "text-red-600"}`}>
                    <Money value={r.lucro} /> <span className="text-stone-400 font-normal">({r.margem.toFixed(1)}%)</span>
                  </span>
                </div>
                <div className="flex items-end gap-0.5 h-5 overflow-hidden">
                  <div
                    className="bg-green-400 rounded-l transition-all"
                    style={{ width: `${(r.receita / maxReceita) * 100}%` }}
                    title={`Receita: R$ ${r.receita.toFixed(2)}`}
                  />
                  <div
                    className="bg-red-300 rounded-r transition-all"
                    style={{ width: `${(r.custo / maxReceita) * 100}%` }}
                    title={`Custo: R$ ${r.custo.toFixed(2)}`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-4 text-xs text-stone-500">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded bg-green-400" /> Receita</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded bg-red-300" /> Custo</span>
        </div>
      </Card>

      {/* Lot Productivity Map */}
      <Card>
        <h2 className="mb-4 font-bold text-stone-800">Produtividade por lote</h2>
        {loteRows.length === 0 ? (
          <p className="py-8 text-center text-sm text-stone-400">Cadastre lotes para ver a produtividade.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {loteRows.map((l) => (
              <div
                key={l.id}
                className={`rounded-xl border p-4 transition-colors ${
                  l.lucro > 0
                    ? "border-green-200 bg-green-50/60"
                    : l.lucro < 0
                      ? "border-red-200 bg-red-50/60"
                      : "border-stone-200 bg-stone-50/60"
                }`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate font-semibold text-stone-800">{l.nome}</h3>
                  {l.area_m2 != null && l.area_m2 > 0 && (
                    <span className="ml-2 shrink-0 text-[11px] text-stone-400">{formatAreaM2(l)}</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-stone-400">Plantios</p>
                    <p className="font-medium text-stone-700">{l.plantios}</p>
                  </div>
                  <div>
                    <p className="text-stone-400">Área</p>
                    <p className="font-medium text-stone-700">{formatAreaM2(l)}</p>
                  </div>
                  <div>
                    <p className="text-stone-400">Custo</p>
                    <p className="font-medium text-stone-700"><Money value={l.custo} /></p>
                  </div>
                  <div>
                    <p className="text-stone-400">Receita</p>
                    <p className="font-medium text-stone-700"><Money value={l.receita} /></p>
                  </div>
                </div>
                <div className="mt-3 border-t border-stone-200/60 pt-2">
                  <p className="text-xs text-stone-400">Lucro</p>
                  <p className={`text-sm font-bold ${l.lucro >= 0 ? "text-green-700" : "text-red-600"}`}>
                    <Money value={l.lucro} />
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Monthly Trend Line (SVG) */}
      <Card>
        <h2 className="mb-4 font-bold text-stone-800">Tendência de lucro acumulado</h2>
        {trendPoints.length === 0 ? (
          <p className="py-8 text-center text-sm text-stone-400">Sem dados suficientes para exibir tendência.</p>
        ) : (
          <TrendLine points={trendPoints} />
        )}
      </Card>

      {/* Additional metrics row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <p className="text-xs text-stone-400 mb-1">Total de gastos</p>
          <p className="text-lg font-bold text-stone-800"><Money value={custoTotal} /></p>
          <p className="text-[11px] text-stone-400 mt-1">{(gastos ?? []).length} registros</p>
        </Card>
        <Card>
          <p className="text-xs text-stone-400 mb-1">Total de receitas</p>
          <p className="text-lg font-bold text-stone-800"><Money value={receitaTotal} /></p>
          <p className="text-[11px] text-stone-400 mt-1">{(colheitas ?? []).length} colheitas</p>
        </Card>
        <Card>
          <p className="text-xs text-stone-400 mb-1">Lucro líquido</p>
          <p className={`text-lg font-bold ${lucroTotal >= 0 ? "text-green-700" : "text-red-600"}`}>
            <Money value={lucroTotal} />
          </p>
          <p className="text-[11px] text-stone-400 mt-1">margem {receitaTotal > 0 ? ((lucroTotal / receitaTotal) * 100).toFixed(1) : 0}%</p>
        </Card>
      </div>
    </div>
  );
}

/* ── SVG Trend Line Component ── */
function TrendLine({ points }: { points: { month: string; key: string; value: number }[] }) {
  const W = 700;
  const H = 200;
  const PAD_X = 50;
  const PAD_Y = 20;
  const chartW = W - PAD_X * 2;
  const chartH = H - PAD_Y * 2;

  const vals = points.map((p) => p.value);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(1, ...vals);
  const rangeV = maxV - minV || 1;

  const xStep = points.length > 1 ? chartW / (points.length - 1) : chartW;

  const coords = points.map((p, i) => ({
    x: PAD_X + i * xStep,
    y: PAD_Y + chartH - ((p.value - minV) / rangeV) * chartH,
    ...p,
  }));

  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");

  const areaD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${PAD_Y + chartH} L ${coords[0].x.toFixed(1)} ${PAD_Y + chartH} Z`;

  const yTicks = 5;
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => minV + (rangeV * i) / yTicks);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" style={{ minWidth: 300 }}>
        {/* Grid lines */}
        {yTickVals.map((v, i) => {
          const y = PAD_Y + chartH - ((v - minV) / rangeV) * chartH;
          return (
            <g key={i}>
              <line x1={PAD_X} y1={y} x2={W - PAD_X} y2={y} stroke="#e7e5e4" strokeWidth="1" />
              <text x={PAD_X - 6} y={y + 4} textAnchor="end" className="text-[9px] fill-stone-400">
                {v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* Area fill */}
        <path d={areaD} fill="url(#trendGrad)" opacity="0.3" />

        {/* Line */}
        <path d={pathD} fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Dots + labels */}
        {coords.map((c, i) => (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r="4" fill="#16a34a" stroke="white" strokeWidth="2" />
            <text x={c.x} y={PAD_Y + chartH + 14} textAnchor="middle" className="text-[10px] fill-stone-400">
              {c.month}
            </text>
          </g>
        ))}

        {/* Gradient def */}
        <defs>
          <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#16a34a" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#16a34a" stopOpacity="0.02" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}
