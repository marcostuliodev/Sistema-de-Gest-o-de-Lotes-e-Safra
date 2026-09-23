import { Router } from "express";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { col, copyable, bumpUsersSequence } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { entitySchemas, sanitizeSnapshot, sanitizeText } from "../validation.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";

const router = Router();
router.use(authMiddleware);

const ENTITIES = ["lotes", "plantios", "insumos", "gastos", "colheitas"];
const MAX_OPS = 100;

const LIMITED_ENTITIES = {
  lotes: "maxLotes",
  plantios: "maxPlantios",
};

async function assertCreateWithinPlanLimit(entity, uid) {
  const limitKey = LIMITED_ENTITIES[entity];
  if (!limitKey) return;

  const { plan: activePlan, owner_id } = await resolveEffectivePlan(uid);
  const ownerId = owner_id || uid;
  const features = getPlanFeatures(activePlan);
  const max = features[limitKey];

  if (max === Infinity) return;
  // max === 0 → plano sem acesso à entidade (não pula o check)
  if (max <= 0) {
    throw new Error(
      `Seu plano nao permite ${limitKey === "maxLotes" ? "lotes" : "plantios"}. Faca upgrade do seu plano.`
    );
  }
  const count = await (await col(entity)).countDocuments({ user_id: ownerId });
  if (count >= max) {
    throw new Error(
      `Limite de ${limitKey === "maxLotes" ? "lotes" : "plantios"} atingido (${max}). Faca upgrade do seu plano.`
    );
  }
}

async function ensureUser(user) {
  const users = await col("users");
  const exists = await users.findOne({ _id: user.uid });
  if (exists) return;
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
  const name = (user.email || "Produtor").split("@")[0] || "Produtor";
  await users.insertOne({
    _id: user.uid,
    id: user.uid,
    name,
    email: user.email || `u${user.uid}@local`,
    password_hash: hash,
  });
  await bumpUsersSequence();
}

async function applyOp(entity, action, row, uid) {
  const c = await col(entity);
  const id = row.id || uuid();
  const data = { user_id: uid, id, ...row };
  const fields = copyable[entity].filter((f) => data[f] !== undefined);

  if (action === "delete") {
    await c.deleteOne({ _id: id, user_id: uid });
    return;
  }

  const existing = await c.findOne({ _id: id });
  if (existing) {
    if (existing.user_id !== uid) return;
    const update = {};
    for (const f of fields) {
      update[f] = data[f];
    }
    await c.updateOne({ _id: id }, { $set: update });
  } else {
    await assertCreateWithinPlanLimit(entity, uid);
    const doc = { _id: id, id, user_id: uid };
    for (const f of fields) {
      doc[f] = data[f];
    }
    await c.insertOne(doc);
  }
}

async function snapshot(uid) {
  const out = {};
  for (const entity of ENTITIES) {
    const c = await col(entity);
    out[entity] = await c.find({ user_id: uid }).toArray();
  }
  return sanitizeSnapshot(out);
}

router.post("/", asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
  if (ops.length > MAX_OPS) {
    return res.status(400).json({ error: `Muitos operacoes (max ${MAX_OPS})` });
  }
  try {
    await ensureUser(req.user);
    for (const op of ops) {
      if (!ENTITIES.includes(op.entity)) continue;
      const action = op.action || "upsert";
      if (action === "delete") {
        if (!op.data?.id) throw new Error("id obrigatorio para deletar");
      } else {
        const schema = entitySchemas[op.entity];
        if (schema) {
          const parsed = schema.safeParse(op.data || {});
          if (!parsed.success) {
            throw new Error(parsed.error.errors[0]?.message || "Dados invalidos no sync");
          }
        }
      }
      await applyOp(op.entity, action, op.data || {}, uid);
    }
    const snap = await snapshot(uid);
    res.json({ ok: true, snapshot: snap, serverTime: new Date().toISOString() });
  } catch (err) {
    const isProd = process.env.NODE_ENV === "production";
    return res.status(400).json({ error: isProd ? "Sincronizacao falhou" : err.message });
  }
}));

export { snapshot, ENTITIES };

export default router;
