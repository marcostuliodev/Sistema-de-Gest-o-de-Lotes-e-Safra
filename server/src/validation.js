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
  .min(8, "Senha deve ter no minimo 8 caracteres")
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

const optionalNonNeg = z
  .number()
  .finite()
  .min(0)
  .nullish();

const isCalendarDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?Z?)?$/.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hours = Number(hourText || 0);
  const minutes = Number(minuteText || 0);
  const seconds = Number(secondText || 0);
  if (month < 1 || month > 12 || day < 1 || hours > 23 || minutes > 59 || seconds > 59) return false;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const requiredDateStr = z
  .string()
  .trim()
  .max(20)
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$/, { message: "data invalida" })
  .refine(isCalendarDate, { message: "data invalida" });

const dateStr = requiredDateStr.nullish();

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
  data_plantio: requiredDateStr,
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
  valor_unitario: optionalNonNeg,
  data: requiredDateStr,
});

export const colheitasSchema = z.object({
  id: uuidSchema.optional(),
  plantio_id: uuidSchema,
  data: requiredDateStr,
  quantidade: optionalNonNeg,
  unidade: z.string().trim().max(20).default("kg"),
  preco_venda: optionalNonNeg,
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

/** Valida somente campos enviados em uma atualização parcial. */
export function parseEntityPatch(entity, raw) {
  const schema = entitySchemas[entity];
  if (!schema) throw new Error("entidade desconhecida");
  return schema.partial().parse(raw);
}

const HTML_CHARS = /[<>"'`]/g;
export function sanitizeText(v) {
  if (typeof v !== "string") return v;
  return v.replace(HTML_CHARS, "");
}

/**
 * Escapa metacaracteres de regex para uso seguro em new RegExp(email).
 * Sem isto, um e-mail como "a.*@x.com" ou ".*" casaria com outros usuários
 * (injeção de regex / ReDoS leve) nos lookups por e-mail.
 */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
