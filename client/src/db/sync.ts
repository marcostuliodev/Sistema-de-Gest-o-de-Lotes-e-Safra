import { getActiveAgroloteDB, getActiveScope, isOnline, mergeLocalWith, type ActiveScope, type OutboxRow } from "./db";
import { getSession, pushSync, type TombstoneCursor } from "./api";
import type { EntityName, Snapshot, SyncOp, SyncTombstone } from "./types";
import type { Table } from "dexie";

const SYNC_BATCH_SIZE = 40;
const LAST_SYNC_KEY = "last_sync";
const TOMBSTONE_CURSOR_KEY = "tombstone_cursor";
const DATA_ENTITIES_FOR_SYNC = ["lotes", "plantios", "insumos", "gastos", "colheitas"] as const;

let syncing = false;
let syncRequested = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function currentSyncScope(): ActiveScope | null {
  const session = getSession();
  const scope = getActiveScope();
  const accountId = String(session?.user.user_key || session?.user.id || "");
  if (!session || !scope || String(session.user.id) !== scope.userId || accountId !== scope.accountId) return null;
  return scope;
}

function requireSyncScope(): ActiveScope {
  const scope = currentSyncScope();
  if (!scope) throw new Error("Sessão ou projeto ausente");
  return scope;
}

function dispatchOutboxChange(scope: ActiveScope) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("agrolote:outbox-change", {
    detail: { userId: scope.userId, projectId: scope.projectId },
  }));
}

function dispatchSyncError(scope: ActiveScope, message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("agrolote:sync-error", {
    detail: { userId: scope.userId, projectId: scope.projectId, message },
  }));
}

function requestSync() {
  if (!currentSyncScope()) return;
  syncRequested = true;
  if (syncing || syncTimer !== null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void runSync();
  }, 0);
}

export async function saveLocal(entity: EntityName, record: { id: string }) {
  const scope = requireSyncScope();
  const target = getActiveAgroloteDB(scope);
  if (!target) throw new Error("Projeto ativo indisponível");
  const table = target[entity] as Table<{ id: string }, string>;
  const raw = { ...record } as Record<string, unknown>;
  delete raw.project_id;
  delete raw.account_id;
  if (entity === "lotes") {
    if (raw.area_m2 === undefined && raw.area !== undefined) raw.area_m2 = raw.area;
    delete raw.area;
  }
  const data = { ...raw, id: record.id };
  await target.transaction("rw", table, target.outbox, async () => {
     const blocked = await target.outbox
       .filter((row) => row.status === "blocked" && row.op.entity === entity && String(row.op.data.id) === String(record.id))
       .toArray();
     if (blocked.length > 0) await target.outbox.bulkDelete(blocked.map((row) => row.id).filter((id): id is number => typeof id === "number"));
     const priorPending = await target.outbox
       .filter((row) => row.status !== "blocked" && row.op.entity === entity && String(row.op.data.id) === String(record.id))
       .limit(1)
       .count();
     const baseUpdatedAt = priorPending === 0 && typeof raw.updated_at === "string" ? raw.updated_at : undefined;
     await table.put({ ...data, project_id: scope.projectId, account_id: scope.accountId } as never);
     await target.outbox.add({
       op: {
         entity,
           action: "upsert",
           data,
           op_id: crypto.randomUUID(),
         ...(baseUpdatedAt ? { base_updated_at: baseUpdatedAt } : {}),
       },
       created_at: Date.now(),
       status: "pending",
       project_id: scope.projectId,
      account_id: scope.accountId,
    });
  });
  dispatchOutboxChange(scope);
  requestSync();
}

interface LocalDependencies {
  plantios: Record<string, any>[];
  gastos: Record<string, any>[];
  colheitas: Record<string, any>[];
  blocking: number;
}

async function localDependencies(target: NonNullable<ReturnType<typeof getActiveAgroloteDB>>, entity: EntityName, id: string): Promise<LocalDependencies> {
  const [plantios, gastos, colheitas] = await Promise.all([
    target.plantios.toArray(),
    target.gastos.toArray(),
    target.colheitas.toArray(),
  ]) as unknown as [Record<string, any>[], Record<string, any>[], Record<string, any>[]];
  if (entity === "lotes") {
    const ids = new Set(plantios.filter((row) => String(row.lote_id) === id).map((row) => String(row.id)));
    const relatedGastos = gastos.filter((row) => ids.has(String(row.plantio_id)));
    const relatedColheitas = colheitas.filter((row) => ids.has(String(row.plantio_id)));
    const relatedPlantios = plantios.filter((row) => ids.has(String(row.id)));
    return {
      plantios: relatedPlantios,
      gastos: relatedGastos,
      colheitas: relatedColheitas,
      blocking: relatedPlantios.length + relatedGastos.length + relatedColheitas.length,
    };
  }
  if (entity === "plantios") {
    const relatedGastos = gastos.filter((row) => String(row.plantio_id) === id);
    const relatedColheitas = colheitas.filter((row) => String(row.plantio_id) === id);
    return { plantios: [], gastos: relatedGastos, colheitas: relatedColheitas, blocking: relatedGastos.length + relatedColheitas.length };
  }
  if (entity === "insumos") {
    const relatedGastos = gastos.filter((row) => String(row.insumo_id) === id);
    return { plantios: [], gastos: relatedGastos, colheitas: [], blocking: 0 };
  }
  return { plantios: [], gastos: [], colheitas: [], blocking: 0 };
}

function localData(record: Record<string, any>): Record<string, unknown> & { id: string } {
  const data = { ...record } as Record<string, unknown> & { id: string };
  delete data.project_id;
  delete data.account_id;
  return data;
}

export async function removeLocal(entity: EntityName, id: string, cascade = false) {
  const scope = requireSyncScope();
  const target = getActiveAgroloteDB(scope);
  if (!target) throw new Error("Projeto ativo indisponível");
  const dependencies = await localDependencies(target, entity, id);
  if (!cascade && dependencies.blocking > 0) {
    const error = new Error(`Há ${dependencies.blocking} dependência(s) local(is). Escolha a exclusão em cascata.`) as Error & { code?: string; count?: number };
    error.code = "DEPENDENTS_EXIST";
    error.count = dependencies.blocking;
    throw error;
  }

  const rollback: Record<string, Record<string, unknown>[]> = {};
  const parent = await (target[entity] as Table<{ id: string }, string>).get(id);
  if (parent) rollback[entity] = [parent as unknown as Record<string, unknown>];
  if (cascade && entity === "lotes") {
    rollback.plantios = dependencies.plantios as unknown as Record<string, unknown>[];
    rollback.gastos = dependencies.gastos as unknown as Record<string, unknown>[];
    rollback.colheitas = dependencies.colheitas as unknown as Record<string, unknown>[];
  } else if (cascade && entity === "plantios") {
    rollback.gastos = dependencies.gastos as unknown as Record<string, unknown>[];
    rollback.colheitas = dependencies.colheitas as unknown as Record<string, unknown>[];
  } else if (cascade && entity === "insumos") {
    rollback.gastos = dependencies.gastos as unknown as Record<string, unknown>[];
  } else if (!cascade && entity === "insumos") {
    rollback.gastos = dependencies.gastos as unknown as Record<string, unknown>[];
  }

  const allTables = [target.lotes, target.plantios, target.insumos, target.gastos, target.colheitas, target.outbox];
  let rollbackOperations: SyncOp[] = [];
  await target.transaction("rw", allTables, async () => {
    const table = target[entity] as Table<{ id: string }, string>;
    const affectedIds = new Set<string>([id, ...dependencies.plantios.map((row) => String(row.id)), ...dependencies.gastos.map((row) => String(row.id)), ...dependencies.colheitas.map((row) => String(row.id))]);
    const pending = await target.outbox.toArray();
     const obsolete = pending.filter((row) => affectedIds.has(String(row.op.data.id)) && ["lotes", "plantios", "insumos", "gastos", "colheitas"].includes(String(row.op.entity)));
     rollbackOperations = obsolete.map((row) => row.op);
    if (obsolete.length > 0) await target.outbox.bulkDelete(obsolete.map((row) => row.id).filter((value): value is number => typeof value === "number"));
    if (cascade) {
      if (entity === "lotes") {
        await target.gastos.bulkDelete(dependencies.gastos.map((row) => row.id));
        await target.colheitas.bulkDelete(dependencies.colheitas.map((row) => row.id));
        await target.plantios.bulkDelete(dependencies.plantios.map((row) => row.id));
      } else if (entity === "plantios") {
        await target.gastos.bulkDelete(dependencies.gastos.map((row) => row.id));
        await target.colheitas.bulkDelete(dependencies.colheitas.map((row) => row.id));
      } else if (entity === "insumos") {
        await target.gastos.bulkDelete(dependencies.gastos.map((row) => row.id));
      }
    } else if (entity === "insumos") {
      for (const row of dependencies.gastos) {
        const updated = { ...row, insumo_id: null, project_id: scope.projectId, account_id: scope.accountId };
        await target.gastos.put(updated as never);
        await target.outbox.add({
           op: { entity: "gastos", action: "upsert", data: localData(updated), op_id: crypto.randomUUID() },
          created_at: Date.now(),
          project_id: scope.projectId,
          account_id: scope.accountId,
        });
      }
    }
    await table.delete(id);
    await target.outbox.add({
       op: {
         entity,
         action: "delete",
         data: { id, ...(cascade ? { cascade: true } : {}) },
         ...(cascade ? { cascade: true } : {}),
         op_id: crypto.randomUUID(),
         rollback,
         ...(rollbackOperations.length > 0 ? { rollback_operations: rollbackOperations } : {}),
       },
       created_at: Date.now(),
       status: "pending",
       project_id: scope.projectId,
      account_id: scope.accountId,
    });
  });
  dispatchOutboxChange(scope);
  requestSync();
}

export async function outboxCount() {
  const session = getSession();
  const scope = getActiveScope();
  if (!session || !scope || String(session.user.id) !== scope.userId) return 0;
  const target = getActiveAgroloteDB(scope);
  return target ? target.outbox.count() : 0;
}

async function pendingOps(target: NonNullable<ReturnType<typeof getActiveAgroloteDB>>): Promise<OutboxRow[]> {
  const rows = await target.outbox.filter((row) => row.status !== "blocked").toArray();
  return rows.sort((left, right) => left.created_at - right.created_at);
}

async function applySnapshot(
  result: {
    snapshot: Snapshot;
    serverTime: string;
    tombstones?: SyncTombstone[];
    deletedEntities?: { entity: string; id: string }[];
    tombstoneCursor?: TombstoneCursor;
  },
  scope: ActiveScope,
) {
  const target = getActiveAgroloteDB(scope);
  if (!target) throw new Error("Projeto ativo mudou");
  const snapshot = result.tombstones
    ? { ...result.snapshot, tombstones: result.tombstones }
    : result.snapshot;
  await mergeLocalWith(snapshot, scope, result.deletedEntities || []);
  if (getActiveAgroloteDB(scope) !== target) throw new Error("Projeto ativo mudou");
  await target.meta.put({
    key: LAST_SYNC_KEY,
    value: result.serverTime,
    project_id: scope.projectId,
    account_id: scope.accountId,
  });
  if (result.tombstoneCursor) {
    await target.meta.put({
      key: TOMBSTONE_CURSOR_KEY,
      value: result.tombstoneCursor,
      project_id: scope.projectId,
      account_id: scope.accountId,
    });
  }
}

async function restoreRollback(target: NonNullable<ReturnType<typeof getActiveAgroloteDB>>, row: OutboxRow): Promise<void> {
  const rollback = row.op.rollback;
  if (!rollback || typeof rollback !== "object") return;
  for (const [entity, rows] of Object.entries(rollback)) {
    if (!DATA_ENTITIES_FOR_SYNC.includes(entity as any) || !Array.isArray(rows) || rows.length === 0) continue;
    const table = target[entity as keyof typeof target] as Table<{ id: string }, string>;
    await table.bulkPut(rows as never[]);
  }
}

async function restoreRollbackOperations(
  target: NonNullable<ReturnType<typeof getActiveAgroloteDB>>,
  row: OutboxRow,
  scope: ActiveScope,
): Promise<void> {
  const operations = row.op.rollback_operations;
  if (!Array.isArray(operations) || operations.length === 0) return;
  for (const op of operations) {
    const existing = await target.outbox.filter((candidate) => Boolean(candidate.op.op_id && candidate.op.op_id === op.op_id)).count();
    if (existing > 0) continue;
    await target.outbox.add({
      op,
      created_at: Date.now(),
      status: "pending",
      project_id: scope.projectId,
      account_id: scope.accountId,
    });
  }
}

async function runSync(): Promise<boolean> {
  if (!isOnline()) return false;
  const scope = currentSyncScope();
  const target = getActiveAgroloteDB(scope || undefined);
  if (!scope || !target) return false;
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
    let tombstoneCursor = (await target.meta.get(TOMBSTONE_CURSOR_KEY))?.value as TombstoneCursor | undefined;
    do {
      syncRequested = false;
      const pending = await pendingOps(target);
      if (pending.length === 0) {
        const pull = await pushSync([], scope, tombstoneCursor);
        if (!pull?.snapshot) return false;
        await applySnapshot(pull, scope);
        tombstoneCursor = pull.tombstoneCursor || tombstoneCursor;
        syncRequested = pull.tombstoneHasMore === true;
        continue;
      }

      let rejectedOps: { index: number; entity: string | null; action: string | null; code: string; error?: string; count?: number }[] = [];
      for (let start = 0; start < pending.length; start += SYNC_BATCH_SIZE) {
        const batch = pending.slice(start, start + SYNC_BATCH_SIZE);
        const wireOps = batch.map((row) => {
           const { rollback: _rollback, rollback_operations: _rollbackOperations, ...op } = row.op;
          return op;
        });
        const result = await pushSync(wireOps, scope, tombstoneCursor);
        if (!result?.snapshot) return false;

         const failed = result.failedOps || [];
         const permanentCodes = new Set([
           "PLAN_LIMIT",
           "PERMISSION_DENIED",
           "PROJECT_SCOPE",
           "PROJECT_REFERENCE_INVALID",
           "DEPENDENTS_EXIST",
           "NOT_FOUND",
           "INVALID_CASCADE",
            "SYNC_INVALID",
            "TOMBSTONE_CONFLICT",
            "SYNC_CONFLICT",
            "TRANSACTIONS_REQUIRED",
          ]);
         for (const failure of failed) {
             const row = batch[failure.index];
             if (!row || typeof row.id !== "number") continue;
             if (failure.retryable || failure.code === "SYNC_RETRY") continue;
              if (row.op.action === "delete") {
               // Uma exclusão recusada não pode ser simplesmente removida do
               // outbox: o snapshot pode vir sem o registro para um papel sem
               // read. Restaura o backup e deixa a operação bloqueada para
               // resolução explícita.
               await restoreRollback(target, row);
               await restoreRollbackOperations(target, row, scope);
               await target.outbox.update(row.id, {
                 status: "blocked",
                 error: failure.code,
               });
             } else if (permanentCodes.has(failure.code)) {
             await target.outbox.update(row.id, {
               status: "blocked",
                 error: failure.code,
             });
           }
         }

         await applySnapshot(result, scope);
         tombstoneCursor = result.tombstoneCursor || tombstoneCursor;
         if (result.tombstoneHasMore === true) syncRequested = true;
         const appliedIndexes = result.appliedOpIndexes ?? batch.map((_, index) => index);
        const appliedRows = appliedIndexes
          .map((index) => batch[index])
          .filter((row): row is OutboxRow => !!row);
        const ids = appliedRows
          .map((row) => row.id)
          .filter((id): id is number => typeof id === "number");
        if (ids.length > 0) await target.outbox.bulkDelete(ids);
        rejectedOps = rejectedOps.concat(failed);
      }

      if (rejectedOps.length > 0) {
        const planRejected = rejectedOps.filter((op) => op.code === "PLAN_LIMIT").length;
        const dependentRejected = rejectedOps.filter((op) => op.code === "DEPENDENTS_EXIST").length;
        const permissionRejected = rejectedOps.filter((op) => op.code === "PERMISSION_DENIED").length;
        const invalidRejected = rejectedOps.length - planRejected - dependentRejected - permissionRejected;
        const parts = [
          planRejected > 0 ? `${planRejected} registro(s) atingiram o limite do plano` : "",
          dependentRejected > 0 ? `${dependentRejected} exclusão(ões) tinha(m) dependências` : "",
          permissionRejected > 0 ? `${permissionRejected} operação(ões) sem permissão` : "",
          invalidRejected > 0 ? `${invalidRejected} registro(s) possuem dados inválidos` : "",
        ].filter(Boolean);
        dispatchOutboxChange(scope);
        dispatchSyncError(scope, `${parts.join(" e ")}. Os registros aceitos já foram sincronizados.`);
        return false;
      }
    } while (syncRequested || (await target.outbox.filter((row) => row.status !== "blocked").count()) > 0);

    window.dispatchEvent(new CustomEvent("agrolote:synced", {
      detail: { userId: scope.userId, projectId: scope.projectId },
    }));
    return true;
  } catch (err) {
    if (import.meta.env.DEV) console.warn("Sync falhou (modo offline):", err);
    const status = (err as Error & { status?: number }).status;
    const message = status === 401
      ? "Sua sessão expirou. Entre novamente para enviar os dados pendentes."
      : status === 400
        ? "Um registro foi rejeitado pelo servidor. Verifique os dados e o limite do plano."
        : "Não foi possível sincronizar agora. Seus dados continuam salvos neste aparelho.";
    if (status === 401) {
      window.dispatchEvent(new CustomEvent("agrolote:reauth-required"));
    }
    dispatchSyncError(scope, message);
    return false;
  } finally {
    syncing = false;
    if (syncRequested && isOnline() && currentSyncScope()?.projectId === scope.projectId) requestSync();
  }
}

export async function pullServer() {
  if (!isOnline()) return false;
  const scope = currentSyncScope();
  const target = getActiveAgroloteDB(scope || undefined);
  if (!scope || !target) return false;
  try {
    let cursor = (await target.meta.get(TOMBSTONE_CURSOR_KEY))?.value as TombstoneCursor | undefined;
    let hasMore = true;
    while (hasMore) {
      const result = await pushSync([], scope, cursor);
      if (!result?.snapshot) return false;
      await applySnapshot(result, scope);
      cursor = result.tombstoneCursor || cursor;
      hasMore = result.tombstoneHasMore === true;
      if (getActiveAgroloteDB(scope) !== target) return false;
    }
    window.dispatchEvent(new CustomEvent("agrolote:synced", {
      detail: { userId: scope.userId, projectId: scope.projectId },
    }));
    return true;
  } catch {
    return false;
  }
}

export function startSyncWatcher(requestImmediately = true): () => void {
  const watcherScope = currentSyncScope();
  if (!watcherScope) return () => undefined;
  const onOnline = () => requestSync();
  const onVisibility = () => {
    if (document.visibilityState === "visible") requestSync();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("agrolote:outbox-change", requestSync);
  window.addEventListener("agrolote:local-change", requestSync);
  window.addEventListener("visibilitychange", onVisibility);
  const intervalId = setInterval(() => requestSync(), 60000);
  if (requestImmediately) requestSync();
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("agrolote:outbox-change", requestSync);
    window.removeEventListener("agrolote:local-change", requestSync);
    window.removeEventListener("visibilitychange", onVisibility);
    clearInterval(intervalId);
    const current = currentSyncScope();
    if (syncTimer !== null && current?.userId === watcherScope.userId && current.projectId === watcherScope.projectId) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  };
}

export { runSync, syncing };
