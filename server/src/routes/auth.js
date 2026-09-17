import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, migrate } from "../db.js";
import { signToken, setAuthCookie, clearAuthCookie } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { emailSchema, passwordSchema, nameSchema } from "../validation.js";

const router = Router();

router.post("/register", asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};
  const parsedEmail = emailSchema.safeParse(email);
  const parsedPass = passwordSchema.safeParse(password);
  const parsedName = nameSchema.safeParse(name);
  if (!parsedEmail.success || !parsedPass.success || !parsedName.success) {
    return res.status(400).json({
      error: parsedEmail.error?.errors[0]?.message || parsedPass.error?.errors[0]?.message || parsedName.error?.errors[0]?.message,
    });
  }
  const existing = await db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(parsedEmail.data);
  if (existing) return res.status(409).json({ error: "E-mail ja cadastrado" });
  const hash = await bcrypt.hash(parsedPass.data, 10);
  const info = await db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING id").run(parsedName.data, parsedEmail.data, hash);
  const user = await db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(info.lastInsertRowid);
  const token = signToken(user);
  setAuthCookie(res, token);
  res.status(201).json({ user, token });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) return res.status(401).json({ error: "Credenciais invalidas" });
  const user = await db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(parsedEmail.data);
  if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "Credenciais invalidas" });
  }
  const safe = { id: user.id, name: user.name, email: user.email };
  const token = signToken(safe);
  setAuthCookie(res, token);
  res.json({ user: safe, token });
}));

export async function createDemoAccount() {
  await migrate();
  const exists = await db.prepare("SELECT id FROM users WHERE lower(email) = lower('demo@agrolote.app')").get();
  if (exists) return exists.id;
  const hash = await bcrypt.hash("demo123", 10);
  const info = await db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Produtor Demo', 'demo@agrolote.app', ?) RETURNING id").run(hash);
  return info.lastInsertRowid;
}

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

export default router;
