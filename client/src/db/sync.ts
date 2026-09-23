import { db, isOnline, mergeLocalWith, type OutboxRow } from "./db";
import { pushSync } from "./api";
import type { EntityName } from "./types";
import type { Table } from "dexie";

const SYNC_BATCH_SIZE = 40; // abaixo do limite de 100 ops do servidor

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
 * Envia apenas o que está pendente. Reenviar todos os registros locais a cada
 * sync duplicava operações e podia ultrapassar o limite de 100 do servidor,
 * deixando o outbox travado para sempre.
 */
async function pendingOps(): Promise<OutboxRow[]> {
  return db.outbox.orderBy("created_at").toArray();
}

async function applySnapshot(result: { snapshot: any; serverTime: string }) {
  // Se o merge falhar, não removemos o lote: a operação será tentada novamente.
  await mergeLocalWith(result.snapshot);
  await db.meta.put({ key: "last_sync", value: result.serverTime });
}

async function runSync(): Promise<boolean> {
  if (syncing || !isOnline()) return false;
  const pending = await pendingOps();
  if (pending.length === 0) return false;

  syncing = true;
  try {
    for (let start = 0; start < pending.length; start += SYNC_BATCH_SIZE) {
      const batch = pending.slice(start, start + SYNC_BATCH_SIZE);
      const result = await pushSync(batch.map((row) => row.op));
      if (!result?.snapshot) return false;

      await applySnapshot(result);
      const ids = batch
        .map((row) => row.id)
        .filter((id): id is number => typeof id === "number");
      if (ids.length > 0) await db.outbox.bulkDelete(ids);
    }

    window.dispatchEvent(new CustomEvent("agrolote:synced"));
    return true;
  } catch (err) {
    if (import.meta.env.DEV) console.warn("Sync falhou (modo offline):", err);
    window.dispatchEvent(new CustomEvent("agrolote:sync-error"));
    return false;
  } finally {
    syncing = false;
  }
}

/** Baixa o snapshot do servidor sem apagar operações offline pendentes. */
export async function pullServer() {
  if (!isOnline()) return false;
  try {
    const result = await pushSync([]);
    if (!result?.snapshot) return false;
    await applySnapshot(result);
    window.dispatchEvent(new CustomEvent("agrolote:synced"));
    return true;
  } catch {
    return false;
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function fireSyncDebounced() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runSync(), 1500);
}

export function startSyncWatcher(): () => void {
  const onOnline = () => void runSync();
  const onLocal = () => void runSync();
  const onVisibility = () => { if (document.visibilityState === "visible") void runSync(); };
  window.addEventListener("online", onOnline);
  window.addEventListener("agrolote:local-change", onLocal);
  window.addEventListener("agrolote:synced", onLocal);
  window.addEventListener("visibilitychange", onVisibility);
  const intervalId = setInterval(() => void runSync(), 60000);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("agrolote:local-change", onLocal);
    window.removeEventListener("agrolote:synced", onLocal);
    window.removeEventListener("visibilitychange", onVisibility);
    clearInterval(intervalId);
  };
}

export { runSync, syncing };