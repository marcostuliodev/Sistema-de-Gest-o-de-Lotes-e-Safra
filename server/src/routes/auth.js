import { Router } from "express";
import bcrypt from "bcryptjs";
import { col, migrate } from "../db.js";
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
  const users = await col("users");
  const existing = await users.findOne({ email: { $regex: new RegExp("^" + parsedEmail.data + "$", "i") } });
  if (existing) return res.status(409).json({ error: "E-mail ja cadastrado" });
  const hash = await bcrypt.hash(parsedPass.data, 10);
  const id = Date.now();
  await users.insertOne({ _id: id, id, name: parsedName.data, email: parsedEmail.data, password_hash: hash, created_at: new Date().toISOString() });
  const user = { id, name: parsedName.data, email: parsedEmail.data };
  const token = signToken(user);
  setAuthCookie(res, token);
  res.status(201).json({ user, token });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) return res.status(401).json({ error: "Credenciais invalidas" });
  try {
    const users = await col("users");
    const user = await users.findOne({ email: { $regex: new RegExp("^" + parsedEmail.data + "$", "i") } });
    if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
      return res.status(401).json({ error: "Credenciais invalidas" });
    }
    const safe = { id: user.id, name: user.name, email: user.email };
    const token = signToken(safe);
    setAuthCookie(res, token);
    res.json({ user: safe, token });
  } catch (e) {
    console.error("[login] Erro:", e.message);
    res.status(500).json({ error: "Erro interno no login" });
  }
}));

export async function createDemoAccount() {
  await migrate();
  const users = await col("users");
  const exists = await users.findOne({ email: { $regex: /^demo@agrolote\.app$/i } });
  if (exists) return exists.id;
  const hash = await bcrypt.hash("demo123", 10);
  const id = Date.now();
  await users.insertOne({ _id: id, id, name: "Produtor Demo", email: "demo@agrolote.app", password_hash: hash, created_at: new Date().toISOString() });
  return id;
}

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

export default router;
