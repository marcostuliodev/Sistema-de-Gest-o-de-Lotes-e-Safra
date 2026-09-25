import { MongoClient, ObjectId, GridFSBucket } from "mongodb";

const MONGO_URL = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "agrolote";

let client = null;
let _db = null;

async function getDb() {
  if (_db) return _db;
  if (!MONGO_URL) {
    throw new Error("MONGODB_URI não definida. Configure a variável de ambiente.");
  }
  client = new MongoClient(MONGO_URL, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    heartbeatFrequencyMS: 30000,
  });
  await client.connect();
  _db = client.db(DB_NAME);
  await _db.command({ ping: 1 });
  return _db;
}

export async function closeDb() {
  if (client) { await client.close(); client = null; _db = null; _gridFSBucket = null; }
}

// ── Collections ──────────────────────────────────────────────────────

export async function col(name) {
  const db = await getDb();
  return db.collection(name);
}

let _gridFSBucket = null;
const GRIDFS_BUCKET_NAME = "fs";

export function getGridFSBucket() {
  if (_gridFSBucket) return _gridFSBucket;
  // _db must be initialized before calling this
  if (!_db) throw new Error("GridFSBucket: database not initialized");
  _gridFSBucket = new GridFSBucket(_db, { bucketName: GRIDFS_BUCKET_NAME });
  return _gridFSBucket;
}

export async function deleteGridFSFile(id, { session } = {}) {
  const options = session ? { session } : undefined;
  const files = await col(`${GRIDFS_BUCKET_NAME}.files`);
  const chunks = await col(`${GRIDFS_BUCKET_NAME}.chunks`);
  const file = await files.findOne({ _id: id }, options);
  if (!file) {
    await chunks.deleteMany({ files_id: id }, options);
    return false;
  }
  const result = await files.deleteOne({ _id: id }, options);
  await chunks.deleteMany({ files_id: id }, options);
  return (result.deletedCount || 0) > 0;
}

// ── Query helpers (substituem db.prepare do pg) ─────────────────────

/**
 * Converte "?" em "$1, $2..." estilo pg para uso com toPg.
 * Mas para MongoDB usamos positional params diretamente.
 */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Parse simples de WHERE clause: "field1 = ? AND field2 = ?"
 * Retorna { field1: val1, field2: val2 }
 */
function parseWhere(clause, params) {
  if (!clause) return {};
  const conditions = clause.split(/\s+AND\s+/i);
  const filter = {};
  let paramIdx = 0;
  for (const cond of conditions) {
    const m = cond.trim().match(/^(\w+)\s*(=|!=|>|<|>=|<=|LIKE|IN)\s*\?$/i);
    if (m) {
      const [, field, op] = m;
      const val = params[paramIdx++];
      if (op === "=") filter[field] = val;
      else if (op === "!=") filter[field] = { $ne: val };
      else if (op === ">") filter[field] = { $gt: val };
      else if (op === "<") filter[field] = { $lt: val };
      else if (op === ">=") filter[field] = { $gte: val };
      else if (op === "<=") filter[field] = { $lte: val };
      else if (op.toUpperCase() === "LIKE") filter[field] = { $regex: String(val).replace(/%/g, ".*"), $options: "i" };
      else if (op.toUpperCase() === "IN") filter[field] = { $in: Array.isArray(val) ? val : [val] };
    }
  }
  return filter;
}

/**
 * Parse ORDER BY: "field DESC" → { field: -1 } ou "field ASC" → { field: 1 }
 */
function parseOrder(clause) {
  if (!clause) return {};
  const [field, dir] = clause.trim().split(/\s+/);
  return { [field]: dir?.toUpperCase() === "DESC" ? -1 : 1 };
}

/**
 * Wrapper que imita a interface do pg prepare().
 * Uso: const row = await db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
 */
export const db = {
  prepare(sql) {
    const trimmed = sql.trim();
    return {
      async get(...params) {
        const c = await col(getTableName(trimmed));
        if (trimmed.toUpperCase().startsWith("SELECT")) {
          return await parseSelectQuery(c, trimmed, params);
        }
        return await parseExecQuery(c, trimmed, params);
      },
      async all(...params) {
        const c = await col(getTableName(trimmed));
        if (trimmed.toUpperCase().startsWith("SELECT")) {
          return await parseSelectAll(c, trimmed, params);
        }
        return [];
      },
      async run(...params) {
        const c = await col(getTableName(trimmed));
        return await parseExecQuery(c, trimmed, params);
      },
    };
  },
  async exec(sql) {
    // Migrations — no-op no MongoDB (schemaless)
  },
  async collection(name) {
    return col(name);
  },
};

function getTableName(sql) {
  const upper = sql.toUpperCase();
  // FROM table, INSERT INTO table, UPDATE table, DELETE FROM table
  const patterns = [
    /FROM\s+(\w+)/i,
    /INTO\s+(\w+)/i,
    /UPDATE\s+(\w+)/i,
  ];
  for (const p of patterns) {
    const m = sql.match(p);
    if (m) return m[1];
  }
  return "unknown";
}

async function parseSelectQuery(c, sql, params) {
  const upper = sql.toUpperCase();

  // COUNT(*) query
  const countMatch = sql.match(/SELECT\s+COUNT\(\s*\*?\s*\)(?:::\w+)?\s+(?:AS\s+)?(\w+)/i);
  if (countMatch) {
    const alias = countMatch[1];
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|$)/i);
    const filter = whereMatch ? parseWhere(whereMatch[1], params) : {};
    const count = await c.countDocuments(filter);
    return { [alias]: count };
  }

  // COALESCE(SUM(...)) queries — usa aggregation
  if (upper.includes("COALESCE") || upper.includes("SUM(") || upper.includes("GROUP BY")) {
    return await runAggregation(c, sql, params);
  }

  // JOIN queries
  if (upper.includes("JOIN")) {
    return await runJoinQuery(c, sql, params);
  }

  // Simple SELECT
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
  const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i);

  const filter = whereMatch ? parseWhere(whereMatch[1], params) : {};
  const sort = orderMatch ? parseOrder(orderMatch[1]) : {};
  const limit = limitMatch ? parseInt(limitMatch[1]) : undefined;

  let cursor = c.find(filter);
  if (Object.keys(sort).length) cursor = cursor.sort(sort);
  if (limit) cursor = cursor.limit(limit);

  const rows = await cursor.toArray();
  return rows[0] || null;
}

async function parseSelectAll(c, sql, params) {
  const upper = sql.toUpperCase();

  // JOIN queries
  if (upper.includes("JOIN")) {
    const rows = await runJoinQueryAll(c, sql, params);
    return rows;
  }

  // COALESCE/SUM/GROUP queries
  if (upper.includes("COALESCE") || upper.includes("SUM(") || upper.includes("GROUP BY")) {
    const result = await runAggregation(c, sql, params);
    return result ? [result] : [];
  }

  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
  const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i);

  const filter = whereMatch ? parseWhere(whereMatch[1], params) : {};
  const sort = orderMatch ? parseOrder(orderMatch[1]) : {};
  const limit = limitMatch ? parseInt(limitMatch[1]) : undefined;

  let cursor = c.find(filter);
  if (Object.keys(sort).length) cursor = cursor.sort(sort);
  if (limit) cursor = cursor.limit(limit);

  return await cursor.toArray();
}

async function parseExecQuery(c, sql, params) {
  const upper = sql.trim().toUpperCase();

  if (upper.startsWith("INSERT")) {
    return await handleInsert(c, sql, params);
  }
  if (upper.startsWith("UPDATE")) {
    return await handleUpdate(c, sql, params);
  }
  if (upper.startsWith("DELETE")) {
    return await handleDelete(c, sql, params);
  }
  return { changes: 0 };
}

async function handleInsert(c, sql, params) {
  // INSERT INTO table (col1, col2, ...) VALUES (?, ?, ...)
  const colsMatch = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES/i);
  const returning = sql.includes("RETURNING");

  if (colsMatch) {
    const cols = colsMatch[1].split(",").map(s => s.trim());
    const doc = {};
    let paramIdx = 0;
    for (const col of cols) {
      doc[col] = params[paramIdx++];
    }
    // Converter _id se existir
    if (doc.id && typeof doc.id === "string") {
      doc._id = doc.id;
      delete doc.id;
    }
    const result = await c.insertOne(doc);
    const insertedId = doc._id || result.insertedId;
    if (returning) {
      const row = await c.findOne({ _id: insertedId });
      return { lastInsertRowid: row?.id || insertedId, changes: 1 };
    }
    return { lastInsertRowid: insertedId, changes: 1 };
  }
  return { changes: 0 };
}

async function handleUpdate(c, sql, params) {
  // UPDATE table SET col1 = ?, col2 = ? WHERE col3 = ?
  const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
  const whereMatch = sql.match(/WHERE\s+(.+?)$/i);

  if (setMatch) {
    const setClause = setMatch[1];
    const setParts = setClause.split(",").map(s => s.trim());
    const update = {};
    let paramIdx = 0;

    for (const part of setParts) {
      const m = part.match(/^(\w+)\s*=\s*(.+)$/);
      if (m) {
        const [, field, expr] = m;
        if (expr.trim() === "?") {
          update[field] = params[paramIdx++];
        } else if (expr.toUpperCase().includes("NOW()")) {
          update[field] = new Date().toISOString();
        } else if (expr.includes("EXCLUDED.")) {
          // ON CONFLICT DO UPDATE SET field = EXCLUDED.field — skip for now
          continue;
        } else {
          // SEM eval: qualquer expressão não-`?`/NOW()/EXCLUDED consome o próximo
          // parâmetro posicional (o eval antigo era vetor de injeção de código).
          update[field] = params[paramIdx++];
        }
      }
    }

    const filter = whereMatch ? parseWhere(whereMatch[1], params.slice(paramIdx)) : {};
    const result = await c.updateMany(filter, { $set: update });
    return { changes: result.modifiedCount };
  }
  return { changes: 0 };
}

async function handleDelete(c, sql, params) {
  const whereMatch = sql.match(/WHERE\s+(.+?)$/i);
  const filter = whereMatch ? parseWhere(whereMatch[1], params) : {};
  const result = await c.deleteMany(filter);
  return { changes: result.deletedCount };
}

// ── Aggregation queries (reports) ─────────────────────────────────

async function runAggregation(c, sql, params) {
  const upper = sql.toUpperCase();
  const tableName = getTableName(sql);
  const allCols = await c.find({}).limit(1).toArray();
  const sample = allCols[0] || {};
  const userIdField = "user_id";

  // Dashboard: costs and revenue
  if (upper.includes("GASTOS") && upper.includes("QUANTIDADE") && upper.includes("VALOR_UNITARIO")) {
    const uid = params[0];
    const filter = { user_id: uid };
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const gastos = await c.find(filter).toArray();
    let custo_total = 0, custo_30d = 0;
    for (const g of gastos) {
      const custo = (g.quantidade || 0) * (g.valor_unitario || 0);
      custo_total += custo;
      if (g.data && g.data >= thirtyDaysAgo) custo_30d += custo;
    }
    return { custo_total, custo_30d };
  }

  if (upper.includes("COLHEITAS") && upper.includes("QUANTIDADE") && upper.includes("PRECO_VENDA")) {
    const uid = params[0];
    const filter = { user_id: uid };
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const colheitas = await c.find(filter).toArray();
    let receita_total = 0, receita_30d = 0;
    for (const col of colheitas) {
      const receita = (col.quantidade || 0) * (col.preco_venda || 0);
      receita_total += receita;
      if (col.data && col.data >= thirtyDaysAgo) receita_30d += receita;
    }
    return { receita_total, receita_30d };
  }

  // Performance: GROUP BY cultura
  if (upper.includes("GROUP BY")) {
    return await runGroupByAggregation(tableName, sql, params);
  }

  return null;
}

async function runGroupByAggregation(tableName, sql, params) {
  const uid = params[0];
  const plantios = await (await col("plantios")).find({ user_id: uid }).toArray();
  const colheitas = await (await col("colheitas")).find({ user_id: uid }).toArray();
  const gastos = await (await col("gastos")).find({ user_id: uid }).toArray();

  const groups = Object.create(null);
  for (const p of plantios) {
    const cult = p.cultura || "Outro";
    if (!groups[cult]) groups[cult] = { cultura: cult, plantios: 0, rendimento: 0, receita: 0, custo: 0 };

    groups[cult].plantios++;

    const cols = colheitas.filter(c => c.plantio_id === p.id);
    for (const c of cols) {
      groups[cult].rendimento += c.quantidade || 0;
      groups[cult].receita += (c.quantidade || 0) * (c.preco_venda || 0);
    }

    const gas = gastos.filter(g => g.plantio_id === p.id);
    for (const g of gas) {
      groups[cult].custo += (g.quantidade || 0) * (g.valor_unitario || 0);
    }
  }

  return Object.values(groups).sort((a, b) => b.receita - a.receita);
}

// ── JOIN queries (reports) ────────────────────────────────────────

async function runJoinQuery(c, sql, params) {
  const rows = await runJoinQueryAll(c, sql, params);
  return rows[0] || null;
}

async function runJoinQueryAll(c, sql, params) {
  const upper = sql.toUpperCase();
  const uid = params[0];

  // plantios JOIN lotes — dashboard pending harvests
  if (upper.includes("PLANTIOS") && upper.includes("LOTES")) {
    const plantios = await (await col("plantios")).find({
      user_id: uid,
      status: { $nin: ["colhido", "perdido"] },
      data_colheita_prevista: { $ne: null, $gte: new Date().toISOString().slice(0, 10) },
    }).sort({ data_colheita_prevista: 1 }).limit(25).toArray();

    const lotes = await (await col("lotes")).find({ user_id: uid }).toArray();
    const loteMap = Object.fromEntries(lotes.map(l => [l._id || l.id, l]));

    return plantios.map(p => ({
      ...p,
      id: p._id || p.id,
      lote_nome: loteMap[p.lote_id]?.nome || "",
    }));
  }

  return [];
}

// ── MongoDB migration (no-op — schemaless) ───────────────────────

export async function migrate() {
  const db = await getDb();

  const migrations = db.collection("migrations");
  const lotes = db.collection("lotes");
  const legacyLotes = await lotes
    .find({
      area: { $type: "number" },
      area_m2: { $exists: false },
    })
    .toArray();
  for (const lote of legacyLotes) {
    if (!Number.isFinite(lote.area)) continue;
    await lotes.updateOne(
      { _id: lote._id },
      { $set: { area_m2: lote.area, area: lote.area } }
    );
  }
  const canonicalLotes = await lotes
    .find({
      area_m2: { $type: "number" },
      $or: [{ area: { $exists: false } }, { area: null }],
    })
    .toArray();
  for (const lote of canonicalLotes) {
    if (!Number.isFinite(lote.area_m2)) continue;
    await lotes.updateOne(
      { _id: lote._id },
      { $set: { area: lote.area_m2 } }
    );
  }
  await migrations.updateOne(
    { _id: "lotes_area_m2_v1" },
    { $set: { updated_at: new Date().toISOString(), source: "area" } },
    { upsert: true }
  );

  // Documentos default sem owner não podem Satisfazer o índice único parcial;
  // deriva o owner disponível ou remove apenas a marca default.
  const projects = db.collection("projects");
  const orphanDefaults = await projects.find({
    is_default: true,
    $or: [{ owner_id: { $exists: false } }, { owner_id: null }, { owner_id: "" }],
  }).toArray();
  for (const project of orphanDefaults) {
    const derivedOwner = project.owner_key ?? project.created_by ?? null;
    if (derivedOwner !== null && derivedOwner !== undefined && String(derivedOwner).trim()) {
      await projects.updateOne({ _id: project._id }, { $set: { owner_id: derivedOwner, updated_at: new Date().toISOString() } });
    } else {
      await projects.updateOne({ _id: project._id }, { $unset: { is_default: "" }, $set: { updated_at: new Date().toISOString() } });
    }
  }

  // Garante um único projeto default por owner antes de criar o índice único.
  // Isso evita que uma corrida de primeiro login produza dois escopos default.
  const defaultGroups = await projects.aggregate([
    { $match: { is_default: true, owner_id: { $exists: true, $nin: [null, ""] } } },
    { $group: { _id: "$owner_id", ids: { $push: "$_id" } } },
  ]).toArray();
  for (const group of defaultGroups) {
    if (!Array.isArray(group.ids) || group.ids.length < 2) continue;
    const keep = await projects.find({ _id: { $in: group.ids } }).sort({ created_at: 1, _id: 1 }).limit(1).next();
    if (!keep) continue;
    await projects.updateMany(
      { _id: { $in: group.ids.filter((id) => String(id) !== String(keep._id)) }, is_default: true },
      { $unset: { is_default: "" }, $set: { updated_at: new Date().toISOString() } },
    );
  }

  // Remove tombstones duplicados antes do índice único por (projeto, entidade, id).
  const tombstonesCol = db.collection("tombstones");
  const duplicateTombstones = await tombstonesCol.aggregate([
    { $match: { project_id: { $exists: true }, entity: { $exists: true }, id: { $exists: true } } },
    { $group: { _id: { project_id: "$project_id", entity: "$entity", id: "$id" }, ids: { $push: "$_id" } } },
    { $match: { "ids.1": { $exists: true } } },
  ]).toArray();
  for (const group of duplicateTombstones) {
    const keep = await tombstonesCol.find({ _id: { $in: group.ids } })
      .sort({ seq: -1, updated_at: -1, _id: 1 }).limit(1).next();
    if (!keep) continue;
    await tombstonesCol.deleteMany({ _id: { $in: group.ids.filter((id) => String(id) !== String(keep._id)) } });
  }

  // Remove membros duplicados antes do índice único de (projeto, usuário).
  const membersCol = db.collection("project_members");
  const duplicateMembers = await membersCol.aggregate([
    { $match: { project_id: { $exists: true }, user_key: { $exists: true, $nin: [null, ""] } } },
    { $group: { _id: { project_id: "$project_id", user_key: "$user_key" }, ids: { $push: "$_id" } } },
    { $match: { "ids.1": { $exists: true } } },
  ]).toArray();
  for (const group of duplicateMembers) {
    const keep = await membersCol.find({ _id: { $in: group.ids } }).sort({ created_at: 1, _id: 1 }).limit(1).next();
    if (!keep) continue;
    await membersCol.deleteMany({ _id: { $in: group.ids.filter((id) => String(id) !== String(keep._id)) } });
  }

  // Mantém apenas o reset token mais recente por usuário.
  const resetCol = db.collection("password_resets");
  const duplicateResets = await resetCol.aggregate([
    { $match: { user_id: { $exists: true } } },
    { $sort: { created_at: -1 } },
    { $group: { _id: "$user_id", ids: { $push: "$_id" } } },
    { $match: { "ids.1": { $exists: true } } },
  ]).toArray();
  for (const group of duplicateResets) {
    await resetCol.deleteMany({ _id: { $in: group.ids.slice(1) } });
  }

  // Migra índices antigos non-unique para evitar IndexOptionsConflict em
  // bancos criados por versões anteriores.
  for (const [collectionName, key] of [
    ["project_members", { project_id: 1, user_key: 1 }],
    ["password_resets", { user_id: 1 }],
  ]) {
    const collection = db.collection(collectionName);
    try {
      await db.createCollection(collectionName);
    } catch (error) {
      if (error?.code !== 48 && error?.codeName !== "NamespaceExists") throw error;
    }
    const existing = (await collection.indexes()).find((index) => JSON.stringify(index.key) === JSON.stringify(key));
    if (existing && existing.unique !== true) await collection.dropIndex(existing.name);
  }

  // Sequência monotônica por projeto para tombstones. Ela permite paginação
  // determinística mesmo quando dois requests concorrentes deletam no
  // mesmo segundo.
  const tombstoneCol = db.collection("tombstones");
  const counterCol = db.collection("counters");
  const unsequencedTombstones = await tombstoneCol.find({ $or: [{ seq: { $exists: false } }, { seq: null }] }).sort({ updated_at: 1, _id: 1 }).toArray();
  for (const tombstone of unsequencedTombstones) {
    const projectKey = String(tombstone.project_id || "legacy");
    const counter = await counterCol.findOneAndUpdate(
      { _id: `tombstone:${projectKey}` },
      { $inc: { value: 1 }, $setOnInsert: { created_at: new Date().toISOString() } },
      { upsert: true, returnDocument: "after" },
    );
     const sequence = Number(counter?.value?.value ?? counter?.value ?? 0);
    if (Number.isSafeInteger(sequence) && sequence > 0) {
      await tombstoneCol.updateOne({ _id: tombstone._id, $or: [{ seq: { $exists: false } }, { seq: null }] }, { $set: { seq: sequence } });
    }
  }

  // Create indexes for performance
  const collections = [
    { name: "users", indexes: [{ key: { email: 1 }, unique: true }, { key: { user_key: 1 } }] },
    { name: "projects", indexes: [{ key: { owner_id: 1 } }, { key: { owner_id: 1, is_default: 1 }, unique: true, partialFilterExpression: { is_default: true } }, { key: { owner_id: 1, created_at: 1 } }] },
    { name: "project_members", indexes: [{ key: { project_id: 1 } }, { key: { project_id: 1, user_key: 1 }, unique: true, partialFilterExpression: { user_key: { $exists: true } } }, { key: { project_id: 1, user_id: 1 } }, { key: { project_id: 1, role_id: 1 } }, { key: { project_id: 1, email: 1 } }, { key: { project_id: 1, user_key: 1, status: 1 } }] },
    { name: "roles", indexes: [{ key: { project_id: 1 } }, { key: { project_id: 1, id: 1 } }, { key: { project_id: 1, system: 1 } }, { key: { project_id: 1, name: 1 } }] },
    { name: "lotes", indexes: [{ key: { user_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "plantios", indexes: [{ key: { user_id: 1 } }, { key: { lote_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "insumos", indexes: [{ key: { user_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "gastos", indexes: [{ key: { user_id: 1 } }, { key: { plantio_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "colheitas", indexes: [{ key: { user_id: 1 } }, { key: { plantio_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "subscriptions", indexes: [{ key: { user_id: 1 }, unique: true }] },
    { name: "push_subscriptions", indexes: [{ key: { user_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "weather_alerts", indexes: [{ key: { user_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "kv", indexes: [{ key: { key: 1 }, unique: true }] },
    { name: "clock_heartbeat", indexes: [{ key: { user_id: 1 }, unique: true }] },
    { name: "integrity_log", indexes: [{ key: { user_id: 1 } }, { key: { project_id: 1 } }] },
    { name: "integrity_score", indexes: [{ key: { user_id: 1 }, unique: true }] },
    { name: "outbox", indexes: [{ key: { created_at: 1 } }, { key: { project_id: 1 } }] },
    { name: "photos_metadata", indexes: [{ key: { user_id: 1 } }, { key: { plantio_id: 1 } }, { key: { lote_id: 1 } }, { key: { project_id: 1 } }] },
     { name: "ai_usage", indexes: [{ key: { user_id: 1, date: 1 } }, { key: { project_id: 1 } }] },
     { name: "tombstones", indexes: [{ key: { project_id: 1, entity: 1, id: 1 }, unique: true }, { key: { project_id: 1, updated_at: 1 } }, { key: { project_id: 1, seq: 1 } }] },
    // VULN-020: idempotência do webhook Stripe
    { name: "stripe_events", indexes: [{ key: { event_id: 1 }, unique: true }] },
    { name: "stripe_cancelled_subscriptions", indexes: [{ key: { stripe_subscription_id: 1 }, unique: true }] },
    { name: "email_verifications", indexes: [{ key: { user_id: 1 } }] },
    { name: "password_resets", indexes: [{ key: { user_id: 1 }, unique: true }] },
    { name: "collaborators", indexes: [{ key: { owner_id: 1 } }, { key: { user_id: 1 } }, { key: { project_id: 1 } }] },
  ];

  for (const { name, indexes } of collections) {
    const c = db.collection(name);
    for (const idx of indexes) {
      await c.createIndex(idx.key, {
        unique: idx.unique || false,
        background: true,
        ...(idx.partialFilterExpression ? { partialFilterExpression: idx.partialFilterExpression } : {}),
      });
    }
  }
}

export async function bumpUsersSequence() {
  // No-op — MongoDB uses ObjectId or custom IDs
}

function isUnsupportedTransactionError(error) {
  const message = [error?.message, error?.errmsg, error?.cause?.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (message.includes("current topology does not support sessions")) return true;
  if (message.includes("transaction numbers are only allowed")) return true;
  if (message.includes("transactions are not supported")) return true;
  if (message.includes("transaction is not supported")) return true;
  if (message.includes("replica set member or mongos")) return true;
  return false;
}

export async function withMongoTransaction(fn, { fallback } = {}) {
  await getDb();
  const session = client.startSession();
  let result;
  let failure;
  try {
    await session.withTransaction(async () => {
      result = await fn(session);
    });
  } catch (error) {
    failure = error;
  } finally {
    await session.endSession();
  }
  if (failure) {
    if (typeof fallback === "function" && isUnsupportedTransactionError(failure)) {
      return fallback();
    }
    throw failure;
  }
  return result;
}

export async function withTransaction(fn) {
  const db = await getDb();
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const t = {
        prepare(sql) {
          const trimmed = sql.trim();
          return {
            async get(...params) {
              const c = db.collection(getTableName(trimmed));
              return await parseSelectQuery(c, trimmed, params);
            },
            async all(...params) {
              const c = db.collection(getTableName(trimmed));
              return await parseSelectAll(c, trimmed, params);
            },
            async run(...params) {
              const c = db.collection(getTableName(trimmed));
              return await parseExecQuery(c, trimmed, params);
            },
          };
        },
        async exec() {},
      };
      return await fn(t);
    });
  } finally {
    await session.endSession();
  }
}

export const requiredFor = {
  lotes: ["nome"],
  plantios: ["lote_id", "cultura", "data_plantio"],
  insumos: ["nome"],
  gastos: ["plantio_id", "data"],
  colheitas: ["plantio_id", "data", "quantidade"],
};

export const copyable = {
  lotes: ["nome", "tipo", "area_m2", "area", "localizacao"],
  plantios: ["lote_id", "cultura", "cultivar", "data_plantio", "data_colheita_prevista", "qtd_plantada", "unidade", "status"],
  insumos: ["nome", "categoria", "unidade"],
  gastos: ["plantio_id", "insumo_id", "descricao", "quantidade", "valor_unitario", "data"],
  colheitas: ["plantio_id", "data", "quantidade", "unidade", "preco_venda"],
};

export function copyableFields(entity, raw = {}) {
  const fields = [...(copyable[entity] || [])];
  const input = raw && typeof raw === "object" ? raw : {};
  if (entity === "lotes" && (Object.hasOwn(input, "area_m2") || Object.hasOwn(input, "area"))) {
    return [...new Set([...fields, "area_m2", "area"])];
  }
  return fields;
}
