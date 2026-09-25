import Dexie, { type Table } from "dexie";
import type { Lote, Plantio, Insumo, Gasto, Colheita, Snapshot, SyncOp } from "./types";

export interface ActiveScope {
  userId: string;
  projectId: string;
  accountId: string;
}

export interface ActiveScopeInput {
  userId: string | number;
  projectId: string;
  accountId?: string | number;
}

export interface ScopedRow {
  project_id: string;
  account_id: string;
}

export interface OutboxRow extends ScopedRow {
  id?: number;
  op: SyncOp;
  created_at: number;
  status?: "pending" | "blocked";
  error?: string;
}

export interface MetaRow extends ScopedRow {
  key: string;
  value: unknown;
}

export interface TombstoneRow extends ScopedRow {
  key: string;
  entity: string;
  id: string;
  deleted_at: string;
  seq?: number;
  cascade?: boolean;
}

const LEGACY_DATABASE_NAME = "agrolote";
const LEGACY_MIGRATION_KEY = "legacy_migration_v2";
const SCOPE_META_KEY = "active_scope";
const DATA_ENTITIES = ["lotes", "plantios", "insumos", "gastos", "colheitas"] as const;
type DataEntity = typeof DATA_ENTITIES[number];

type LegacyRow = Record<string, unknown> & { id?: string | number };
type LegacyOutboxRow = LegacyRow & { op?: SyncOp; created_at?: number };

export class AgroloteDB extends Dexie {
  lotes!: Table<Lote, string>;
  plantios!: Table<Plantio, string>;
  insumos!: Table<Insumo, string>;
  gastos!: Table<Gasto, string>;
  colheitas!: Table<Colheita, string>;
  outbox!: Table<OutboxRow, number>;
  meta!: Table<MetaRow, string>;
  tombstones!: Table<TombstoneRow, string>;

  constructor(scope: ActiveScopeInput) {
    super(databaseNameFor(scope));
    this.version(2).stores({
      lotes: "id, project_id, account_id, [project_id+account_id], nome, tipo",
      plantios: "id, project_id, account_id, [project_id+account_id], lote_id, cultura, status, data_colheita_prevista",
      insumos: "id, project_id, account_id, [project_id+account_id], nome, categoria",
      gastos: "id, project_id, account_id, [project_id+account_id], plantio_id, lote_id, data",
      colheitas: "id, project_id, account_id, [project_id+account_id], plantio_id, data",
      outbox: "++id, project_id, account_id, [project_id+account_id], created_at",
      meta: "key, project_id, account_id, [project_id+account_id]",
    });
    this.version(3).stores({
      lotes: "id, project_id, account_id, [project_id+account_id], nome, tipo",
      plantios: "id, project_id, account_id, [project_id+account_id], lote_id, cultura, status, data_colheita_prevista",
      insumos: "id, project_id, account_id, [project_id+account_id], nome, categoria",
      gastos: "id, project_id, account_id, [project_id+account_id], plantio_id, lote_id, data",
      colheitas: "id, project_id, account_id, [project_id+account_id], plantio_id, data",
      outbox: "++id, project_id, account_id, [project_id+account_id], status, created_at",
      meta: "key, project_id, account_id, [project_id+account_id]",
      tombstones: "key, project_id, entity, [project_id+entity]",
    });
  }
}

export function databaseNameFor(scope: ActiveScopeInput): string {
  return `agrolote_v2_${encodeURIComponent(String(scope.userId))}_${encodeURIComponent(scope.projectId)}`;
}

export function createAgroloteDB(scope: ActiveScopeInput): AgroloteDB {
  return new AgroloteDB(scope);
}

function normalizeScope(scope: ActiveScopeInput): ActiveScope {
  const userId = String(scope.userId ?? "");
  const projectId = String(scope.projectId ?? "");
  const accountId = String(scope.accountId ?? userId);
  if (!userId.trim() || !projectId.trim() || !accountId.trim()) throw new Error("Escopo de usuário/projeto inválido");
  return { userId, projectId, accountId };
}

let activeScope: ActiveScope | null = null;
let activeDatabase: AgroloteDB | null = null;
let scopeTransition: Promise<void> = Promise.resolve();

function sameScope(left: ActiveScope | null, right: ActiveScope | null): boolean {
  return !!left && !!right && left.userId === right.userId && left.projectId === right.projectId && left.accountId === right.accountId;
}

function dispatchScopeChange(scope: ActiveScope | null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("agrolote:scope-change", { detail: scope }));
}

function activeDatabaseFor(expected?: ActiveScope | null): AgroloteDB {
  if (!activeDatabase || !activeScope) throw new Error("Nenhum projeto ativo");
  if (expected && !sameScope(activeScope, expected)) throw new Error("O escopo ativo mudou");
  return activeDatabase;
}

function scopedRow(row: LegacyRow, scope: ActiveScope): Record<string, unknown> {
  return { ...row, project_id: scope.projectId, account_id: scope.accountId };
}

function scopedLoteRow(row: LegacyRow, scope: ActiveScope): Record<string, unknown> {
  const out = scopedRow(row, scope);
  const canonical = out.area_m2;
  if (canonical === undefined && typeof out.area === "number") {
    out.area_m2 = out.area;
  }
  if (typeof out.area_m2 === "number" || out.area_m2 === null) delete out.area;
  return out;
}

function legacyScopedRow(row: LegacyRow, scope: ActiveScope): Record<string, unknown> | null {
  const projectId = row.project_id;
  const accountId = row.account_id;
  if (projectId !== undefined && projectId !== null && String(projectId) !== scope.projectId) return null;
  if (accountId !== undefined && accountId !== null && String(accountId) !== scope.accountId) return null;
  return scopedRow(row, scope);
}

function scopedOutboxRow(row: LegacyOutboxRow, scope: ActiveScope): OutboxRow {
  const opData = { ...(row.op?.data || {}) } as Record<string, unknown> & { id: string };
  delete opData.project_id;
  delete opData.account_id;
  if (row.op?.entity === "lotes") {
    if (opData.area_m2 === undefined && opData.area !== undefined) opData.area_m2 = opData.area;
    delete opData.area;
  }
  return {
    ...row,
    id: typeof row.id === "number" ? row.id : undefined,
    op: { ...(row.op as SyncOp), data: opData, op_id: (row.op as SyncOp).op_id || crypto.randomUUID() },
    created_at: typeof row.created_at === "number" ? row.created_at : Date.now(),
    project_id: scope.projectId,
    account_id: scope.accountId,
  };
}

function scopedMetaRow(row: LegacyRow, scope: ActiveScope): MetaRow {
  return {
    key: String(row.key ?? ""),
    value: row.value,
    project_id: scope.projectId,
    account_id: scope.accountId,
  };
}

async function readLegacyTable(legacy: Dexie, name: string): Promise<LegacyRow[]> {
  if (!legacy.tables.some((table) => table.name === name)) return [];
  return legacy.table<LegacyRow, unknown>(name).toArray();
}

async function migrateLegacyDatabase(target: AgroloteDB, scope: ActiveScope, { confirmed = false } = {}): Promise<void> {
  const existingMarker = await target.meta.get(LEGACY_MIGRATION_KEY);
  if (existingMarker && !confirmed) return;
  if (typeof localStorage === "undefined") return;
  if (!(await Dexie.exists(LEGACY_DATABASE_NAME))) return;

  const legacy = new Dexie(LEGACY_DATABASE_NAME);
  try {
    await legacy.open();
    const legacyMeta = await readLegacyTable(legacy, "meta");
    const hasLegacyMeta = legacy.tables.some((table) => table.name === "meta");
    const priorMarker = legacyMeta.find((row) => String(row.key) === LEGACY_MIGRATION_KEY)?.value as Record<string, unknown> | undefined;
    // `agrolote_last_user` é apenas uma dica local e não prova que os dados
    // pertencem à conta atual. Nunca importar dados legados sem um marker
    // explícito criado por uma migração verificada; caso contrário, os dados
    // de outra conta poderiam ser copiados e o outbox seria reproduzido no
    // projeto errado.
     if (!priorMarker) {
       if (!confirmed) {
         await target.meta.put({
           key: LEGACY_MIGRATION_KEY,
           value: {
             status: "requires_confirmation",
             detectedAt: new Date().toISOString(),
             source: LEGACY_DATABASE_NAME,
           },
           project_id: scope.projectId,
           account_id: scope.accountId,
         });
         return;
       }
       if (hasLegacyMeta) {
         await legacy.table("meta").put({
           key: LEGACY_MIGRATION_KEY,
           value: {
             userId: scope.userId,
             projectId: scope.projectId,
             status: "pending",
             startedAt: new Date().toISOString(),
             confirmedAt: new Date().toISOString(),
           },
         });
       }
     }
     if (priorMarker && priorMarker.userId !== scope.userId && !confirmed) {
      await target.meta.put({
        key: LEGACY_MIGRATION_KEY,
        value: { ...priorMarker, status: "deferred", destination: `${scope.userId}/${scope.projectId}` },
        project_id: scope.projectId,
        account_id: scope.accountId,
      });
      return;
    }
    if (priorMarker?.userId === scope.userId && (priorMarker.status === "migrated" || priorMarker.status === "already_migrated")) {
      await target.meta.put({
        key: LEGACY_MIGRATION_KEY,
        value: { ...priorMarker, status: "already_migrated", destination: `${scope.userId}/${scope.projectId}` },
        project_id: scope.projectId,
        account_id: scope.accountId,
      });
      return;
    }
     if (priorMarker?.userId === scope.userId && priorMarker.status !== "pending" && !confirmed) {
      await target.meta.put({
        key: LEGACY_MIGRATION_KEY,
        value: { ...priorMarker, status: "requires_confirmation", detectedAt: new Date().toISOString() },
        project_id: scope.projectId,
        account_id: scope.accountId,
      });
      return;
    }
    if (priorMarker?.userId === scope.userId && priorMarker.status === "pending" && priorMarker.projectId !== scope.projectId) {
      await target.meta.put({
        key: LEGACY_MIGRATION_KEY,
        value: { ...priorMarker, status: "deferred", destination: `${scope.userId}/${scope.projectId}` },
        project_id: scope.projectId,
        account_id: scope.accountId,
      });
      return;
    }

    if (hasLegacyMeta) {
      await legacy.table("meta").put({
        key: LEGACY_MIGRATION_KEY,
        value: {
          userId: scope.userId,
          projectId: scope.projectId,
          status: "pending",
          startedAt: new Date().toISOString(),
        },
      });
    }

    const legacyRows: Record<DataEntity, LegacyRow[]> = {
      lotes: await readLegacyTable(legacy, "lotes"),
      plantios: await readLegacyTable(legacy, "plantios"),
      insumos: await readLegacyTable(legacy, "insumos"),
      gastos: await readLegacyTable(legacy, "gastos"),
      colheitas: await readLegacyTable(legacy, "colheitas"),
    };
    const legacyOutbox = (await readLegacyTable(legacy, "outbox")) as LegacyOutboxRow[];
    const legacyMetaRows = legacyMeta.filter((row) => String(row.key) !== LEGACY_MIGRATION_KEY);
    const counts: Record<string, number> = {};
    const importedIds = new Set<string>();

    await target.transaction("rw", [
      target.lotes,
      target.plantios,
      target.insumos,
      target.gastos,
      target.colheitas,
      target.outbox,
      target.meta,
    ], async () => {
      for (const entity of DATA_ENTITIES) {
        const rows = legacyRows[entity]
          .map((row) => {
            const scoped = legacyScopedRow(row, scope);
            if (!scoped || entity !== "lotes") return scoped;
            return scopedLoteRow(scoped, scope);
          })
          .filter((row): row is Record<string, unknown> => !!row);
         const table = target[entity] as unknown as Table<LegacyRow, string>;
         const existingRows = rows.length > 0 ? await table.bulkGet(rows.map((row) => String(row.id))) : [];
         const freshRows = rows.filter((row, index) => {
           if (existingRows[index]) return false;
           importedIds.add(`${entity}:${String(row.id)}`);
           return true;
         });
         counts[entity] = freshRows.length;
         if (freshRows.length > 0) await table.bulkPut(freshRows);
      }
       const existingOutboxKeys = new Set((await target.outbox.toArray()).map((row) => `${row.op.entity}:${String(row.op.data.id)}`));
       const outboxRows = legacyOutbox
         .filter((row) => typeof row.id === "number" && row.op && typeof row.created_at === "number" && legacyScopedRow(row, scope))
         .map((row) => scopedOutboxRow(row, scope))
         .filter((row) => {
           const key = `${row.op.entity}:${String(row.op.data.id)}`;
           return importedIds.has(key) && !existingOutboxKeys.has(key);
         })
         .map((row) => {
           const copy = { ...row } as Partial<OutboxRow>;
           delete copy.id;
           return copy as OutboxRow;
         });
       counts.outbox = outboxRows.length;
       if (outboxRows.length > 0) await target.outbox.bulkAdd(outboxRows);
       const existingMetaKeys = new Set((await target.meta.toArray()).map((row) => row.key));
       const metaRows = legacyMetaRows
         .filter((row) => row.key !== undefined && !existingMetaKeys.has(String(row.key)) && !!legacyScopedRow(row, scope))
         .map((row) => scopedMetaRow(row, scope));
       counts.meta = metaRows.length;
       if (metaRows.length > 0) await target.meta.bulkPut(metaRows);
      await target.meta.bulkPut([
        {
          key: SCOPE_META_KEY,
          value: scope,
          project_id: scope.projectId,
          account_id: scope.accountId,
        },
        {
          key: LEGACY_MIGRATION_KEY,
          value: {
            userId: scope.userId,
            projectId: scope.projectId,
            status: "migrated",
            migratedAt: new Date().toISOString(),
            counts,
          },
          project_id: scope.projectId,
          account_id: scope.accountId,
        },
      ]);
    });

    if (hasLegacyMeta) {
      await legacy.table("meta").put({
        key: LEGACY_MIGRATION_KEY,
        value: {
          userId: scope.userId,
          projectId: scope.projectId,
          status: "migrated",
          migratedAt: new Date().toISOString(),
        },
      });
    }
  } finally {
    legacy.close();
  }
}

async function normalizeLocalLotes(target: AgroloteDB, scope: ActiveScope): Promise<void> {
  const rows = await target.lotes.toArray();
  const normalized = rows
    .map((row) => scopedLoteRow(row as unknown as LegacyRow, scope))
    .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index);
  if (normalized.length > 0) await target.lotes.bulkPut(normalized as never[]);
}

async function applyActiveScope(nextScope: ActiveScope | null): Promise<void> {
  if (sameScope(activeScope, nextScope) && activeDatabase) return;
  if (activeDatabase) activeDatabase.close();
  activeDatabase = null;
  activeScope = null;
  dispatchScopeChange(null);
  if (!nextScope) return;

  const nextDatabase = createAgroloteDB(nextScope);
  try {
    await migrateLegacyDatabase(nextDatabase, nextScope);
    await normalizeLocalLotes(nextDatabase, nextScope);
    await nextDatabase.meta.put({
      key: SCOPE_META_KEY,
      value: nextScope,
      project_id: nextScope.projectId,
      account_id: nextScope.accountId,
    });
    activeDatabase = nextDatabase;
    activeScope = nextScope;
    dispatchScopeChange(nextScope);
  } catch (error) {
    nextDatabase.close();
    throw error;
  }
}

export function setActiveScope(scope: ActiveScopeInput | null): Promise<void> {
  const nextScope = scope ? normalizeScope(scope) : null;
  const operation = scopeTransition.then(() => applyActiveScope(nextScope));
  scopeTransition = operation.catch(() => undefined);
  return operation;
}

export function getActiveScope(): ActiveScope | null {
  return activeScope ? { ...activeScope } : null;
}

export function getActiveAgroloteDB(expected?: ActiveScope | null): AgroloteDB | null {
  if (!activeDatabase || !activeScope) return null;
  if (expected && !sameScope(activeScope, expected)) return null;
  return activeDatabase;
}

export async function getLegacyMigrationStatus(): Promise<Record<string, unknown> | null> {
  if (!activeScope || !activeDatabase) return null;
  const marker = await activeDatabase.meta.get(LEGACY_MIGRATION_KEY);
  return (marker?.value as Record<string, unknown> | undefined) || null;
}

export async function dismissLegacyMigration(): Promise<void> {
  if (!activeScope || !activeDatabase) return;
  const target = activeDatabaseFor(activeScope);
  const marker = await target.meta.get(LEGACY_MIGRATION_KEY);
  if (!marker) return;
  await target.meta.put({
    ...marker,
    value: { ...(marker.value as Record<string, unknown>), status: "dismissed", dismissedAt: new Date().toISOString() },
  });
}

export async function confirmLegacyMigration(): Promise<Record<string, unknown> | null> {
  if (!activeScope || !activeDatabase) throw new Error("Nenhum projeto ativo");
  const target = activeDatabaseFor(activeScope);
  await migrateLegacyDatabase(target, activeScope, { confirmed: true });
  await normalizeLocalLotes(target, activeScope);
  return getLegacyMigrationStatus();
}

export function waitForActiveScope(userId: string | number, accountId?: string | number, timeoutMs = 15_000): Promise<ActiveScope> {
  const expectedUserId = String(userId);
  const expectedAccountId = accountId === undefined ? null : String(accountId);
  const matches = activeScope?.userId === expectedUserId && activeDatabase && (expectedAccountId === null || activeScope.accountId === expectedAccountId);
  if (matches && activeScope) return Promise.resolve({ ...activeScope });
  if (typeof window === "undefined") return Promise.reject(new Error("Sessão sem projeto ativo"));

  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const cleanup = () => {
      window.removeEventListener("agrolote:scope-change", onScopeChange);
      window.removeEventListener("agrolote:logout", onLogout);
      window.removeEventListener("agrolote:project-load-error", onProjectError);
      if (timer !== undefined) window.clearTimeout(timer);
    };
    const onScopeChange = () => {
      if (activeScope?.userId === expectedUserId && activeDatabase && (expectedAccountId === null || activeScope.accountId === expectedAccountId)) {
        cleanup();
        resolve({ ...activeScope });
      }
    };
    const onLogout = () => {
      cleanup();
      reject(new Error("Login cancelado"));
    };
    const onProjectError = () => {
      cleanup();
      reject(new Error("Não foi possível carregar o projeto"));
    };
    window.addEventListener("agrolote:scope-change", onScopeChange);
    window.addEventListener("agrolote:logout", onLogout);
    window.addEventListener("agrolote:project-load-error", onProjectError);
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Não foi possível carregar o projeto"));
    }, timeoutMs);
    onScopeChange();
  });
}

export const db = new Proxy({} as AgroloteDB, {
  get(_target, property) {
    const instance = activeDatabaseFor();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export async function queueOp(op: SyncOp) {
  const scope = activeScope;
  const target = activeDatabaseFor(scope);
  await target.outbox.add({
    op: { op_id: crypto.randomUUID(), ...op },
     created_at: Date.now(),
     status: "pending",
     project_id: scope!.projectId,
    account_id: scope!.accountId,
  });
}

export async function localUpsert(entity: keyof AgroloteDB, record: { id: string }) {
  const scope = activeScope;
  const target = activeDatabaseFor(scope);
  const table = target[entity] as Table<{ id: string }, string>;
  await table.put({ ...record, ...scopedRow(record, scope!) } as never);
}

export async function localDelete(entity: keyof AgroloteDB, id: string) {
  const target = activeDatabaseFor();
  await (target[entity] as Table<{ id: string }, string>).delete(id);
}

export async function mergeLocalWith(
  snapshot: Snapshot,
  expectedScope?: ActiveScope | null,
  deleted: { entity: string; id: string }[] = [],
) {
  const scope = expectedScope || activeScope;
  if (!scope) return;
  const target = activeDatabaseFor(scope);
  const pending = await target.outbox.orderBy("created_at").toArray();
  const pendingState = new Map<string, "upsert" | "delete" | "conflict" | "rejected-delete">();
  for (const row of pending) {
    const id = String(row.op.data.id);
    const key = `${row.op.entity}:${id}`;
    if (row.status === "blocked") {
      if (row.op.action === "delete") pendingState.set(key, "rejected-delete");
      else if (String(row.error || "").includes("TOMBSTONE_CONFLICT") || String(row.error || "").includes("SYNC_CONFLICT")) pendingState.set(key, "conflict");
      continue;
    }
    pendingState.set(key, row.op.action === "delete" ? "delete" : "upsert");
  }
  const rollbackKeys = new Set<string>();
  for (const row of pending) {
    if (row.status !== "blocked" || !row.op.rollback || typeof row.op.rollback !== "object") continue;
    for (const [entity, rows] of Object.entries(row.op.rollback)) {
      if (!Array.isArray(rows)) continue;
      for (const value of rows) {
        const id = String((value as { id?: unknown })?.id || "");
        if (id) rollbackKeys.add(`${entity}:${id}`);
      }
    }
  }

  const blockedLocalKeys = new Set<string>();
  for (const row of pending) {
    if (row.status === "blocked" && row.op.action !== "delete") {
      blockedLocalKeys.add(`${row.op.entity}:${String(row.op.data.id)}`);
    }
  }

  const serverTombstones = snapshot.tombstones || [];
  const deletedKeys = new Set([
    ...deleted.map((row) => `${row.entity}:${String(row.id)}`),
    ...serverTombstones.map((row) => `${row.entity}:${String(row.id)}`),
  ]);

  const scoped = <T extends { id: string }>(entity: DataEntity, rows: T[] | undefined): T[] =>
    (rows ?? [])
      .filter((row) => {
        const scopedFields = row as T & { project_id?: string; account_id?: string };
         const projectMatches = scopedFields.project_id === undefined || scopedFields.project_id === null || String(scopedFields.project_id) === String(scope.projectId);
         const accountMatches = scopedFields.account_id === undefined || scopedFields.account_id === null || String(scopedFields.account_id) === String(scope.accountId);
        return projectMatches && accountMatches;
      })
      .map((row) => {
        const value = { ...row, project_id: scope.projectId, account_id: scope.accountId } as LegacyRow;
        return (entity === "lotes" ? scopedLoteRow(value, scope) : value) as T;
      })
       .filter((row) => {
         const key = `${entity}:${String(row.id)}`;
         return !deletedKeys.has(key) || pendingState.get(key) === "conflict" || rollbackKeys.has(key) || blockedLocalKeys.has(key);
       });

  await target.transaction("rw", [target.lotes, target.plantios, target.insumos, target.gastos, target.colheitas, target.outbox, target.tombstones], async () => {
    for (const entity of DATA_ENTITIES) {
      const table = target[entity] as unknown as Table<{ id: string }, string>;
      const serverRows = scoped(entity, snapshot[entity] as { id: string }[] | undefined);
      const currentRows = await table.toArray();
      const stale = currentRows.filter((row) => {
        const key = `${entity}:${String(row.id)}`;
        const state = pendingState.get(key);
        return state === "delete" || (!state && deletedKeys.has(key));
      });
      if (stale.length > 0) await table.bulkDelete(stale.map((row) => row.id));
      if (serverRows.length > 0) await table.bulkPut(serverRows as never[]);
       const pendingUpserts = currentRows.filter((row) => {
         const key = `${entity}:${String(row.id)}`;
         const state = pendingState.get(key);
         return state === "upsert" || state === "conflict" || rollbackKeys.has(key) || blockedLocalKeys.has(key);
       });
      for (const row of pendingUpserts) {
        const value = entity === "lotes" ? scopedLoteRow(row as unknown as LegacyRow, scope) : row;
        await table.put(value as never);
      }
      const prefix = `${entity}:`;
      const pendingDeletes = [...pendingState.entries()]
        .filter(([key, state]) => state === "delete" && key.startsWith(prefix) && currentRows.some((row) => key === `${prefix}${String(row.id)}`))
        .map(([key]) => key.slice(prefix.length));
      if (pendingDeletes.length > 0) await table.bulkDelete(pendingDeletes);
    }
    for (const tombstone of serverTombstones) {
      const entity = String(tombstone.entity);
      const key = `${entity}:${String(tombstone.id)}`;
       const state = pendingState.get(key);
       if (state === "upsert") {
         const pendingRows = await target.outbox.filter((row) => row.op?.entity === entity && String(row.op?.data?.id) === String(tombstone.id)).toArray();
         for (const pendingRow of pendingRows) {
           if (typeof pendingRow.id === "number") await target.outbox.update(pendingRow.id, { status: "blocked", error: "TOMBSTONE_CONFLICT" });
         }
       }
       if (DATA_ENTITIES.includes(entity as DataEntity) && state !== "upsert" && state !== "conflict" && state !== "rejected-delete" && !rollbackKeys.has(key) && !blockedLocalKeys.has(key)) {
        await (target[entity as DataEntity] as unknown as Table<{ id: string }, string>).delete(String(tombstone.id));
      }
      await target.tombstones.put({
        key: `${scope.projectId}:${entity}:${String(tombstone.id)}`,
        entity,
        id: String(tombstone.id),
         deleted_at: tombstone.deleted_at || new Date().toISOString(),
         seq: typeof tombstone.seq === "number" ? tombstone.seq : undefined,
         cascade: tombstone.cascade === true,
        project_id: scope.projectId,
        account_id: scope.accountId,
      });
    }
  });
}

export async function clearLocal() {
  const target = activeDatabaseFor();
  await target.transaction("rw", [
    target.lotes,
    target.plantios,
    target.insumos,
    target.gastos,
    target.colheitas,
    target.outbox,
    target.meta,
    target.tombstones,
  ], async () => {
    await target.lotes.clear();
    await target.plantios.clear();
    await target.insumos.clear();
    await target.gastos.clear();
    await target.colheitas.clear();
    await target.outbox.clear();
    await target.tombstones.clear();
    const metaKeys = await target.meta.toCollection().primaryKeys();
    const removableKeys = metaKeys.filter((key) => key !== SCOPE_META_KEY && key !== LEGACY_MIGRATION_KEY);
    if (removableKeys.length > 0) await target.meta.bulkDelete(removableKeys);
  });
}

export function isOnline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine;
}
