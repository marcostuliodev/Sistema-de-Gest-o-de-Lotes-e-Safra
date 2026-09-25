import { Router } from "express";
import { v4 as uuid } from "uuid";
import { col, copyableFields, withMongoTransaction } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { parseEntity, parseEntityPatch, sanitizeSnapshot, sanitizeRow } from "../validation.js";
import { getPlanFeatures, getSubscriptionPlan } from "../plans.js";
import { deleteEntity, parseCascade } from "../deletion.js";
import {
  PERMISSIONS,
  projectMiddleware,
  requireProjectPermission,
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

const LIMITED_ENTITIES = {
  lotes: "maxLotes",
  plantios: "maxPlantios",
};

class EntityReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "EntityReferenceError";
    this.status = 400;
    this.code = "PROJECT_REFERENCE_INVALID";
  }
}

function referenceError(res, error) {
  if (error?.code !== "PROJECT_REFERENCE_INVALID") return null;
  return res.status(400).json({ error: error.message, code: error.code });
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
    const error = new Error(
      `Seu plano nao permite ${limitKey === "maxLotes" ? "lotes" : "plantios"}. Faca upgrade do seu plano.`
    );
    error.status = 403;
    error.planLimit = true;
    error.limit = max;
    error.plan = activePlan;
    throw error;
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
    const error = new Error(
      `Limite de ${limitKey === "maxLotes" ? "lotes" : "plantios"} atingido (${max}). Faca upgrade do seu plano.`
    );
    error.status = 403;
    error.planLimit = true;
    error.limit = max;
    error.current = count;
    error.plan = activePlan;
    throw error;
  }
}

async function validateEntityReferences(req, entity, row) {
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
      throw new EntityReferenceError(`Referência de ${reference.label} inválida para este projeto`);
    }
  }
}

function serverWriteFields(req, owner, existing = null) {
  const now = new Date().toISOString();
  const actor = getActorKey(req);
  const fields = {
    project_id: getProjectId(req),
    user_id: owner.userId,
    updated_by: actor,
    updated_at: now,
  };
  if (!existing || existing.created_by === undefined || existing.created_by === null) fields.created_by = actor;
  if (!existing || existing.created_at === undefined || existing.created_at === null) fields.created_at = now;
  return fields;
}

function stripServerFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const fields = { ...body };
  delete fields.user_id;
  delete fields.owner_id;
  delete fields.project_id;
  delete fields.projectId;
  delete fields.actor;
  delete fields.created_by;
  delete fields.updated_by;
  return fields;
}

function planErrorResponse(res, error) {
  if (!error?.planLimit) return null;
  return res.status(error.status || 403).json({
    error: error.message,
    limit: error.limit,
    current: error.current ?? 0,
    plan: error.plan,
  });
}

function crudRouter(entity) {
  const router = Router();
  router.use(authMiddleware);
  router.use(projectMiddleware);

  router.get(
    "/",
    requireProjectPermission(PERMISSIONS.ENTITIES_READ),
    asyncHandler(async (req, res) => {
      const collection = await col(entity);
      const rows = await collection.find(await buildProjectFilter(req)).sort({ _id: -1 }).toArray();
      res.json(sanitizeSnapshot({ [entity]: rows })[entity]);
    })
  );

  router.post(
    "/",
    requireProjectPermission(PERMISSIONS.ENTITIES_CREATE),
    asyncHandler(async (req, res) => {
      const owner = await getProjectOwner(req);
      const body = stripServerFields(req.body || {});
      let parsedBody;
      try {
        parsedBody = parseEntity(entity, body);
      } catch (error) {
        return res.status(400).json({ error: error.errors?.[0]?.message || "Dados invalidos", code: "INVALID_ENTITY" });
      }

      try {
        await validateEntityReferences(req, entity, parsedBody);
      } catch (error) {
        const response = referenceError(res, error);
        if (response) return response;
        throw error;
      }

      const id = parsedBody.id || uuid();
       const collection = await col(entity);
       const doc = {
         _id: id,
         id,
         ...serverWriteFields(req, owner),
       };
       const fields = copyableFields(entity, body).filter((field) => parsedBody[field] !== undefined);
       for (const field of fields) doc[field] = parsedBody[field];

       try {
         const result = await withMongoTransaction(async (session) => {
           await assertCreateWithinPlanLimit(entity, req, owner, session);
           const anyExisting = await findAnyDocument(collection, id, { session });
           if (anyExisting) {
             const scopedExisting = await findProjectDocument(req, collection, id, { session });
             return {
               status: 409,
               body: {
                 error: scopedExisting ? "Registro já existe" : "ID pertence a outro projeto",
                 code: scopedExisting ? "DUPLICATE_ENTITY" : "PROJECT_SCOPE",
               },
             };
           }
           const tombstone = await (await col("tombstones")).findOne(
             { project_id: getProjectId(req), entity, id },
             { session },
           );
           if (tombstone) {
             return {
               status: 409,
               body: {
                 error: "Registro foi excluído; crie um novo registro em vez de reutilizar o ID",
                 code: "TOMBSTONE_CONFLICT",
               },
             };
           }
           await collection.insertOne(doc, { session });
           return { status: 201 };
         });
         if (result.status !== 201) return res.status(result.status).json(result.body);
       } catch (error) {
         const response = planErrorResponse(res, error);
         if (response) return response;
         if (error?.code === 11000) {
           return res.status(409).json({ error: "Registro já existe", code: "DUPLICATE_ENTITY" });
         }
         throw error;
       }
       return res.status(201).json(sanitizeRow(doc));
    })
  );

  router.put(
    "/:id",
    requireProjectPermission(PERMISSIONS.ENTITIES_UPDATE),
    asyncHandler(async (req, res) => {
      const collection = await col(entity);
      const existing = await findProjectDocument(req, collection, req.params.id);
      if (!existing) return res.status(404).json({ error: "Registro nao encontrado" });

      const changes = stripServerFields(req.body || {});
      let parsedBody;
      try {
        parsedBody = parseEntityPatch(entity, changes);
      } catch (error) {
        return res.status(400).json({ error: error.errors?.[0]?.message || "Dados invalidos", code: "INVALID_ENTITY" });
      }

      const merged = { ...existing, ...parsedBody };
      try {
        await validateEntityReferences(req, entity, merged);
      } catch (error) {
        const response = referenceError(res, error);
        if (response) return response;
        throw error;
      }

      const owner = await getProjectOwner(req);
      const update = serverWriteFields(req, owner, existing);
      const fields = copyableFields(entity, changes).filter((field) => {
        const areaAliasUpdate = entity === "lotes" && (Object.hasOwn(changes, "area_m2") || Object.hasOwn(changes, "area"));
        return (Object.hasOwn(changes, field) || areaAliasUpdate) && parsedBody[field] !== undefined;
      });
      for (const field of fields) update[field] = parsedBody[field];

      const scopedId = combineFilters(
        await buildProjectFilter(req),
        documentIdFilter(existing._id ?? existing.id)
      );
      await collection.updateOne(scopedId, { $set: update });
      const updated = await collection.findOne(scopedId);
      return res.json(sanitizeRow(updated || { ...existing, ...update }));
    })
  );

  router.delete(
    "/:id",
    requireProjectPermission(PERMISSIONS.ENTITIES_DELETE),
    asyncHandler(async (req, res) => {
      const queryCascade = req.query.cascade;
      const bodyCascade = req.body && typeof req.body === "object" ? req.body.cascade : undefined;
      if (queryCascade !== undefined && bodyCascade !== undefined && String(queryCascade) !== String(bodyCascade)) {
        return res.status(400).json({ error: "cascade foi informado com valores conflitantes", code: "INVALID_CASCADE" });
      }
      let cascade;
      try {
        cascade = parseCascade(queryCascade !== undefined ? queryCascade : bodyCascade);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }

      try {
        await deleteEntity(req, entity, req.params.id, cascade);
        return res.status(204).end();
      } catch (error) {
        if (error?.code === "DEPENDENTS_EXIST") {
          return res.status(409).json({
            error: error.message,
            code: error.code,
            count: error.dependents?.blockingTotal ?? error.dependents?.total ?? 0,
            dependents: error.dependents?.counts || {},
          });
        }
        if (["NOT_FOUND", "PERMISSION_DENIED", "INVALID_CASCADE", "TRANSACTIONS_REQUIRED"].includes(error?.code)) {
          return res.status(error.status || (error.code === "NOT_FOUND" ? 404 : 403)).json({ error: error.message, code: error.code });
        }
        throw error;
      }
    })
  );

  return router;
}

export default crudRouter;
