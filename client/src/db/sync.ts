import { db, isOnline, mergeLocalWith } from "./db";
import { pushSync } from "./api";
import type { EntityName, SyncOp } from "./types";
import type { Table } from "dexie";

const ENTITY_TABLES: EntityName[] = ["lotes", "plantios", "insumos", "gastos", "colheitas"];

let syncing = false;

/** Grava localmente + enfileira para sync. Funciona 100% offline. */
export async function saveLocal(entity: EntityName, record: { id: string }) {
  const table = db[entity] as Table<{ id: string }, string>;
  await db.transaction("rw", table, db.outbox, async () => {
    await table.put(record);
    await db.outbox.add({ op: { entity, action: "upsert", data: record }, created_at: Date.now() });
  });
  fireSyncDebounced();
}

/** Remove localmente + enfileira. */
export async function removeLocal(entity: EntityName, id: string) {
  const table = db[entity] as Table<{ id: string }, string>;
  await db.transaction("rw", table, db.outbox, async () => {
    await table.delete(id);
    await db.outbox.add({ op: { entity, action: "delete", data: { id } }, created_at: Date.now() });
  });
  fireSyncDebounced();
}

export async function outboxCount() {
  return db.outbox.count();
}

/**
 * Sobe o outbox (criações/edições/deletes offline) + TODOS os dados locais.
 * Por que mandar tudo? O disco gratuito do Render (e de outros PaaS) é volátil:
 * se o servidor reiniciar vazio, este re-upload reconstrói os dados do aparelho
 * no servidor automaticamente — os ids são UUIDs, então não cria duplicidade.
 */
async function buildOps(): Promise<SyncOp[]> {
  const ops: SyncOp[] = (await db.outbox.orderBy("created_at").toArray()).map((r) => r.op);
  for (const entity of ENTITY_TABLES) {
    const records = await (db[entity] as Table<{ id: string }, string>).toArray();
    for (const rec of records) ops.push({ entity, action: "upsert", data: rec });
  }
  return ops;
}

async function commit(result: { snapshot: any; serverTime: string }) {
  // mergeLocalWith já abre sua própria transação. Não podemos aninhar uma
  // transação de outbox-only aqui, senão o Dexie lança erro ao tocar as
  // outras tabelas e o outbox nunca é limpo (UI fica "Sincronizando" p/ sempre).
  await mergeLocalWith(result.snapshot);
  await db.outbox.clear();
  await db.meta.put({ key: "last_sync", value: result.serverTime });
  window.dispatchEvent(new CustomEvent("agrolote:synced"));
}

async function runSync(): Promise<boolean> {
  if (syncing || !isOnline()) return false;
  syncing = true;
  try {
    const result = await pushSync(await buildOps());
    if (result?.snapshot) {
      await commit(result);
      return true;
    }
  } catch (err) {
    if (import.meta.env.DEV) console.warn("Sync falhou (modo offline):", err);
  } finally {
    syncing = false;
  }
  return false;
}

/** Baixa o snapshot do servidor para o banco local (usado após o login). */
export async function pullServer() {
  const result = await pushSync(await buildOps());
  if (result?.snapshot) {
    await commit(result);
    return true;
  }
  return false;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function fireSyncDebounced() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runSync(), 1500);
}

export function startSyncWatcher() {
  const onOnline = () => void runSync();
  const onLocal = () => void runSync();
  window.addEventListener("online", onOnline);
  window.addEventListener("agrolote:local-change", onLocal);
  window.addEventListener("agrolote:synced", onLocal);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void runSync();
  });
  setInterval(() => void runSync(), 60000);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("local-change", onLocal);
    window.removeEventListener("synced", onLocal);
  };
}

export { runSync, syncing };