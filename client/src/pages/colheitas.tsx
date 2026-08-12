import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/db";
import { CrudPage } from "../components/CrudPage";
import { Money } from "../components/ui";

export default function Colheitas() {
  const plantios = useLiveQuery(() => db.plantios.toArray(), []);
  const lotes = useLiveQuery(() => db.lotes.toArray(), []);

  const plantioLabel = (id: string) => {
    const p = (plantios ?? []).find((x) => x.id === id);
    if (!p) return "—";
    const lote = (lotes ?? []).find((l) => l.id === p.lote_id);
    return `${p.cultura}${lote ? ` (${lote.nome})` : ""}`;
  };

  const options = [
    { value: "__placeholder", label: "Selecione o plantio..." },
    ...(plantios ?? []).map((p) => ({ value: p.id, label: plantioLabel(p.id) })),
  ];

  return (
    <CrudPage
      config={{
        entity: "colheitas",
        title: "Colheitas",
        subtitle: "Registre o que foi colhido e o preço de venda — origem da receita.",
        addLabel: "Nova colheita",
        searchPlaceholder: "Buscar...",
        columns: [
          { key: "data", header: "Data", render: (r) => r.data || "—" },
          { key: "plantio_id", header: "Plantio", render: (r) => <span className="font-medium text-stone-800">{plantioLabel(r.plantio_id)}</span> },
          { key: "quantidade", header: "Quantidade", center: true, render: (r) => `${Number(r.quantidade).toLocaleString("pt-BR")} ${r.unidade || ""}`.trim() },
          { key: "preco_venda", header: "Preço de venda", render: (r) => <Money value={Number(r.preco_venda)} /> },
          { key: "total", header: "Receita", render: (r) => <span className="font-semibold text-green-700"><Money value={(r.quantidade || 0) * (r.preco_venda || 0)} /></span> },
        ],
        fields: [
          { name: "data", label: "Data da colheita", type: "date", required: true },
          { name: "plantio_id", label: "Plantio", type: "select", required: true, options },
          { name: "quantidade", label: "Quantidade", type: "number", step: "0.1", required: true, placeholder: "Ex.: 150" },
          { name: "unidade", label: "Unidade", type: "text", placeholder: "kg, un, maços..." },
          { name: "preco_venda", label: "Preço de venda (R$)", type: "number", step: "0.01", placeholder: "Ex.: 4.50" },
        ],
        emptyTitle: "Nenhuma colheita registrada",
        emptySubtitle: "Ao colher, registre quantidade e valor de venda para fechar o lucro de cada ciclo.",
      }}
    />
  );
}