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

function crudRouter(entity) {
  const router = Router();
  router.use(authMiddleware);

  router.get("/", asyncHandler(async (req, res) => {
    const c = await col(entity);
    const rows = await c.find({ user_id: req.user.uid }).sort({ _id: -1 }).toArray();
    res.json(sanitizeSnapshot({ [entity]: rows })[entity]);
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const limitKey = LIMITED_ENTITIES[entity];
    if (limitKey) {
      const sub = await (await col("subscriptions")).findOne({ user_id: req.user.uid });
      const activePlan = sub?.status === "trial" ? sub.trial_plan : (sub?.plan || "free");
      const features = getPlanFeatures(activePlan);
      const max = features[limitKey];

      if (max !== Infinity && max > 0) {
        const count = await (await col(entity)).countDocuments({ user_id: req.user.uid });
        if (count >= max) {
          return res.status(403).json({
            error: `Limite de ${limitKey === "maxLotes" ? "lotes" : "plantios"} atingido (${max}). Faça upgrade do seu plano.`,
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
    const doc = { _id: id, id, user_id: req.user.uid };
    for (const f of fields) doc[f] = body[f];

    const c = await col(entity);
    await c.insertOne(doc);
    res.status(201).json(sanitizeRow(doc));
  }));

  router.put("/:id", asyncHandler(async (req, res) => {
    const id = req.params.id;
    const c = await col(entity);
    const existing = await c.findOne({ _id: id, user_id: req.user.uid });
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
    const c = await col(entity);
    const result = await c.deleteOne({ _id: req.params.id, user_id: req.user.uid });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Registro nao encontrado" });
    res.status(204).end();
  }));

  return router;
}

export default crudRouter;
