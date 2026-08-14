import pg from "pg";

const connStr = process.env.DATABASE_URL;
const ssl =
  connStr && (connStr.includes("render.com") || connStr.includes("sslmode=require"))
    ? { rejectUnauthorized: false }
    : undefined;

const pool = new pg.Pool({
  connectionString: connStr,
  ssl,
  max: 10,
  // Falha rápido se o banco não responder, em vez de travar a requisição até
  // o proxy do Render estourar (502).
  connectionTimeoutMillis: 5000,
  application_name: "agrolote",
});

if (!connStr) {
  console.error(
    "FATAL: DATABASE_URL não definida. O PostgreSQL (Render) precisa ser provisionado e conectado ao serviço web (re-aplique o Blueprint). Sem isso, nenhuma rota de API funciona."
  );
}

// Converte "?" (estilo SQLite) em "$1, $2, ..." (estilo pg).
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makePrepared(client) {
  return (sql) => {
    const pgSql = toPg(sql);
    return {
      async get(...params) {
        const r = await client.query(pgSql, params);
        return r.rows[0];
      },
      async all(...params) {
        const r = await client.query(pgSql, params);
        return r.rows;
      },
      async run(...params) {
        const r = await client.query(pgSql, params);
        return { lastInsertRowid: r.rows[0]?.id, changes: r.rowCount ?? 0 };
      },
    };
  };
}

export function prepare(sql) {
  return makePrepared(pool)(sql);
}

export const db = {
  prepare,
  async exec(sql) {
    await pool.query(sql);
  },
  pool,
};

const MIGRATION = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now()::text
);

CREATE TABLE IF NOT EXISTS lotes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'talhao',
  area REAL,
  localizacao TEXT,
  created_at TEXT NOT NULL DEFAULT now()::text
);

CREATE TABLE IF NOT EXISTS plantios (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lote_id TEXT NOT NULL REFERENCES lotes(id) ON DELETE CASCADE,
  cultura TEXT NOT NULL,
  cultivar TEXT,
  data_plantio TEXT NOT NULL,
  data_colheita_prevista TEXT,
  qtd_plantada REAL,
  unidade TEXT DEFAULT 'un',
  status TEXT NOT NULL DEFAULT 'ativo',
  created_at TEXT NOT NULL DEFAULT now()::text
);

CREATE TABLE IF NOT EXISTS insumos (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  categoria TEXT,
  unidade TEXT DEFAULT 'un'
);

CREATE TABLE IF NOT EXISTS gastos (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plantio_id TEXT NOT NULL REFERENCES plantios(id) ON DELETE CASCADE,
  insumo_id TEXT REFERENCES insumos(id) ON DELETE SET NULL,
  descricao TEXT,
  quantidade REAL NOT NULL DEFAULT 1,
  valor_unitario REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now()::text
);

CREATE TABLE IF NOT EXISTS colheitas (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plantio_id TEXT NOT NULL REFERENCES plantios(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  quantidade REAL NOT NULL,
  unidade TEXT DEFAULT 'kg',
  preco_venda REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT now()::text
);

-- Localização da propriedade para o módulo de clima (adicionado depois do
-- banco já existir em produção, por isso ADD COLUMN IF NOT EXISTS).
ALTER TABLE users ADD COLUMN IF NOT EXISTS lat REAL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lon REAL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tz TEXT;

-- Chave-valor do servidor (ex.: chaves VAPID de push, estável entre reinícios).
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Inscrições de Web Push por usuário.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now()::text
);

-- Histórico de alertas climáticos enviados (usado p/ debounce e exibição).
CREATE TABLE IF NOT EXISTS weather_alerts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT now()::text
);
`;

export async function migrate() {
  const stmts = MIGRATION.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) {
    await pool.query(s);
  }
}

// Garante que a sequence de users acompanhe ids inseridos manualmente
// (usado no sync, onde o id vem do cliente).
export async function bumpUsersSequence() {
  await pool.query(
    "SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users), 1))"
  );
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  let result;
  try {
    await client.query("BEGIN");
    const t = { prepare: makePrepared(client), exec: async (s) => client.query(s) };
    result = await fn(t);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
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
