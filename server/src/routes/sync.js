import { Router } from "express";
import { v4 as uuid } from "uuid";
import { col, copyableFields, withMongoTransaction } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { parseEntity, parseEntityId, parseEntityPatch, sanitizeSnapshot } from "../validation.js";
import { getPlanFeatures, getSubscriptionPlan } from "../plans.js";
import { deleteEntity, parseCascade } from "../deletion.js";
import {
  PERMISSIONS,
  hasPermission,
  idToString,
  normalizeId,
  projectMiddleware,
} from "../authz.js";
import {
  buildProjectFilter,
  combineFilters,
  documentIdFilter,
  findAnyDocument,
  findProjectDocument,
  getActorKey,
  getProjectId,
  getProjectOwner,
} from "../projectScope.js";

const router = Router();
router.use(authMiddleware);
router.use(projectMiddleware);

const ENTITIES = ["lotes", "plantios", "insumos", "gastos", "colheitas"];
const MAX_OPS = 100;

const LIMITED_ENTITIES = {
  lotes: "maxLotes",
  plantios: "maxPlantios",
};

function stripServerFields(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const fields = { ...data };
  delete fields.user_id;
  delete fields.owner_id;
  delete fields.project_id;
  delete fields.projectId;
  delete fields.actor;
  delete fields.created_by;
  delete fields.updated_by;
  delete fields.rollback;
  return fields;
}

function operationError(message, code = "SYNC_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function planLimitError(message) {
  return operationError(message, "PLAN_LIMIT");
}

async function activePlanForOwner(owner) {
  const subscriptions = await col("subscriptions");
  const clauses = owner.values.map((value) => ({ user_id: value }));
  const subscription = clauses.length > 0 ? await subscriptions.findOne({ $or: clauses }) : null;
  return getSubscriptionPlan(subscription);
}

async function assertCreateWithinPlanLimit(entity, req, owner, session) {
  const limitKey = LIMITED_ENTITIES[entity];
  if (!limitKey) return;

  const activePlan = await activePlanForOwner(owner);
  const features = getPlanFeatures(activePlan);
  const max = features[limitKey];
  if (max === Infinity) return;
  if (max <= 0) {
    throw planLimitError(
      `Seu plano nao permite ${limitKey === "maxLotes" ? "lotes" : "plantios"}. Faca upgrade do seu plano.`
    );
  }

  const lock = await col("entity_count_locks");
  await lock.updateOne(
    { _id: `${getProjectId(req)}:${entity}` },
    { $inc: { revision: 1 }, $set: { updated_at: new Date().toISOString() } },
    { upsert: true, session },
  );
  const count = await (await col(entity)).countDocuments(
    await buildProjectFilter(req),
    session ? { session } : undefined,
  );
  if (count >= max) {
    throw planLimitError(
      `Limite de ${limitKey === "maxLotes" ? "lotes" : "plantios"} atingido (${max}). Faca upgrade do seu plano.`
    );
  }
}

function assertOperationProject(row, req) {
  for (const supplied of [row?.project_id, row?.projectId]) {
    if (supplied === undefined || supplied === null || supplied === "") continue;
    const suppliedValue = supplied?._id ?? supplied?.id ?? supplied;
    const suppliedId = normalizeId(suppliedValue) || String(suppliedValue);
    if (suppliedId !== getProjectId(req)) {
      throw operationError("Operacao pertence a outro projeto", "PROJECT_SCOPE");
    }
  }
}

async function validateSyncReferences(req, entity, row) {
  const references = [];
  if (entity === "plantios" && row.lote_id) {
    references.push({ collection: "lotes", value: row.lote_id, label: "lote" });
  }
  if (entity === "gastos") {
    if (row.plantio_id) references.push({ collection: "plantios", value: row.plantio_id, label: "plantio" });
    if (row.insumo_id) references.push({ collection: "insumos", value: row.insumo_id, label: "insumo" });
  }
  if (entity === "colheitas" && row.plantio_id) {
    references.push({ collection: "plantios", value: row.plantio_id, label: "plantio" });
  }

  for (const reference of references) {
    const collection = await col(reference.collection);
    const found = await findProjectDocument(req, collection, reference.value);
    if (!found) {
      throw operationError(`Referência de ${reference.label} inválida para este projeto`, "PROJECT_REFERENCE_INVALID");
    }
  }
}

function serverWriteFields(req, owner, existing = null, opId = null) {
  const now = new Date().toISOString();
  const actor = getActorKey(req);
  const fields = {
    project_id: getProjectId(req),
    user_id: owner.userId,
    actor,
    updated_by: actor,
    updated_at: now,
  };
   if (!existing || existing.created_by === undefined || existing.created_by === null) fields.created_by = actor;
   if (!existing || existing.created_at === undefined || existing.created_at === null) fields.created_at = now;
   if (opId) fields.last_op_id = String(opId);
  return fields;
}

function requiredPermission(action, existing) {
  if (action === "delete") return PERMISSIONS.ENTITIES_DELETE;
  if (action === "create") return PERMISSIONS.ENTITIES_CREATE;
  if (action === "update") return PERMISSIONS.ENTITIES_UPDATE;
  return existing ? PERMISSIONS.ENTITIES_UPDATE : PERMISSIONS.ENTITIES_CREATE;
}

async function applyOp(entity, action, row, context) {
  const { req, owner, cascade = false, baseUpdatedAt = null, opId = null } = context;
  const collection = await col(entity);
  let id = uuid();
  if (row.id !== undefined && row.id !== null) {
    try {
      id = parseEntityId(row.id);
    } catch {
      throw operationError("id inválido para operação", "SYNC_INVALID");
    }
  }
  const scoped = await findProjectDocument(req, collection, id);
  let existing = scoped;

   if (!existing) {
     const outside = await findAnyDocument(collection, id);
     if (outside) throw operationError("Operacao pertence a outro projeto", "PROJECT_SCOPE");
   }
   if (existing && opId && (String(existing.last_op_id || "") === String(opId) || (Array.isArray(existing.applied_op_ids) && existing.applied_op_ids.some((value) => String(value) === String(opId)))) && action !== "delete") {
     return { entity, id, action, alreadyApplied: true };
   }
   if (existing && action !== "delete" && baseUpdatedAt) {
     const actualUpdatedAt = existing.updated_at instanceof Date
       ? existing.updated_at.toISOString()
       : String(existing.updated_at || "");
     if (actualUpdatedAt !== String(baseUpdatedAt)) {
       throw operationError("Registro alterado em outro dispositivo; revise antes de sincronizar", "SYNC_CONFLICT");
     }
   }

   const permission = requiredPermission(action, existing);
  if (action === "delete" && !hasPermission(req.projectAccess, PERMISSIONS.ENTITIES_READ)) {
    throw operationError("Permissão insuficiente para excluir registros", "PERMISSION_DENIED");
  }
   if (!hasPermission(req.projectAccess, permission)) {
     throw operationError("Permissão insuficiente para a operação", "PERMISSION_DENIED");
   }
   if (action === "delete") {
    if (!existing) {
      return {
        entity,
        id,
        action: "delete",
        cascade,
        deleted: true,
        alreadyDeleted: true,
        deletedCount: 0,
        deletedIds: [],
        deletedEntities: [],
        disassociatedCount: 0,
        disassociatedIds: [],
        tombstones: [],
      };
    }
    try {
      const result = await deleteEntity(req, entity, id, cascade);
      return { ...result, action: "delete" };
    } catch (error) {
      if (error?.code === "NOT_FOUND") {
        return {
          entity,
          id,
          action: "delete",
          cascade,
          deleted: true,
          alreadyDeleted: true,
          deletedCount: 0,
          deletedIds: [],
          disassociatedCount: 0,
          disassociatedIds: [],
          tombstones: [],
        };
      }
      throw error;
    }
  }

  if (action !== "delete") {
    const tombstones = await col("tombstones");
    const tombstone = await tombstones.findOne({ project_id: getProjectId(req), entity, id });
    if (tombstone) {
      throw operationError("Registro foi excluído; crie um novo registro em vez de reutilizar o ID", "TOMBSTONE_CONFLICT");
    }
  }
  if (action === "create" && existing) {
    throw operationError("Registro já existe");
  }
  if (action === "update" && !existing) {
    throw operationError("Registro não encontrado para atualizar", "NOT_FOUND");
  }

  if (existing) {
    const parsed = parseEntityPatch(entity, row);
    const merged = { ...existing, ...parsed };
    await validateSyncReferences(req, entity, merged);
     const update = serverWriteFields(req, owner, existing, opId);
    const areaAliasUpdate = entity === "lotes" && (Object.hasOwn(row, "area_m2") || Object.hasOwn(row, "area"));
    const fields = copyableFields(entity, row).filter(
      (field) => (Object.hasOwn(row, field) || areaAliasUpdate) && parsed[field] !== undefined
    );
    for (const field of fields) update[field] = parsed[field];
     const updateFilter = combineFilters(
       await buildProjectFilter(req),
       documentIdFilter(existing._id ?? existing.id),
     );
     if (baseUpdatedAt) updateFilter.updated_at = String(baseUpdatedAt);
     const updateOperation = { $set: update };
     if (opId) {
       updateOperation.$push = { applied_op_ids: { $each: [String(opId)], $slice: -50 } };
     }
     const updated = await collection.updateOne(updateFilter, updateOperation);
     if (updated.matchedCount === 0) {
       throw operationError("Registro alterado em outro dispositivo; revise antes de sincronizar", "SYNC_CONFLICT");
     }
    return { entity, id, action: "update" };
  }

  const parsed = parseEntity(entity, row);
  await validateSyncReferences(req, entity, parsed);
  const doc = {
    _id: id,
    id,
     ...serverWriteFields(req, owner, null, opId),
     ...(opId ? { applied_op_ids: [String(opId)] } : {}),
   };
  const fields = copyableFields(entity, row).filter((field) => parsed[field] !== undefined);
  for (const field of fields) doc[field] = parsed[field];
  await withMongoTransaction(async (session) => {
    await assertCreateWithinPlanLimit(entity, req, owner, session);
    const scoped = await findProjectDocument(req, collection, id, { session });
    if (scoped) throw operationError("Registro já existe");
    const outside = await findAnyDocument(collection, id, { session });
    if (outside) throw operationError("Operacao pertence a outro projeto", "PROJECT_SCOPE");
    const tombstone = await (await col("tombstones")).findOne(
      { project_id: getProjectId(req), entity, id },
      { session },
    );
    if (tombstone) {
      throw operationError("Registro foi excluído; crie um novo registro em vez de reutilizar o ID", "TOMBSTONE_CONFLICT");
    }
    await collection.insertOne(doc, { session });
  });
  return { entity, id, action: "create" };
}

export async function snapshot(context) {
  const req = context && typeof context === "object" && (context.project || context.projectId || context.projectAccess)
    ? context
    : null;
  const filter = req ? await buildProjectFilter(req) : { user_id: context };
  const canRead = !req || hasPermission(req.projectAccess, PERMISSIONS.ENTITIES_READ);
  const entries = await Promise.all(
    ENTITIES.map(async (entity) => {
      if (!canRead) return [entity, []];
      const collection = await col(entity);
      return [entity, await collection.find(filter).toArray()];
    })
  );
  return sanitizeSnapshot(Object.fromEntries(entries));
}

function invalidOperation(message = "Dados invalidos no sync") {
  return operationError(message, "SYNC_INVALID");
}

function operationFailure(op, index, error) {
  const preservedCodes = new Set([
    "PLAN_LIMIT",
    "PERMISSION_DENIED",
    "PROJECT_SCOPE",
    "PROJECT_REFERENCE_INVALID",
    "DEPENDENTS_EXIST",
    "NOT_FOUND",
    "INVALID_CASCADE",
    "TOMBSTONE_CONFLICT",
    "SYNC_CONFLICT",
    "TRANSACTIONS_REQUIRED",
  ]);
  const dependents = error?.dependents;
  const errorName = String(error?.name || "");
  const errorMessage = String(error?.message || "").toLowerCase();
  const transient = error?.code !== 11000 && (errorName.includes("Mongo") || /timeout|timed out|connection|network|topology|not connected|socket|econn/.test(errorMessage));
  const code = preservedCodes.has(error?.code)
    ? error.code
    : transient ? "SYNC_RETRY" : "SYNC_INVALID";
  return {
    index,
    entity: typeof op?.entity === "string" ? op.entity : null,
    action: typeof op?.action === "string" ? op.action : "upsert",
    code,
    retryable: code === "SYNC_RETRY",
    error: error?.message || "Operação inválida",
    ...(error?.code === "DEPENDENTS_EXIST"
      ? {
          count: dependents?.blockingTotal ?? dependents?.total ?? 0,
          dependents: dependents?.counts || {},
        }
      : {}),
  };
}

function parseTombstoneCursor(value) {
  if (!value || typeof value !== "object") return null;
  const sequence = Number(value.seq);
  if (Number.isSafeInteger(sequence) && sequence >= 0) {
    return { seq: sequence, updatedAt: null, id: value.id ? String(value.id) : null };
  }
  const updatedAt = value.updatedAt || value.updated_at;
  const date = updatedAt ? new Date(updatedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return { seq: null, updatedAt: date, id: value.id ? String(value.id) : null };
}

function requestedCascade(op, rawData) {
  const topLevel = op?.cascade;
  const dataLevel = rawData?.cascade;
  if (topLevel !== undefined && dataLevel !== undefined && String(topLevel) !== String(dataLevel)) {
    throw operationError("cascade foi informado com valores conflitantes", "INVALID_CASCADE");
  }
  return parseCascade(topLevel !== undefined ? topLevel : dataLevel);
}

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
    if (ops.length > MAX_OPS) {
      return res.status(400).json({
        error: `Muitas operacoes (max ${MAX_OPS})`,
        code: "TOO_MANY_OPS",
      });
    }
    if (ops.length === 0 && !hasPermission(req.projectAccess, PERMISSIONS.ENTITIES_READ)) {
      return res.status(403).json({ error: "Permissão insuficiente para baixar o snapshot", code: "PERMISSION_DENIED" });
    }

    try {
      const owner = await getProjectOwner(req);
      const appliedOpIndexes = [];
      const failedOps = [];
      const results = [];

      for (const [index, op] of ops.entries()) {
        try {
          if (!op || !ENTITIES.includes(op.entity)) throw invalidOperation("Entidade invalida");
          const action = op.action || "upsert";
          if (!["upsert", "create", "update", "delete"].includes(action)) {
            throw invalidOperation("Acao invalida");
          }

          const rawData = op.data && typeof op.data === "object" && !Array.isArray(op.data) ? op.data : {};
          const data = stripServerFields(rawData);
          const cascade = action === "delete" ? requestedCascade(op, rawData) : false;
          delete data.cascade;
          if ((action === "delete" || action === "update") && !data.id) {
            throw invalidOperation("id obrigatorio para operação");
          }
          assertOperationProject({ project_id: op.project_id, projectId: op.projectId }, req);
          assertOperationProject(rawData, req);
           const result = await applyOp(op.entity, action, data, { req, owner, cascade, baseUpdatedAt: op.base_updated_at, opId: op.op_id });
          appliedOpIndexes.push(index);
          results.push({ index, ...result });
        } catch (error) {
          failedOps.push(operationFailure(op, index, error));
        }
      }

       const snap = await snapshot(req);
       const canReadEntities = hasPermission(req.projectAccess, PERMISSIONS.ENTITIES_READ);
       const tombstoneCollection = await col("tombstones");
       const requestedCursor = parseTombstoneCursor(req.body?.tombstoneCursor || req.body?.since);
       const tombstoneFilter = requestedCursor && Number.isSafeInteger(requestedCursor.seq)
         ? { project_id: getProjectId(req), seq: { $gt: requestedCursor.seq } }
         : requestedCursor?.updatedAt
           ? {
               project_id: getProjectId(req),
               $or: [
                 { updated_at: { $gt: requestedCursor.updatedAt } },
                 ...(requestedCursor.id ? [{ updated_at: requestedCursor.updatedAt, _id: { $gt: requestedCursor.id } }] : []),
               ],
             }
           : { project_id: getProjectId(req) };
       const tombstones = canReadEntities
         ? await tombstoneCollection.find(tombstoneFilter).sort({ seq: 1, updated_at: 1, _id: 1 }).limit(2000).toArray()
         : [];
       const tombstoneHasMore = tombstones.length === 2000;
       const lastTombstone = tombstones[tombstones.length - 1];
       const tombstoneCursor = lastTombstone && Number.isSafeInteger(Number(lastTombstone.seq))
         ? { seq: Number(lastTombstone.seq), updatedAt: lastTombstone.updated_at || lastTombstone.created_at, id: idToString(lastTombstone._id || lastTombstone.id) }
         : requestedCursor && Number.isSafeInteger(requestedCursor.seq)
           ? requestedCursor
           : { seq: 0 };
       const deletedIds = results.flatMap((result) => result.deletedIds || []);
      const deletedEntities = results.flatMap((result) => result.deletedEntities || []);
      const deletedCount = results.reduce((sum, result) => sum + (result.deletedCount || 0), 0);
      return res.json({
        ok: failedOps.length === 0,
        projectId: getProjectId(req),
        snapshot: snap,
        serverTime: new Date().toISOString(),
        appliedOpIndexes,
        failedOps,
        results,
         tombstones,
         tombstoneCursor,
         tombstoneHasMore,
         deletedIds,
        deletedEntities,
        deletedCount,
      });
    } catch (error) {
      const isProd = process.env.NODE_ENV === "production";
      return res.status(400).json({
        error: isProd ? "Sincronizacao falhou" : error.message,
        code: error?.code || "SYNC_UNAVAILABLE",
      });
    }
  })
);

export { ENTITIES };
export default router;
