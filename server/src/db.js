import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "agrolote.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lotes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'talhao',
      area REAL,
      localizacao TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS colheitas (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plantio_id TEXT NOT NULL REFERENCES plantios(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      quantidade REAL NOT NULL,
      unidade TEXT DEFAULT 'kg',
      preco_venda REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
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