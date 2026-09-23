import { MongoClient, ObjectId, GridFSBucket } from "mongodb";

const MONGO_URL = process.env.MONGODB_URI || process.env.DATABASE_URL;
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

export function getGridFSBucket() {
  if (_gridFSBucket) return _gridFSBucket;
  // _db must be initialized before calling this
  if (!_db) throw new Error("GridFSBucket: database not initialized");
  _gridFSBucket = new GridFSBucket(_db);
  return _gridFSBucket;
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

  const groups = {};
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

  // Create indexes for performance
  const collections = [
    { name: "users", indexes: [{ key: { email: 1 }, unique: true }] },
    { name: "lotes", indexes: [{ key: { user_id: 1 } }] },
    { name: "plantios", indexes: [{ key: { user_id: 1 } }, { key: { lote_id: 1 } }] },
    { name: "insumos", indexes: [{ key: { user_id: 1 } }] },
    { name: "gastos", indexes: [{ key: { user_id: 1 } }, { key: { plantio_id: 1 } }] },
    { name: "colheitas", indexes: [{ key: { user_id: 1 } }, { key: { plantio_id: 1 } }] },
    { name: "subscriptions", indexes: [{ key: { user_id: 1 }, unique: true }] },
    { name: "push_subscriptions", indexes: [{ key: { user_id: 1 } }] },
    { name: "weather_alerts", indexes: [{ key: { user_id: 1 } }] },
    { name: "kv", indexes: [{ key: { key: 1 }, unique: true }] },
    { name: "clock_heartbeat", indexes: [{ key: { user_id: 1 }, unique: true }] },
    { name: "integrity_log", indexes: [{ key: { user_id: 1 } }] },
    { name: "integrity_score", indexes: [{ key: { user_id: 1 }, unique: true }] },
    { name: "outbox", indexes: [{ key: { created_at: 1 } }] },
    { name: "photos_metadata", indexes: [{ key: { user_id: 1 } }, { key: { plantio_id: 1 } }, { key: { lote_id: 1 } }] },
    // VULN-020: idempotência do webhook Stripe
    { name: "stripe_events", indexes: [{ key: { event_id: 1 }, unique: true }] },
    { name: "email_verifications", indexes: [{ key: { user_id: 1 } }] },
    { name: "password_resets", indexes: [{ key: { user_id: 1 } }] },
    { name: "collaborators", indexes: [{ key: { owner_id: 1 } }, { key: { user_id: 1 } }] },
  ];

  for (const { name, indexes } of collections) {
    const c = db.collection(name);
    for (const idx of indexes) {
      await c.createIndex(idx.key, { unique: idx.unique || false, background: true });
    }
  }
}

export async function bumpUsersSequence() {
  // No-op — MongoDB uses ObjectId or custom IDs
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
  lotes: ["nome", "tipo", "area", "localizacao"],
  plantios: ["lote_id", "cultura", "cultivar", "data_plantio", "data_colheita_prevista", "qtd_plantada", "unidade", "status"],
  insumos: ["nome", "categoria", "unidade"],
  gastos: ["plantio_id", "insumo_id", "descricao", "quantidade", "valor_unitario", "data"],
  colheitas: ["plantio_id", "data", "quantidade", "unidade", "preco_venda"],
};
