import { Router } from "express";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db, copyable } from "../db.js";
import { authMiddleware } from "../auth.js";

const router = Router();
router.use(authMiddleware);

const ENTITIES = ["lotes", "plantios", "insumos", "gastos", "colheitas"];

/** Se o registro do usuário sumiu (banco do plano gratuito é volátil), recria a
 *  conta a partir do token válido — o token continua funcionando e os dados
 *  reenviados pelo aparelho são aceitos. */
function ensureUser(user) {
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(user.uid);
  if (exists) return;
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
  const name = (user.email || "Produtor").split("@")[0] || "Produtor";
  db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)").run(user.uid, name, user.email || `u${user.uid}@local`, hash);
}

function applyOp(entity, action, row, uid) {
  const id = row.id || uuid();
  const data = { user_id: uid, id, ...row };
  const fields = copyable[entity].filter((f) => data[f] !== undefined);
  const keys = ["id", "user_id", ...fields];
  const values = [id, uid, ...fields.map((f) => data[f])];

  if (action === "delete") {
    db.prepare(`DELETE FROM ${entity} WHERE id = ? AND user_id = ?`).run(id, uid);
    return;
  }
  const existing = db.prepare(`SELECT user_id FROM ${entity} WHERE id = ?`).get(id);
  if (existing) {
    if (existing.user_id !== uid) return;
    const set = fields.map((f) => `${f} = ?`).join(", ");
    db.prepare(`UPDATE ${entity} SET ${set}, created_at = COALESCE(?, created_at) WHERE id = ?`).run(...fields.map((f) => data[f]), data.created_at || null, id);
  } else {
    const placeholders = keys.map(() => "?").join(", ");
    db.prepare(`INSERT INTO ${entity} (${keys.join(", ")}) VALUES (${placeholders})`).run(...values);
  }
}

function snapshot(uid) {
  const out = {};
  for (const table of ENTITIES) {
    out[table] = db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(uid);
  }
  return out;
}

router.post("/", (req, res) => {
  const uid = req.user.uid;
  ensureUser(req.user);
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
  db.exec("BEGIN");
  try {
    for (const op of ops) {
      if (!ENTITIES.includes(op.entity)) continue;
      applyOp(op.entity, op.action || "upsert", op.data || {}, uid);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return res.status(400).json({ error: "Sincronização falhou em uma operação: " + err.message });
  }
  res.json({ ok: true, snapshot: snapshot(uid), serverTime: new Date().toISOString() });
});

// Seed demo data for a fresh account
export { snapshot, ENTITIES };

export default router;