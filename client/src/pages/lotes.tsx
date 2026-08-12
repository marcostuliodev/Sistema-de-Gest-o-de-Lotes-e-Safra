import { CrudPage } from "../components/CrudPage";
import { Badge } from "../components/ui";

const tipoLabel: Record<string, string> = { talhao: "Talhão", bancada: "Bancada", vaso: "Estufa/Vaso" };

export default function Lotes() {
  return (
    <CrudPage
      config={{
        entity: "lotes",
        title: "Lotes e Bancadas",
        subtitle: "Talhões, bancadas de estufa ou áreas de cultivo.",
        addLabel: "Novo lote",
        searchPlaceholder: "Buscar por nome...",
        columns: [
          { key: "nome", header: "Nome", render: (r) => <span className="font-medium text-stone-800">{r.nome}</span> },
          { key: "tipo", header: "Tipo", render: (r) => <Badge tone={r.tipo === "talhao" ? "green" : "blue"}>{tipoLabel[r.tipo] ?? r.tipo}</Badge> },
          { key: "area", header: "Área (m²)", center: true, render: (r) => (r.area ? Number(r.area).toLocaleString("pt-BR") : "—") },
          { key: "localizacao", header: "Localização", render: (r) => r.localizacao || "—" },
        ],
        fields: [
          { name: "nome", label: "Nome", type: "text", required: true, placeholder: "Ex.: Talhão Norte, Bancada 1" },
          {
            name: "tipo",
            label: "Tipo",
            type: "select",
            options: [
              { value: "talhao", label: "Talhão (campo aberto)" },
              { value: "bancada", label: "Bancada (estufa)" },
              { value: "vaso", label: "Estufa / Vasos" },
            ],
          },
          { name: "area", label: "Área (m²)", type: "number", step: "0.1", placeholder: "Ex.: 1200" },
          { name: "localizacao", label: "Localização", type: "text", placeholder: "Ex.: Setor 1, margem do riacho" },
        ],
        emptyTitle: "Nenhum lote cadastrado",
        emptySubtitle: "Cadastre seus talhões, bancadas ou estufas para começar a planejar o plantio.",
      }}
    />
  );
}