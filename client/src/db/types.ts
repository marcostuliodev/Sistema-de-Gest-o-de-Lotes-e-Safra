export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Lote {
  id: string;
  nome: string;
  tipo: "talhao" | "bancada" | "vaso";
  area?: number | null;
  localizacao?: string | null;
  created_at?: string;
}

export interface Plantio {
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

export interface Insumo {
  id: string;
  nome: string;
  categoria?: string | null;
  unidade?: string | null;
}

export interface Gasto {
  id: string;
  plantio_id?: string | null;
  insumo_id?: string | null;
  descricao?: string | null;
  quantidade: number;
  valor_unitario: number;
  data: string;
  created_at?: string;
}

export interface Colheita {
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
  action: "upsert" | "delete";
  data: Record<string, unknown> & { id: string };
}

export interface Snapshot {
  lotes: Lote[];
  plantios: Plantio[];
  insumos: Insumo[];
  gastos: Gasto[];
  colheitas: Colheita[];
}