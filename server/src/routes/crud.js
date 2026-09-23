import { Router } from "express";
import { v4 as uuid } from "uuid";
import { col, copyable, requiredFor } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { parseEntity, sanitizeSnapshot, sanitizeRow } from "../validation.js";
import { getPlanFeatures } from "../plans.js";

/** Entidades que têm limite por plano. */
const LIMITED_ENTITIES = {
  lotes: "maxLotes",
  plantios: "maxPlantios",
};

/**
 * Check if user has access to entity (owner or collaborator).
 * Returns { hasAccess: boolean, isOwner: boolean, canWrite: boolean }
 */
async function checkAccess(entity, userId, resourceId = null) {
  const collabsCol = await col("collaborators");

  // Check if user is an active collaborator
  const collab = await collabsCol.findOne({
    user_id: userId,
    status: "active",
  });

  if (collab) {
    // User is a collaborator - check permissions
    const canWrite = collab.role === "admin";
    return { hasAccess: true, isOwner: false, canWrite, ownerId: collab.owner_id };
  }

  // User is owner
  return { hasAccess: true, isOwner: true, canWrite: true, ownerId: userId };
}

function crudRouter(entity) {
  const router = Router();
  router.use(authMiddleware);

  router.get("/", asyncHandler(async (req, res) => {
    const c = await col(entity);
    const { hasAccess, isOwner } = await checkAccess(entity, req.user.uid);

    if (!hasAccess) {
      return res.status(403).json({ error: "Acesso negado" });
    }

    let filter;
    if (isOwner) {
      // Owner sees their own data
      filter = { user_id: req.user.uid };
    } else {
      // Collaborator sees data from all owners they collaborate with
      const collabsCol = await col("collaborators");
      const collabs = await collabsCol.find({
        user_id: req.user.uid,
        status: "active",
      }).toArray();
      const ownerIds = collabs.map(c => c.owner_id);
      filter = { user_id: { $in: ownerIds } };
    }

    const rows = await c.find(filter).sort({ _id: -1 }).toArray();
    res.json(sanitizeSnapshot({ [entity]: rows })[entity]);
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const { hasAccess, isOwner, canWrite, ownerId } = await checkAccess(entity, req.user.uid);

    if (!hasAccess) {
      return res.status(403).json({ error: "Acesso negado" });
    }

    if (!canWrite) {
      return res.status(403).json({ error: "Voce nao tem permissao para criar registros" });
    }

    const limitKey = LIMITED_ENTITIES[entity];
    // Limite vale para dono E colaborador — conta sempre no plano/contagem
    // do dono (ownerId), senão colaborador admin burlava o limite do plano.
    if (limitKey) {
      const sub = await (await col("subscriptions")).findOne({ user_id: ownerId });
      const activePlan = sub?.status === "trial" ? sub.trial_plan : (sub?.plan || "free");
      const features = getPlanFeatures(activePlan);
      const max = features[limitKey];

      if (max !== Infinity) {
        if (max <= 0) {
          return res.status(403).json({
            error: `Seu plano nao permite ${limitKey === "maxLotes" ? "lotes" : "plantios"}. Faca upgrade do seu plano.`,
            limit: max,
            current: 0,
            plan: activePlan,
          });
        }
        const count = await (await col(entity)).countDocuments({ user_id: ownerId });
        if (count >= max) {
          return res.status(403).json({
            error: `Limite de ${limitKey === "maxLotes" ? "lotes" : "plantios"} atingido (${max}). Faca upgrade do seu plano.`,
            limit: max,
            current: count,
            plan: activePlan,
          });
        }
      }
    }

    const body = req.body || {};
    try {
      parseEntity(entity, body);
    } catch (err) {
      return res.status(400).json({ error: err.errors?.[0]?.message || "Dados invalidos" });
    }

    const fields = copyable[entity].filter((f) => body[f] !== undefined);
    const id = body.id || uuid();
    // For collaborators, use the owner's user_id (ownerId vem do checkAccess)
    const doc = { _id: id, id, user_id: ownerId };
    for (const f of fields) doc[f] = body[f];

    const c = await col(entity);
    await c.insertOne(doc);
    res.status(201).json(sanitizeRow(doc));
  }));

  router.put("/:id", asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { hasAccess, isOwner, canWrite } = await checkAccess(entity, req.user.uid);

    if (!hasAccess) {
      return res.status(403).json({ error: "Acesso negado" });
    }

    if (!canWrite) {
      return res.status(403).json({ error: "Voce nao tem permissao para editar registros" });
    }

    const c = await col(entity);

    // Check ownership - either owner or collaborator
    let existing;
    if (isOwner) {
      existing = await c.findOne({ _id: id, user_id: req.user.uid });
    } else {
      // Collaborator can edit records from owners they collaborate with
      const collabsCol = await col("collaborators");
      const collabs = await collabsCol.find({
        user_id: req.user.uid,
        status: "active",
      }).toArray();
      const ownerIds = collabs.map(c => c.owner_id);
      existing = await c.findOne({ _id: id, user_id: { $in: ownerIds } });
    }

    if (!existing) return res.status(404).json({ error: "Registro nao encontrado" });

    try {
      parseEntity(entity, { id, ...req.body });
    } catch (err) {
      return res.status(400).json({ error: err.errors?.[0]?.message || "Dados invalidos" });
    }

    const fields = copyable[entity].filter((f) => req.body?.[f] !== undefined);
    if (fields.length === 0) {
      return res.json(sanitizeRow(await c.findOne({ _id: id })));
    }

    const update = {};
    for (const f of fields) update[f] = req.body[f];
    await c.updateOne({ _id: id }, { $set: update });

    res.json(sanitizeRow(await c.findOne({ _id: id })));
  }));

  router.delete("/:id", asyncHandler(async (req, res) => {
    const { hasAccess, isOwner, canWrite } = await checkAccess(entity, req.user.uid);

    if (!hasAccess) {
      return res.status(403).json({ error: "Acesso negado" });
    }

    if (!canWrite) {
      return res.status(403).json({ error: "Voce nao tem permissao para excluir registros" });
    }

    const c = await col(entity);

    // Check ownership - either owner or collaborator
    let result;
    if (isOwner) {
      result = await c.deleteOne({ _id: req.params.id, user_id: req.user.uid });
    } else {
      // Collaborator can delete records from owners they collaborate with
      const collabsCol = await col("collaborators");
      const collabs = await collabsCol.find({
        user_id: req.user.uid,
        status: "active",
      }).toArray();
      const ownerIds = collabs.map(c => c.owner_id);
      result = await c.deleteOne({ _id: req.params.id, user_id: { $in: ownerIds } });
    }

    if (result.deletedCount === 0) return res.status(404).json({ error: "Registro nao encontrado" });
    res.status(204).end();
  }));

  return router;
}

export default crudRouter;
