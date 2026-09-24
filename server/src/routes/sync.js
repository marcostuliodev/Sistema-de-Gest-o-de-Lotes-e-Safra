import { Router } from "express";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { col, copyable, bumpUsersSequence } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { entitySchemas, sanitizeSnapshot } from "../validation.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";

const router = Router();
router.use(authMiddleware);

const ENTITIES = ["lotes", "plantios", "insumos", "gastos", "colheitas"];
const MAX_OPS = 100;

const LIMITED_ENTITIES = {
  lotes: "maxLotes",
  plantios: "maxPlantios",
};

function planLimitError(message) {
  const error = new Error(message);
  error.code = "PLAN_LIMIT";
  return error;
}

async function assertCreateWithinPlanLimit(entity, uid) {
  const limitKey = LIMITED_ENTITIES[entity];
  if (!limitKey) return;

  const { plan: activePlan, owner_id } = await resolveEffectivePlan(uid);
  const ownerId = owner_id || uid;
  const features = getPlanFeatures(activePlan);
  const max = features[limitKey];

  if (max === Infinity) return;
  if (max <= 0) {
    throw planLimitError(
      `Seu plano nao permite ${limitKey === "maxLotes" ? "lotes" : "plantios"}. Faca upgrade do seu plano.`
    );
  }

  const count = await (await col(entity)).countDocuments({ user_id: ownerId });
  if (count >= max) {
    throw planLimitError(
      `Limite de ${limitKey === "maxLotes" ? "lotes" : "plantios"} atingido (${max}). Faca upgrade do seu plano.`
    );
  }
}

async function ensureUser(user) {
  const users = await col("users");
  // Contas legadas podem ter _id ObjectId e o id de aplicação numérico.
  // O JWT usa user.id, portanto procurar apenas por _id não encontra o admin
  // e tentava inserir um documento duplicado (falha no índice único de e-mail).
  const identity = user.uid;
  const or = [];
  if (identity !== undefined && identity !== null) {
    or.push({ _id: identity }, { id: identity });
  }
  if (user.email) or.push({ email: user.email });
  const exists = or.length > 0 ? await users.findOne({ $or: or }) : null;
  if (exists) return;
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
  const name = (user.email || "Produtor").split("@")[0] || "Produtor";
  await users.insertOne({
    _id: identity,
    id: identity,
    name,
    email: user.email || `u${identity}@local`,
    password_hash: hash,
  });
  await bumpUsersSequence();
}

async function applyOp(entity, action, row, uid) {
  const c = await col(entity);
  const schema = entitySchemas[entity];
  const idData = schema.pick({ id: true }).parse(row);
  const id = idData.id || uuid();

  if (action === "delete") {
    await c.deleteOne({ _id: id, user_id: uid });
    return;
  }

  const existing = await c.findOne({ _id: id });
  if (existing) {
    if (existing.user_id !== uid) return;

    // Um patch parcial deve ser validado e persistido apenas nos campos
    // enviados; defaults do schema não podem apagar dados já existentes.
    const parsed = schema.partial().parse(row);
    const fields = copyable[entity].filter((f) => row[f] !== undefined);
    const update = {};
    for (const f of fields) update[f] = parsed[f];
    if (fields.length > 0) {
      await c.updateOne({ _id: id }, { $set: update });
    }
    return;
  }

  // Uma criação exige o documento completo e grava os defaults validados.
  await assertCreateWithinPlanLimit(entity, uid);
  const parsed = schema.parse(row);
  const fields = copyable[entity].filter((f) => parsed[f] !== undefined);
  const doc = { _id: id, id, user_id: uid };
  for (const f of fields) doc[f] = parsed[f];
  await c.insertOne(doc);
}

async function snapshot(uid) {
  // As cinco leituras são independentes; executar em paralelo reduz o tempo
  // de resposta sem alterar os dados ou a ordem de aplicação das operações.
  const entries = await Promise.all(
    ENTITIES.map(async (entity) => {
      const c = await col(entity);
      return [entity, await c.find({ user_id: uid }).toArray()];
    })
  );
  return sanitizeSnapshot(Object.fromEntries(entries));
}

function invalidOperation(message = "Dados invalidos no sync") {
  const error = new Error(message);
  error.code = "SYNC_INVALID";
  return error;
}

function operationFailure(op, index, error) {
  return {
    index,
    entity: typeof op?.entity === "string" ? op.entity : null,
    action: typeof op?.action === "string" ? op.action : null,
    code: error?.code === "PLAN_LIMIT" ? "PLAN_LIMIT" : "SYNC_INVALID",
  };
}

router.post("/", asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
  if (ops.length > MAX_OPS) {
    return res.status(400).json({
      error: `Muitos operacoes (max ${MAX_OPS})`,
      code: "TOO_MANY_OPS",
    });
  }

  try {
    await ensureUser(req.user);
    const appliedOpIndexes = [];
    const failedOps = [];

    // Processa cada operação isoladamente. Uma rejeição de plano ou validação
    // não impede que os demais registros do lote sejam sincronizados.
    for (const [index, op] of ops.entries()) {
      try {
        if (!op || !ENTITIES.includes(op.entity)) throw invalidOperation("Entidade invalida");
        const action = op.action || "upsert";
        if (action !== "upsert" && action !== "delete") throw invalidOperation("Acao invalida");

        const data = op.data || {};
        if (action === "delete" && !data.id) {
          throw invalidOperation("id obrigatorio para deletar");
        }

        await applyOp(op.entity, action, data, uid);
        appliedOpIndexes.push(index);
      } catch (error) {
        failedOps.push(operationFailure(op, index, error));
      }
    }

    const snap = await snapshot(uid);
    res.json({
      ok: failedOps.length === 0,
      snapshot: snap,
      serverTime: new Date().toISOString(),
      appliedOpIndexes,
      failedOps,
    });
  } catch (err) {
    const isProd = process.env.NODE_ENV === "production";
    return res.status(400).json({
      error: isProd ? "Sincronizacao falhou" : err.message,
      code: err?.code || "SYNC_UNAVAILABLE",
    });
  }
}));

export { snapshot, ENTITIES };
export default router;
