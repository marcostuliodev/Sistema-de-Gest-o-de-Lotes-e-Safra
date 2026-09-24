import { db, isOnline, mergeLocalWith, type OutboxRow } from "./db";
import { pushSync } from "./api";
import type { EntityName } from "./types";
import type { Table } from "dexie";

const SYNC_BATCH_SIZE = 40; // abaixo do limite de 100 ops do servidor

let syncing = false;
let syncRequested = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Agenda sync em background sem adicionar atraso artificial ao salvamento local. */
function requestSync() {
  syncRequested = true;
  if (syncing || syncTimer !== null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void runSync();
  }, 0);
}

/** Grava localmente + enfileira para sync. Funciona 100% offline. */
export async function saveLocal(entity: EntityName, record: { id: string }) {
  const table = db[entity] as Table<{ id: string }, string>;
  await db.transaction("rw", table, db.outbox, async () => {
    await table.put(record);
    await db.outbox.add({ op: { entity, action: "upsert", data: record }, created_at: Date.now() });
  });
  window.dispatchEvent(new Event("agrolote:outbox-change"));
  requestSync();
}

/** Remove localmente + enfileira. */
export async function removeLocal(entity: EntityName, id: string) {
  const table = db[entity] as Table<{ id: string }, string>;
  await db.transaction("rw", table, db.outbox, async () => {
    await table.delete(id);
    await db.outbox.add({ op: { entity, action: "delete", data: { id } }, created_at: Date.now() });
  });
  window.dispatchEvent(new Event("agrolote:outbox-change"));
  requestSync();
}

export async function outboxCount() {
  return db.outbox.count();
}

async function pendingOps(): Promise<OutboxRow[]> {
  return db.outbox.orderBy("created_at").toArray();
}

async function applySnapshot(result: { snapshot: any; serverTime: string }) {
  // Se o merge falhar, não removemos o lote: a operação será tentada novamente.
  await mergeLocalWith(result.snapshot);
  await db.meta.put({ key: "last_sync", value: result.serverTime });
}

async function runSync(): Promise<boolean> {
  if (!isOnline()) return false;
  if (syncing) {
    syncRequested = true;
    return false;
  }

  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  syncing = true;
  try {
    do {
      syncRequested = false;
      const pending = await pendingOps();
      if (pending.length === 0) break;

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
    } while (syncRequested || (await outboxCount()) > 0);

    window.dispatchEvent(new CustomEvent("agrolote:synced"));
    return true;
  } catch (err) {
    if (import.meta.env.DEV) console.warn("Sync falhou (modo offline):", err);
    window.dispatchEvent(new CustomEvent("agrolote:sync-error"));
    return false;
  } finally {
    syncing = false;
    if (syncRequested && isOnline()) requestSync();
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

export function startSyncWatcher(): () => void {
  const onOnline = () => requestSync();
  const onVisibility = () => {
    if (document.visibilityState === "visible") requestSync();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("agrolote:outbox-change", requestSync);
  window.addEventListener("agrolote:local-change", requestSync);
  window.addEventListener("visibilitychange", onVisibility);
  const intervalId = setInterval(() => requestSync(), 60000);
  requestSync();
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("agrolote:outbox-change", requestSync);
    window.removeEventListener("agrolote:local-change", requestSync);
    window.removeEventListener("visibilitychange", onVisibility);
    clearInterval(intervalId);
    if (syncTimer !== null) clearTimeout(syncTimer);
  };
}

export { runSync, syncing };
