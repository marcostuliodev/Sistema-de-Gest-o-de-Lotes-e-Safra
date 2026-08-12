import { useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/db";
import { saveLocal, removeLocal } from "../db/sync";
import type { EntityName } from "../db/types";
import { Button, Card, EmptyState, Field, Form, Modal, Select, TextInput, currencyToNumber } from "./ui";
import { Pencil, Plus, Trash } from "./icons";

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

function defaultValueFor(field: FieldDef) {
  if (field.type === "number") return "";
  if (field.type === "date") return new Date().toISOString().slice(0, 10);
  if (field.type === "select" && field.multiple) return null;
  if (field.type === "select" && field.options?.length) return field.options[0].value;
  return "";
}

export function CrudPage({ config }: { config: CrudConfig }) {
  const { entity } = config;
  const rows = useLiveQuery(() => (db[entity] as any).orderBy("id").reverse().toArray(), [entity]) as Record<string, any>[] | undefined;
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
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
    setValues({ ...row });
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
      const payload: Record<string, any> = { ...values, id: editing?.id ?? crypto.randomUUID() };
      const extra = config.beforeSave ? config.beforeSave(payload, !editing) : payload;
      for (const [k, v] of Object.entries(extra)) payload[k] = v;
      for (const key of Object.keys(payload)) {
        const field = config.fields.find((f) => f.name === key);
        if (field?.type === "number") payload[key] = payload[key] === "" || payload[key] == null ? null : Number(payload[key]);
      }
      await saveLocal(entity, payload as { id: string });
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function del(row: Record<string, any>) {
    if (!confirm(`Excluir este registro? Esta ação não pode ser desfeita.`)) return;
    await removeLocal(entity, row.id);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800">{config.title}</h1>
          <p className="text-sm text-stone-500">{config.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <TextInput
            placeholder={config.searchPlaceholder ?? `Buscar...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-44 sm:w-56"
          />
          <Button onClick={openNew}>
            <Plus /> {config.addLabel}
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={config.emptyTitle}
          subtitle={config.emptySubtitle}
          action={
            <Button onClick={openNew}>
              <Plus /> {config.addLabel}
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
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
                        {c.render ? c.render(row) : String(row[c.key] ?? "")}
                      </td>
                    ))}
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" onClick={() => openEdit(row)} title="Editar">
                          <Pencil />
                        </Button>
                        <Button variant="danger" onClick={() => del(row)} title="Excluir">
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
          <div className="grid grid-cols-2 gap-4">
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
                      placeholder={f.placeholder}
                      required={f.required}
                      value={values[f.name] ?? ""}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [f.name]: f.type === "number" ? currencyToNumber(e.target.value) : e.target.value,
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
    </div>
  );
}