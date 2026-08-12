import { CrudPage } from "../components/CrudPage";
import { Badge } from "../components/ui";

const categorias = ["semente", "muda", "fertilizante", "adubo", "defensivo", "irrigação", "embalagem", "outro"];
const catMeta: Record<string, string> = {
  semente: "Semente", muda: "Muda", fertilizante: "Fertilizante", adubo: "Adubo",
  defensivo: "Defensivo", irrigação: "Irrigação", embalagem: "Embalagem", outro: "Outro",
};

export default function InsumosPage() {
  return (
    <CrudPage
      config={{
        entity: "insumos",
        title: "Insumos",
        subtitle: "Sementes, mudas, fertilizantes, defensivos e outros insumos utilizados.",
        addLabel: "Novo insumo",
        searchPlaceholder: "Buscar insumo...",
        columns: [
          { key: "nome", header: "Insumo", render: (r) => <span className="font-medium text-stone-800">{r.nome}</span> },
          { key: "categoria", header: "Categoria", render: (r) => (r.categoria ? <Badge tone="green">{catMeta[r.categoria] ?? r.categoria}</Badge> : "—") },
          { key: "unidade", header: "Unidade", center: true, render: (r) => r.unidade || "—" },
        ],
        fields: [
          { name: "nome", label: "Nome", type: "text", required: true, placeholder: "Ex.: Fertilizante NPK 10-10-10" },
          { name: "categoria", label: "Categoria", type: "select", options: [{ value: "__placeholder", label: "Selecione..." }, ...categorias.map((c) => ({ value: c, label: catMeta[c] }))] },
          { name: "unidade", label: "Unidade", type: "text", placeholder: "kg, L, pacote, un..." },
        ],
        emptyTitle: "Nenhum insumo cadastrado",
        emptySubtitle: "Cadastre sementes, defensivos e fertilizantes para controlar os custos de cada plantio.",
      }}
    />
  );
}