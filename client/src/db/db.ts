import Dexie, { type Table } from "dexie";
import type { Lote, Plantio, Insumo, Gasto, Colheita, Snapshot, SyncOp } from "./types";

export interface OutboxRow {
  id?: number;
  op: SyncOp;
  created_at: number;
}

class AgroloteDB extends Dexie {
  lotes!: Table<Lote, string>;
  plantios!: Table<Plantio, string>;
  insumos!: Table<Insumo, string>;
  gastos!: Table<Gasto, string>;
  colheitas!: Table<Colheita, string>;
  outbox!: Table<OutboxRow, number>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super("agrolote");
    this.version(1).stores({
      lotes: "id, nome, tipo",
      plantios: "id, lote_id, cultura, status, data_colheita_prevista",
      insumos: "id, nome, categoria",
      gastos: "id, plantio_id, lote_id, data",
      colheitas: "id, plantio_id, data",
      outbox: "++id, created_at",
      meta: "key",
    });
  }
}

export const db = new AgroloteDB();

export async function queueOp(op: SyncOp) {
  await db.outbox.add({ op, created_at: Date.now() });
}

export async function localUpsert(entity: keyof AgroloteDB, record: { id: string }) {
  await (db[entity] as Table<{ id: string }, string>).put(record);
}

export async function localDelete(entity: keyof AgroloteDB, id: string) {
  await (db[entity] as Table<{ id: string }, string>).delete(id);
}

/**
 * Faz merge (upsert) do snapshot do servidor no banco local, SEM apagar o que
 * já existe no aparelho. Isso garante que um servidor vazio/volátil (ex.: disco
 * efêmero do Render free) jamais destrua os dados locais durante a sincronização.
 * Registros deletados em outro aparelho podem demorar a sumir aqui — priorizamos
 * não perder dados do produtor.
 */
export async function mergeLocalWith(snapshot: Snapshot) {
  await db.transaction("rw", db.lotes, db.plantios, db.insumos, db.gastos, db.colheitas, async () => {
    await db.lotes.bulkPut(snapshot.lotes ?? []);
    await db.plantios.bulkPut(snapshot.plantios ?? []);
    await db.insumos.bulkPut(snapshot.insumos ?? []);
    await db.gastos.bulkPut(snapshot.gastos ?? []);
    await db.colheitas.bulkPut(snapshot.colheitas ?? []);
  });
}

/** Apaga todos os dados locais + pendências (usado ao trocar de conta). */
export async function clearLocal() {
  await db.transaction("rw", [db.lotes, db.plantios, db.insumos, db.gastos, db.colheitas, db.outbox, db.meta], async () => {
    await db.lotes.clear();
    await db.plantios.clear();
    await db.insumos.clear();
    await db.gastos.clear();
    await db.colheitas.clear();
    await db.outbox.clear();
    await db.meta.clear();
  });
}

export function isOnline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine;
}