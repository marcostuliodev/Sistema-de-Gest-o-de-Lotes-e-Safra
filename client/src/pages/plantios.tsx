import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/db";
import { CrudPage } from "../components/CrudPage";
import { Badge } from "../components/ui";
import { PhotoUpload } from "../components/PhotoUpload";
import { Camera } from "../components/icons";
import { usePlan } from "../store/plan";

const statusMeta: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" | "blue" }> = {
  planejado: { label: "Planejado", tone: "blue" },
  ativo: { label: "Em campo", tone: "green" },
  colhido: { label: "Colhido", tone: "gray" },
  perdido: { label: "Perdido", tone: "red" },
};

export default function Plantios() {
  const lotes = useLiveQuery(() => db.lotes.toArray(), []);
  const loteId = Object.fromEntries((lotes ?? []).map((l) => [l.id, l.nome]));

  const [photoModal, setPhotoModal] = useState<{ plantioId: string; loteId: string } | null>(null);
  const { features } = usePlan();
  const maxFotos = features.maxFotos;

  const loteOptions = [
    { value: "__placeholder", label: "Selecione o lote..." },
    ...(lotes ?? []).map((l) => ({ value: l.id, label: l.nome })),
  ];

  return (
    <>
      <CrudPage
        config={{
          entity: "plantios",
          title: "Plantios",
          subtitle: "O que foi plantado, quando e a previsão de colheita.",
          addLabel: "Novo plantio",
          searchPlaceholder: "Buscar por cultura...",
          columns: [
            { key: "cultura", header: "Cultura", render: (r) => <span className="font-medium text-stone-800">{r.cultura} {r.cultivar && <span className="font-normal text-stone-400">· {r.cultivar}</span>}</span> },
            { key: "lote_id", header: "Lote", render: (r) => loteId[r.lote_id] ?? "—" },
            { key: "data_plantio", header: "Plantado", render: (r) => r.data_plantio },
            { key: "data_colheita_prevista", header: "Prev. colheita", render: (r) => r.data_colheita_prevista || "—" },
            { key: "status", header: "Status", render: (r) => <Badge tone={statusMeta[r.status]?.tone ?? "gray"}>{statusMeta[r.status]?.label ?? r.status}</Badge> },
            {
              key: "photos",
              header: "Fotos",
              center: true,
              render: (r) => (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPhotoModal({ plantioId: r.id, loteId: r.lote_id });
                  }}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-green-700"
                  title="Gerenciar fotos"
                >
                  <Camera />
                </button>
              ),
            },
          ],
          fields: [
            { name: "lote_id", label: "Lote / Bancada", type: "select", required: true, options: loteOptions },
            { name: "cultura", label: "Cultura", type: "text", required: true, placeholder: "Ex.: Alface, Tomate, Cafeeiro" },
            { name: "cultivar", label: "Cultivar / Variedade", type: "text", placeholder: "Ex.: Crespa, Santa Clara" },
            { name: "data_plantio", label: "Data do plantio", type: "date", required: true },
            { name: "data_colheita_prevista", label: "Previsão de colheita", type: "date" },
            { name: "qtd_plantada", label: "Quantidade", type: "number", step: "0.1", placeholder: "Ex.: 300" },
            { name: "unidade", label: "Unidade", type: "text", placeholder: "pés, mudas, kg..." },
            {
              name: "status",
              label: "Status",
              type: "select",
              options: [
                { value: "planejado", label: "Planejado" },
                { value: "ativo", label: "Em campo (ativo)" },
                { value: "colhido", label: "Colhido" },
                { value: "perdido", label: "Perdido" },
              ],
            },
          ],
          emptyTitle: "Nenhum plantio registrado",
          emptySubtitle: "Registre o que foi plantado e a data prevista de colheita para não perder o ponto certo.",
        }}
      />

      {photoModal && (
        <PhotoUpload
          plantioId={photoModal.plantioId}
          loteId={photoModal.loteId}
          open={true}
          onClose={() => setPhotoModal(null)}
          maxFotos={maxFotos}
        />
      )}
    </>
  );
}
