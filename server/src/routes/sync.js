import { Router } from "express";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db, copyable, withTransaction, bumpUsersSequence } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { entitySchemas, sanitizeSnapshot, sanitizeText } from "../validation.js";

const router = Router();
router.use(authMiddleware);

const ENTITIES = ["lotes", "plantios", "insumos", "gastos", "colheitas"];
const MAX_OPS = 100;

async function ensureUser(t, user) {
  const exists = await t.prepare("SELECT id FROM users WHERE id = ?").get(user.uid);
  if (exists) return;
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
  const name = (user.email || "Produtor").split("@")[0] || "Produtor";
  await t.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)").run(user.uid, name, user.email || `u${user.uid}@local`, hash);
  await bumpUsersSequence();
}

async function applyOp(t, entity, action, row, uid) {
  const id = row.id || uuid();
  const data = { user_id: uid, id, ...row };
  const fields = copyable[entity].filter((f) => data[f] !== undefined);
  const keys = ["id", "user_id", ...fields];
  const values = [id, uid, ...fields.map((f) => data[f])];

  if (action === "delete") {
    await t.prepare(`DELETE FROM ${entity} WHERE id = ? AND user_id = ?`).run(id, uid);
    return;
  }
  const existing = await t.prepare(`SELECT user_id FROM ${entity} WHERE id = ?`).get(id);
  if (existing) {
    if (existing.user_id !== uid) return;
    const set = fields.map((f) => `${f} = ?`).join(", ");
    await t.prepare(`UPDATE ${entity} SET ${set}, created_at = COALESCE(?, created_at) WHERE id = ?`).run(...fields.map((f) => data[f]), data.created_at || null, id);
  } else {
    const placeholders = keys.map(() => "?").join(", ");
    await t.prepare(`INSERT INTO ${entity} (${keys.join(", ")}) VALUES (${placeholders})`).run(...values);
  }
}

async function snapshot(t, uid) {
  const out = {};
  for (const table of ENTITIES) {
    out[table] = await t.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(uid);
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
    const result = await withTransaction(async (t) => {
      await ensureUser(t, req.user);
      for (const op of ops) {
        if (!ENTITIES.includes(op.entity)) continue;
        const action = op.action || "upsert";
        if (action === "delete") {
          // Delete só precisa do id; não validamos contra o schema completo
          // do registro (que exige campos como nome/area), senão o sync todo
          // falharia e o item nunca seria removido do servidor.
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
        await applyOp(t, op.entity, action, op.data || {}, uid);
      }
      const snap = await snapshot(t, uid);
      return snap;
    });
    res.json({ ok: true, snapshot: result, serverTime: new Date().toISOString() });
  } catch (err) {
    const isProd = process.env.NODE_ENV === "production";
    return res.status(400).json({ error: isProd ? "Sincronizacao falhou" : err.message });
  }
}));

export { snapshot, ENTITIES };

export default router;
