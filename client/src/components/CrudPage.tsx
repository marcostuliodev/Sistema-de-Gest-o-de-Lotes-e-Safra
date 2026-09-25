import { useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/db";
import { saveLocal, removeLocal } from "../db/sync";
import type { EntityName } from "../db/types";
import { Button, Card, EmptyState, Field, Form, Modal, Select, TextInput } from "./ui";
import { Pencil, Plus, Trash } from "./icons";
import { usePlan } from "../store/plan";
import { useProject } from "../store/project";

export interface FieldDef {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "select";
  required?: boolean;
  placeholder?: string;
  step?: string;
  options?: { value: string; label: string }[];
  multiple?: boolean;
  className?: string;
  disabled?: boolean;
}

export interface CrudConfig {
  entity: EntityName;
  title: string;
  subtitle: string;
  addLabel: string;
  searchPlaceholder?: string;
  columns: { key: string; header: string; render?: (row: Record<string, any>) => ReactNode; center?: boolean }[];
  fields: FieldDef[];
  /** Popula valores extras antes de salvar (ex: paludar lote_id de um dropdown filtrado por nome) */
  beforeSave?: (values: Record<string, any>, isNew: boolean) => Record<string, any>;
  emptyTitle: string;
  emptySubtitle: string;
}

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface DeleteSummary {
  plantios: number;
  gastos: number;
  colheitas: number;
  total: number;
  blocking: boolean;
  items: string[];
}

function deleteSummary(
  entity: EntityName,
  row: Record<string, any>,
  plantios: Record<string, any>[],
  gastos: Record<string, any>[],
  colheitas: Record<string, any>[],
): DeleteSummary {
  if (entity === "lotes") {
    const ids = new Set(plantios.filter((item) => String(item.lote_id) === String(row.id)).map((item) => String(item.id)));
    const relatedPlantios = plantios.filter((item) => ids.has(String(item.id)));
    const relatedGastos = gastos.filter((item) => ids.has(String(item.plantio_id)));
    const relatedColheitas = colheitas.filter((item) => ids.has(String(item.plantio_id)));
    return {
      plantios: relatedPlantios.length,
      gastos: relatedGastos.length,
      colheitas: relatedColheitas.length,
       total: relatedPlantios.length + relatedGastos.length + relatedColheitas.length,
       blocking: relatedPlantios.length + relatedGastos.length + relatedColheitas.length > 0,
       items: [
         ...relatedPlantios.map((item) => `plantio: ${item.cultura || item.id}`),
         ...relatedGastos.map((item) => `gasto: ${item.descricao || item.id}`),
         ...relatedColheitas.map((item) => `colheita: ${item.data || item.id}`),
       ],

    };
  }
  if (entity === "plantios") {
    const relatedGastos = gastos.filter((item) => String(item.plantio_id) === String(row.id));
    const relatedColheitas = colheitas.filter((item) => String(item.plantio_id) === String(row.id));
    return {
      plantios: 0,
      gastos: relatedGastos.length,
      colheitas: relatedColheitas.length,
       total: relatedGastos.length + relatedColheitas.length,
       blocking: relatedGastos.length + relatedColheitas.length > 0,
       items: [
         ...relatedGastos.map((item) => `gasto: ${item.descricao || item.id}`),
         ...relatedColheitas.map((item) => `colheita: ${item.data || item.id}`),
       ],

    };
  }
  if (entity === "insumos") {
    const relatedGastos = gastos.filter((item) => String(item.insumo_id) === String(row.id));
    return {
      plantios: 0,
      gastos: relatedGastos.length,
      colheitas: 0,
      total: relatedGastos.length,
      blocking: false,
      items: relatedGastos.map((item) => `gasto: ${item.descricao || item.id}`),
    };
  }
  return { plantios: 0, gastos: 0, colheitas: 0, total: 0, blocking: false, items: [] };
}

function defaultValueFor(field: FieldDef) {
  if (field.type === "number") return "";
  if (field.type === "date") return localDateString();
  if (field.type === "select" && field.multiple) return null;
  if (field.type === "select" && field.options?.length) return field.options[0].value;
  return "";
}

export function CrudPage({ config }: { config: CrudConfig }) {
  const { entity } = config;
  const { features } = usePlan();
  const { can } = useProject();
  const canCreate = can("entities.create");
  const canUpdate = can("entities.update");
  const canDelete = can("entities.delete");
  const canCascadeDelete = can("entities.delete_cascade");
  const rows = useLiveQuery(() => (db[entity] as any).orderBy("id").reverse().toArray(), [entity]) as Record<string, any>[] | undefined;
  const localPlantios = useLiveQuery(() => db.plantios.toArray(), []) as Record<string, any>[] | undefined;
  const localGastos = useLiveQuery(() => db.gastos.toArray(), []) as Record<string, any>[] | undefined;
  const localColheitas = useLiveQuery(() => db.colheitas.toArray(), []) as Record<string, any>[] | undefined;
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteState, setDeleteState] = useState<{ row: Record<string, any>; summary: DeleteSummary } | null>(null);
  const [error, setError] = useState("");

  const allRows = rows ?? [];
  const filtered = allRows.filter((r) =>
    search.trim()
      ? config.columns.some((c) => String(r[c.key] ?? "").toLowerCase().includes(search.toLowerCase()))
      : true
  );

  function openNew() {
    const initial: Record<string, any> = {};
    for (const f of config.fields) initial[f.name] = defaultValueFor(f);
    setValues(initial);
    setEditing(null);
    setError("");
    setOpen(true);
  }

  function openEdit(row: Record<string, any>) {
    const next = { ...row };
    if (entity === "lotes") {
      next.area_m2 = Object.hasOwn(row, "area_m2") ? row.area_m2 : row.area ?? null;
      delete next.area;
    }
    setValues(next);
    setEditing(row);
    setError("");
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      for (const f of config.fields) {
        if (f.required && (values[f.name] === undefined || values[f.name] === "" || values[f.name] === null || values[f.name] === "__placeholder")) {
          throw new Error(`Preencha o campo "${f.label}"`);
        }
      }
      const localLimit = entity === "lotes" ? features.maxLotes : entity === "plantios" ? features.maxPlantios : Infinity;
      if (!editing && Number.isFinite(localLimit) && allRows.length >= localLimit) {
        throw new Error(`Limite do plano atingido (${localLimit} ${entity === "lotes" ? "lotes" : "plantios"}). Faça upgrade para continuar.`);
      }
      const payload: Record<string, any> = { ...values, id: editing?.id ?? crypto.randomUUID() };
      const extra = config.beforeSave ? config.beforeSave(payload, !editing) : payload;
       for (const [k, v] of Object.entries(extra)) payload[k] = v;
       for (const field of config.fields) {
         if (field.type === "select" && (payload[field.name] === "" || payload[field.name] === "__placeholder")) {
           payload[field.name] = null;
         }
       }
       for (const key of Object.keys(payload)) {
        const field = config.fields.find((f) => f.name === key);
        if (field?.type === "number") payload[key] = payload[key] === "" || payload[key] == null ? null : Number(payload[key]);
      }
      if (entity === "lotes") {
        payload.area_m2 = Object.hasOwn(payload, "area_m2") ? payload.area_m2 : payload.area ?? null;
        delete payload.area;
      }
      await saveLocal(entity, payload as { id: string });

      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function openDelete(row: Record<string, any>) {
    const summary = deleteSummary(entity, row, localPlantios ?? [], localGastos ?? [], localColheitas ?? []);
    setDeleteState({ row, summary });
    setError("");
  }

  async function performDelete(cascade: boolean) {
    if (!deleteState) return;
    if (!cascade && deleteState.summary.blocking) {
      setDeleteState(null);
      setError("A exclusão somente do registro foi cancelada porque existem dependências. Escolha também os dependentes.");
      return;
    }
    setDeletingId(deleteState.row.id);
    setError("");
    try {
      await removeLocal(entity, deleteState.row.id, cascade);
      setDeleteState(null);
    } catch (err) {
      setError((err as Error).message || "Não foi possível excluir o registro.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800">{config.title}</h1>
          <p className="text-sm text-stone-500">{config.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            placeholder={config.searchPlaceholder ?? `Buscar...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-44"
          />
          <Button onClick={openNew} disabled={rows === undefined || !canCreate}>
            <Plus /> {config.addLabel}
          </Button>
        </div>
      </div>

      {error && !open && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}

      {rows === undefined ? (
        <Card>
          <p className="py-8 text-center text-sm text-stone-400">Carregando registros...</p>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={config.emptyTitle}
          subtitle={config.emptySubtitle}
          action={
            <Button onClick={openNew} disabled={!canCreate}>
              <Plus /> {config.addLabel}
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          {/* Mobile: cards para mostrar todas as colunas sem cortar a tela. */}
          <div className="divide-y divide-stone-100 md:hidden">
            {filtered.map((row) => (
              <article key={row.id} className="min-w-0 p-4">
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                  {config.columns.map((c) => {
                    const value = row[c.key];
                    return (
                      <div key={c.key} className="min-w-0">
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-stone-400">
                          {c.header}
                        </p>
                        <div className="min-w-0 break-words text-sm text-stone-700">
                          {c.render ? (
                            c.render(row)
                          ) : value === null || value === undefined || value === "" ? (
                            <span className="text-stone-400">—</span>
                          ) : (
                            String(value)
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-end gap-2 border-t border-stone-100 pt-3">
                  <Button
                    variant="ghost"
                     onClick={() => openEdit(row)}
                     disabled={!canUpdate}
                     title="Editar"
                    className="min-h-11 px-3"
                  >
                    <Pencil /> <span>Editar</span>
                  </Button>
                  <Button
                    variant="danger"
                     onClick={() => openDelete(row)}
                     disabled={!canDelete || deletingId === row.id}
                    title="Excluir"
                    className="min-h-11 px-3"
                  >
                    <Trash /> <span>Excluir</span>
                  </Button>
                </div>
              </article>
            ))}
          </div>

          {/* Tablet/desktop: tabela completa com rolagem apenas quando necessário. */}
          <div className="scroll-thin hidden overflow-x-auto md:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  {config.columns.map((c) => (
                    <th key={c.key} className={`px-4 py-3 font-semibold ${c.center ? "text-center" : ""}`}>
                      {c.header}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right font-semibold">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/70">
                    {config.columns.map((c) => (
                      <td key={c.key} className={`px-4 py-3 align-middle text-stone-700 ${c.center ? "text-center" : ""}`}>
                        {c.render ? (
                          c.render(row)
                        ) : (
                          <span className="block max-w-[220px] truncate" title={String(row[c.key] ?? "")}>
                            {String(row[c.key] ?? "")}
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                         <Button variant="ghost" onClick={() => openEdit(row)} disabled={!canUpdate} title="Editar" className="p-2.5 sm:p-2">
                          <Pencil />
                        </Button>
                        <Button
                          variant="danger"
                           onClick={() => openDelete(row)}
                           disabled={!canDelete || deletingId === row.id}
                          title="Excluir"
                          className="p-2.5 sm:p-2"
                        >
                          <Trash />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? `Editar ${config.title}` : `Novo ${config.addLabel.toLowerCase()}`}>
        <Form onSubmit={(e) => void submit(e)}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {config.fields.map((f) => (
              <div key={f.name} className={f.type === "select" && f.multiple ? "col-span-2" : ""}>
                <Field label={f.label} required={f.required}>
                  {f.type === "select" ? (
                    <Select
                      value={values[f.name] ?? ""}
                      disabled={f.disabled}
                      onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    >
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value} disabled={o.value === "__placeholder"}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : f.type === "date" ? (
                    <TextInput
                      type="date"
                      required={f.required}
                      value={values[f.name] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    />
                  ) : (
                    <TextInput
                      type={f.type === "number" ? "number" : "text"}
                      step={f.step}
                      min={f.type === "number" ? 0 : undefined}
                      placeholder={f.placeholder}
                      required={f.required}
                      value={values[f.name] ?? ""}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [f.name]: e.target.value,
                        }))
                      }
                    />
                  )}
                </Field>
              </div>
            ))}
          </div>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="subtle" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={deleteState !== null} onClose={() => { setDeleteState(null); setError(""); }} title="Confirmar exclusão">
        {deleteState && (
          <div className="space-y-4">
            <p className="text-sm text-stone-600">
              Excluir <strong>{deleteState.row.nome || config.title}</strong>. A exclusão não pode ser desfeita.
            </p>
            {deleteState.summary.total > 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">Dependências encontradas neste projeto:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {deleteState.summary.plantios > 0 && <li>{deleteState.summary.plantios} plantio(s)</li>}
                  {deleteState.summary.gastos > 0 && <li>{deleteState.summary.gastos} gasto(s)</li>}
                  {deleteState.summary.colheitas > 0 && <li>{deleteState.summary.colheitas} colheita(s)</li>}
                </ul>
                {deleteState.summary.items.length > 0 && (
                  <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto pl-5 text-xs">
                    {deleteState.summary.items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                )}
              </div>
            ) : (
              <p className="text-sm text-stone-500">Nenhuma dependência local foi encontrada. O servidor verificará outras dependências antes de excluir.</p>
            )}
            {(entity === "lotes" || entity === "plantios") && (
              <p className="text-sm text-stone-500">Fotos associadas também serão removidas quando a exclusão em cascata for escolhida.</p>
            )}
             {deleteState.summary.blocking && (
               <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                 {canCascadeDelete
                   ? "Somente o registro não é permitido enquanto houver dependências. Essa opção cancela a exclusão."
                   : "Este papel não possui permissão para excluir dependências. Solicite ao proprietário a permissão entities.delete_cascade."}
               </p>
             )}
            {entity === "insumos" && !deleteState.summary.blocking && (
              <p className="text-sm text-stone-500">
                Na exclusão somente do insumo, os gastos relacionados{deleteState.summary.gastos > 0 ? ` (${deleteState.summary.gastos})` : ""} serão desassociados e preservados.
              </p>
            )}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button variant="subtle" onClick={() => { setDeleteState(null); setError(""); }}>Cancelar</Button>
              <Button variant="subtle" onClick={() => void performDelete(false)} disabled={deletingId === deleteState.row.id}>
                {deleteState.summary.blocking ? "Somente registro (cancelar)" : entity === "insumos" && deleteState.summary.gastos > 0 ? "Somente insumo" : "Somente registro"}
              </Button>
              {(entity === "lotes" || entity === "plantios" || entity === "insumos") && canCascadeDelete && (
                <Button variant="danger" onClick={() => void performDelete(true)} disabled={deletingId === deleteState.row.id}>
                  Excluir também dependentes
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
