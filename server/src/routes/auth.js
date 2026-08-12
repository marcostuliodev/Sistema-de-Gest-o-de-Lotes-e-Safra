import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, migrate } from "../db.js";
import { signToken } from "../auth.js";
import { emailSchema, passwordSchema, nameSchema } from "../validation.js";

const router = Router();

router.post("/register", (req, res) => {
  const { name, email, password } = req.body || {};
  const parsedEmail = emailSchema.safeParse(email);
  const parsedPass = passwordSchema.safeParse(password);
  const parsedName = nameSchema.safeParse(name);
  if (!parsedEmail.success || !parsedPass.success || !parsedName.success) {
    return res.status(400).json({
      error: parsedEmail.error?.errors[0]?.message || parsedPass.error?.errors[0]?.message || parsedName.error?.errors[0]?.message,
    });
  }
  const existing = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(parsedEmail.data);
  if (existing) return res.status(409).json({ error: "E-mail ja cadastrado" });
  const hash = bcrypt.hashSync(parsedPass.data, 10);
  const info = db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run(parsedName.data, parsedEmail.data, hash);
  const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ user, token: signToken(user) });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) return res.status(401).json({ error: "Credenciais invalidas" });
  const user = db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(parsedEmail.data);
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Credenciais invalidas" });
  }
  const safe = { id: user.id, name: user.name, email: user.email };
  res.json({ user: safe, token: signToken(safe) });
});

export function createDemoAccount() {
  migrate();
  const exists = db.prepare("SELECT id FROM users WHERE email = 'demo@agrolote.app'").get();
  if (exists) return exists.id;
  const hash = bcrypt.hashSync("demo123", 10);
  const info = db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Produtor Demo', 'demo@agrolote.app', ?)").run(hash);
  return info.lastInsertRowid;
}

export default router;