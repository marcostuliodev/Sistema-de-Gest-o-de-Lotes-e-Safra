import { Router } from "express";
import { db, requiredFor, copyable } from "../db.js";
import { authMiddleware } from "../auth.js";

function crudRouter(entity) {
  const router = Router();
  router.use(authMiddleware);

  router.get("/", (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${entity} WHERE user_id = ? ORDER BY id DESC`).all(req.user.uid);
    res.json(rows);
  });

  router.post("/", (req, res) => {
    const body = req.body || {};
    for (const field of requiredFor[entity]) {
      if (body[field] === undefined || body[field] === null || body[field] === "") {
        return res.status(400).json({ error: `Campo obrigatório: ${field}` });
      }
    }
    const fields = copyable[entity].filter((f) => body[f] !== undefined);
    const keys = ["user_id", ...fields];
    const placeholders = keys.map(() => "?").join(", ");
    const values = [req.user.uid, ...fields.map((f) => body[f])];
    const info = db.prepare(`INSERT INTO ${entity} (${keys.join(", ")}) VALUES (${placeholders})`).run(...values);
    const row = db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json(row);
  });

  router.put("/:id", (req, res) => {
    const id = req.params.id;
    const existing = db.prepare(`SELECT id FROM ${entity} WHERE id = ? AND user_id = ?`).get(id, req.user.uid);
    if (!existing) return res.status(404).json({ error: "Registro não encontrado" });
    const fields = copyable[entity].filter((f) => req.body?.[f] !== undefined);
    if (fields.length === 0) return res.json(db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id));
    const set = fields.map((f) => `${f} = ?`).join(", ");
    db.prepare(`UPDATE ${entity} SET ${set} WHERE id = ?`).run(...fields.map((f) => req.body[f]), id);
    res.json(db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id));
  });

  router.delete("/:id", (req, res) => {
    const info = db.prepare(`DELETE FROM ${entity} WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.uid);
    if (info.changes === 0) return res.status(404).json({ error: "Registro não encontrado" });
    res.status(204).end();
  });

  return router;
}

export default crudRouter;