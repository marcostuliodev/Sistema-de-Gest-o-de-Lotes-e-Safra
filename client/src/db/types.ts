export interface User {
  id: number | string;
  user_key?: string;
  name: string;
  email: string;
}

export interface ScopedEntity {
  project_id?: string;
  account_id?: string;
}

export interface Lote extends ScopedEntity {
  id: string;
  nome: string;
  tipo: "talhao" | "bancada" | "vaso";
  area_m2?: number | null;
  area?: number | null;
  localizacao?: string | null;
  created_at?: string;
}

export interface Plantio extends ScopedEntity {
  id: string;
  lote_id: string;
  cultura: string;
  cultivar?: string | null;
  data_plantio: string;
  data_colheita_prevista?: string | null;
  qtd_plantada?: number | null;
  unidade?: string | null;
  status: "planejado" | "ativo" | "colhido" | "perdido";
  created_at?: string;
}

export interface Insumo extends ScopedEntity {
  id: string;
  nome: string;
  categoria?: string | null;
  unidade?: string | null;
}

export interface Gasto extends ScopedEntity {
  id: string;
  plantio_id?: string | null;
  insumo_id?: string | null;
  descricao?: string | null;
  quantidade: number;
  valor_unitario: number;
  data: string;
  created_at?: string;
}

export interface Colheita extends ScopedEntity {
  id: string;
  plantio_id: string;
  data: string;
  quantidade: number;
  unidade?: string | null;
  preco_venda: number;
  created_at?: string;
}

export interface DashboardData {
  ativos: number;
  lotes: number;
  colheitas: number;
  custo_total: number;
  custo_30d: number;
  receita_total: number;
  receita_30d: number;
  lucro_total: number;
  lucro_30d: number;
  proximas_colheitas: (Plantio & { lote_nome: string })[];
}

export interface PerformanceRow {
  cultura: string;
  plantios: number;
  rendimento: number;
  receita: number;
  custo: number;
  lucro: number;
}

export type EntityName = "lotes" | "plantios" | "insumos" | "gastos" | "colheitas";

export interface SyncOp {
  entity: EntityName;
  action: "upsert" | "create" | "update" | "delete";
  data: Record<string, unknown> & { id: string; cascade?: boolean };
  cascade?: boolean;
  /** Backup local para reexibir uma exclusão rejeitada pelo servidor. */
  rollback?: Record<string, Record<string, unknown>[]>;
  /** Operações pendentes removidas pelo cascade, restauradas se ele for rejeitado. */
  rollback_operations?: Array<{
    entity: EntityName;
    action: "upsert" | "create" | "update" | "delete";
    data: Record<string, unknown> & { id: string; cascade?: boolean };
    cascade?: boolean;
    op_id?: string;
    base_updated_at?: string;
  }>;
  /** Identificador idempotente da operação. */
  op_id?: string;
  /** Revisão do servidor usada como precondição de update. */
  base_updated_at?: string;
}

export type SyncDeletedEntity = EntityName | "photos_metadata";

export interface SyncTombstone {
  entity: SyncDeletedEntity;
  id: string;
  deleted_at: string;
  cascade: boolean;
  seq?: number;
}

export interface SyncDeleteResult {
  entity: EntityName;
  id: string;
  cascade: boolean;
  deleted: boolean;
  alreadyDeleted?: boolean;
  deletedCount: number;
  deletedIds: string[];
  deletedEntities?: { entity: SyncDeletedEntity; id: string }[];
  counts?: Record<string, number>;
  photos?: { metadata: number; gridfs: number };
  disassociatedCount: number;
  disassociatedIds: string[];
  tombstones: SyncTombstone[];
}

export interface Snapshot {
  lotes: Lote[];
  plantios: Plantio[];
  insumos: Insumo[];
  gastos: Gasto[];
  colheitas: Colheita[];
  tombstones?: SyncTombstone[];
}