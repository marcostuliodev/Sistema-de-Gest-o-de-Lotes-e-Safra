import { z } from "zod";

const TEXT_MAX = 1000;
const STRING_ID_MAX = 100;

function openRangeOrZero() {
  return z.union([z.number().finite().min(0), z.null()]).default(0);
}

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email({ message: "E-mail invalido" })
  .transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(6, "Senha deve ter no minimo 6 caracteres")
  .max(200);

export const nameSchema = z
  .string()
  .trim()
  .min(1, "Nome obrigatorio")
  .max(120);

export const uuidSchema = z
  .string()
  .trim()
  .max(STRING_ID_MAX)
  .regex(/^[A-Za-z0-9_-]{1,100}$/, { message: "id invalido" });

const optionalText = z
  .string()
  .trim()
  .max(TEXT_MAX)
  .nullish();

const optionalNumber = z.number().finite().nullish();

const optionalNonNeg = z
  .number()
  .finite()
  .min(0)
  .nullish();

const dateStr = z
  .string()
  .trim()
  .max(20)
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$/, { message: "data invalida" })
  .nullish();

export const lotesSchema = z.object({
  id: uuidSchema.optional(),
  nome: z.string().trim().min(1).max(TEXT_MAX),
  tipo: z.string().trim().max(50).default("talhao"),
  area: openRangeOrZero(),
  localizacao: optionalText,
});

export const plantiosSchema = z.object({
  id: uuidSchema.optional(),
  lote_id: uuidSchema,
  cultura: z.string().trim().min(1).max(TEXT_MAX),
  cultivar: optionalText,
  data_plantio: dateStr,
  data_colheita_prevista: dateStr,
  qtd_plantada: optionalNonNeg,
  unidade: z.string().trim().max(20).default("un"),
  status: z.string().trim().max(50).default("ativo"),
});

export const insumosSchema = z.object({
  id: uuidSchema.optional(),
  nome: z.string().trim().min(1).max(TEXT_MAX),
  categoria: optionalText,
  unidade: z.string().trim().max(20).default("un"),
});

export const gastosSchema = z.object({
  id: uuidSchema.optional(),
  plantio_id: uuidSchema,
  insumo_id: uuidSchema.nullish(),
  descricao: optionalText,
  quantidade: openRangeOrZero(),
  valor_unitario: optionalNumber,
  data: dateStr,
});

export const colheitasSchema = z.object({
  id: uuidSchema.optional(),
  plantio_id: uuidSchema,
  data: dateStr,
  quantidade: optionalNonNeg,
  unidade: z.string().trim().max(20).default("kg"),
  preco_venda: optionalNumber,
});

export const entitySchemas = {
  lotes: lotesSchema,
  plantios: plantiosSchema,
  insumos: insumosSchema,
  gastos: gastosSchema,
  colheitas: colheitasSchema,
};

export function parseEntity(entity, raw) {
  const schema = entitySchemas[entity];
  if (!schema) throw new Error("entidade desconhecida");
  return schema.parse(raw);
}

const HTML_CHARS = /[<>"'`]/g;
export function sanitizeText(v) {
  if (typeof v !== "string") return v;
  return v.replace(HTML_CHARS, "");
}

export function sanitizeRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = Array.isArray(row) ? [] : {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    out[k] = typeof v === "string" ? sanitizeText(v) : v;
  }
  return out;
}

export function sanitizeSnapshot(snap) {
  if (!snap || typeof snap !== "object") return snap;
  const out = {};
  for (const k of Object.keys(snap)) {
    out[k] = Array.isArray(snap[k]) ? snap[k].map(sanitizeRow) : snap[k];
  }
  return out;
}
