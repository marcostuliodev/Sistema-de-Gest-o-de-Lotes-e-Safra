import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/db";
import { CrudPage } from "../components/CrudPage";
import { Money } from "../components/ui";

export default function Gastos() {
  const plantios = useLiveQuery(() => db.plantios.toArray(), []);
  const insumos = useLiveQuery(() => db.insumos.toArray(), []);
  const lotes = useLiveQuery(() => db.lotes.toArray(), []);

  const plantioLabel = (id: string | null | undefined) => {
    const p = (plantios ?? []).find((x) => x.id === id);
    if (!p) return "—";
    const lote = (lotes ?? []).find((l) => l.id === p.lote_id);
    return `${p.cultura}${lote ? ` (${lote.nome})` : ""}`;
  };
  const insumoLabel = (id: string | null | undefined) => (insumos ?? []).find((x) => x.id === id)?.nome ?? "—";

  const plantioOptions = [
    { value: "__placeholder", label: "Selecione o plantio..." },
    ...(plantios ?? []).map((p) => ({ value: p.id, label: plantioLabel(p.id) })),
  ];
  const insumoOptions = [
    { value: "__placeholder", label: "Sem insumo (custo avulso)..." },
    ...(insumos ?? []).map((i) => ({ value: i.id, label: i.nome })),
  ];

  return (
    <CrudPage
      config={{
        entity: "gastos",
        title: "Gastos com insumos",
        subtitle: "Cada despesa vinculada ao plantio — a base do relatório de custo.",
        addLabel: "Novo gasto",
        searchPlaceholder: "Buscar descrição...",
        columns: [
          { key: "data", header: "Data", render: (r) => r.data || "—" },
          { key: "plantio_id", header: "Plantio", render: (r) => <span className="font-medium text-stone-800">{plantioLabel(r.plantio_id)}</span> },
          { key: "insumo_id", header: "Insumo", render: (r) => insumoLabel(r.insumo_id) },
          { key: "descricao", header: "Descrição", render: (r) => r.descricao || "—" },
          { key: "quantidade", header: "Qtd", center: true, render: (r) => Number(r.quantidade).toLocaleString("pt-BR") },
          { key: "valor_unitario", header: "R$/un", render: (r) => <Money value={Number(r.valor_unitario)} /> },
          { key: "total", header: "Total", render: (r) => <span className="font-semibold text-stone-800"><Money value={(r.quantidade || 0) * (r.valor_unitario || 0)} /></span> },
        ],
        fields: [
          { name: "data", label: "Data do gasto", type: "date", required: true },
          { name: "plantio_id", label: "Plantio", type: "select", required: true, options: plantioOptions },
          { name: "insumo_id", label: "Insumo", type: "select", options: insumoOptions },
          { name: "descricao", label: "Descrição", type: "text", placeholder: "Ex.: Cobertura de NPK, adubação de manutenção" },
          { name: "quantidade", label: "Quantidade", type: "number", step: "0.01" },
          { name: "valor_unitario", label: "Valor unitário (R$)", type: "number", step: "0.01", placeholder: "Ex.: 6.40" },
        ],
        emptyTitle: "Nenhum gasto registrado",
        emptySubtitle: "Registre o que foi gasto em cada plantio para saber o custo real da safra.",
      }}
    />
  );
}