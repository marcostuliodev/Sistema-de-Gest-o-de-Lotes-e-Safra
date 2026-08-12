import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/db";
import { Badge, Button, Card, Money, StatCard } from "../components/ui";

export default function Relatorios() {
  const plantios = useLiveQuery(() => db.plantios.toArray(), []);
  const lotes = useLiveQuery(() => db.lotes.toArray(), []);
  const gastos = useLiveQuery(() => db.gastos.toArray(), []);
  const colheitas = useLiveQuery(() => db.colheitas.toArray(), []);

  const custoDe = (pid: string) =>
    (gastos ?? []).filter((g) => g.plantio_id === pid).reduce((s, g) => s + (g.quantidade || 0) * (g.valor_unitario || 0), 0);
  const receitaDe = (pid: string) =>
    (colheitas ?? []).filter((c) => c.plantio_id === pid).reduce((s, c) => s + (c.quantidade || 0) * (c.preco_venda || 0), 0);

  const perCultura: Record<string, { custo: number; receita: number; rendimento: number; qtd: number }> = {};
  for (const p of plantios ?? []) {
    const row = (perCultura[p.cultura] ??= { custo: 0, receita: 0, rendimento: 0, qtd: 0 });
    row.custo += custoDe(p.id);
    row.receita += receitaDe(p.id);
    row.qtd += 1;
    row.rendimento += (colheitas ?? []).filter((c) => c.plantio_id === p.id).reduce((s, c) => s + (c.quantidade || 0), 0);
  }
  const culturaRows = Object.entries(perCultura)
    .map(([cultura, v]) => ({ cultura, ...v, lucro: v.receita - v.custo, margem: v.receita > 0 ? ((v.receita - v.custo) / v.receita) * 100 : 0 }))
    .sort((a, b) => b.receita - a.receita);

  const custoTotal = (gastos ?? []).reduce((s, g) => s + (g.quantidade || 0) * (g.valor_unitario || 0), 0);
  const receitaTotal = (colheitas ?? []).reduce((s, c) => s + (c.quantidade || 0) * (c.preco_venda || 0), 0);
  const lucro = receitaTotal - custoTotal;

  const perLote = (lotes ?? [])
    .map((l) => {
      const pids = (plantios ?? []).filter((p) => p.lote_id === l.id).map((p) => p.id);
      const custo = pids.reduce((s, pid) => s + custoDe(pid), 0);
      const receita = pids.reduce((s, pid) => s + receitaDe(pid), 0);
      return { lote: l.nome, custo, receita, lucro: receita - custo };
    })
    .sort((a, b) => b.lucro - a.lucro);

  function exportCsv() {
    const heads = ["Cultura", "Plantios", "Rendimento total", "Receita (R$)", "Custo (R$)", "Lucro (R$)", "Margem (%)"];
    const rows = culturaRows.map((r) => [r.cultura, r.qtd, r.rendimento, r.receita.toFixed(2), r.custo.toFixed(2), r.lucro.toFixed(2), r.margem.toFixed(1)]);
    const csv = "\uFEFF" + [heads, ...rows].map((l) => l.join(";")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relatorio-custos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Relatórios</h1>
          <p className="text-sm text-stone-500">Quanto você gasta vs. quanto lucra por cultura e por lote.</p>
        </div>
        <Button variant="subtle" onClick={exportCsv}>Exportar CSV</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Custo total" value={<Money value={custoTotal} />} accent="stone" />
        <StatCard label="Receita total" value={<Money value={receitaTotal} />} accent="amber" />
        <StatCard label="Lucro" value={<Money value={lucro} />} accent={lucro >= 0 ? "green" : "red"} />
        <StatCard label="Margem" value={`${receitaTotal > 0 ? (((lucro) / receitaTotal) * 100).toFixed(1) : "0"}%`} accent={lucro >= 0 ? "green" : "red"} />
      </div>

      <Card className="overflow-hidden p-0">
        <div className="px-5 pt-4"><h2 className="font-bold text-stone-800">Resultado por cultura</h2></div>
        <div className="scroll-thin mt-2 overflow-x-auto">
          {culturaRows.length === 0 ? (
            <p className="px-5 pb-6 pt-2 text-sm text-stone-400">Sem dados ainda. Cadastre plantios, gastos e colheitas para ver o resultado.</p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-t border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  <th className="px-5 py-3 font-semibold">Cultura</th>
                  <th className="px-3 py-3 text-right font-semibold">Plantios</th>
                  <th className="px-3 py-3 text-right font-semibold">Rendimento</th>
                  <th className="px-3 py-3 text-right font-semibold">Custo</th>
                  <th className="px-3 py-3 text-right font-semibold">Receita</th>
                  <th className="px-3 py-3 text-right font-semibold">Lucro</th>
                  <th className="px-5 py-3 text-right font-semibold">Margem</th>
                </tr>
              </thead>
              <tbody>
                {culturaRows.map((r) => (
                  <tr key={r.cultura} className="border-b border-stone-100 last:border-0">
                    <td className="px-5 py-3 font-medium text-stone-800">{r.cultura}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.qtd}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.rendimento.toLocaleString("pt-BR")}</td>
                    <td className="px-3 py-3 text-right tabular-nums"><Money value={r.custo} /></td>
                    <td className="px-3 py-3 text-right tabular-nums"><Money value={r.receita} /></td>
                    <td className={`px-3 py-3 text-right tabular-nums font-semibold ${r.lucro >= 0 ? "text-green-700" : "text-red-600"}`}><Money value={r.lucro} /></td>
                    <td className="px-5 py-3">
                      <span className="flex justify-end"><Badge tone={r.lucro >= 0 ? "green" : "red"}>{r.margem.toFixed(1)}%</Badge></span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-bold text-stone-800">Resultado por lote / bancada</h2>
        {perLote.length === 0 ? (
          <p className="py-4 text-sm text-stone-400">Cadastre lotes para ver aqui.</p>
        ) : (
          <ul className="space-y-2">
            {perLote.map((l) => (
              <li key={l.lote} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-stone-700">{l.lote}</span>
                <span className="flex items-center gap-3 text-sm">
                  <span className="text-stone-400">custo <Money value={l.custo} /></span>
                  <span className="text-stone-400">receita <Money value={l.receita} /></span>
                  <span className={`font-semibold ${l.lucro >= 0 ? "text-green-700" : "text-red-600"}`}>
                    <Money value={l.lucro} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}