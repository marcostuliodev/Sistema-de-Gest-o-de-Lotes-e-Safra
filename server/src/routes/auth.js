import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { col, migrate } from "../db.js";
import { signToken, setAuthCookie, clearAuthCookie, hashToken } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { emailSchema, passwordSchema, nameSchema, escapeRegExp, sanitizeText } from "../validation.js";

const router = Router();

// VULN-008: hash válido de string desconhecida — bcrypt.compare roda sempre
// (user inexistente e senha errada têm o mesmo custo de timing).
const DUMMY_HASH = bcrypt.hashSync("timing-equalizer-" + crypto.randomBytes(16).toString("hex"), 10);

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
  const existing = await users.findOne({ email: { $regex: new RegExp("^" + escapeRegExp(parsedEmail.data) + "$", "i") } });
  // VULN-007: resposta idêntica à de conta nova (201, sem token, sem cookie,
  // sem 409) — não confirma que o e-mail existe. Não loga e não cria duplicata.
  // Timing alinhado com o caminho de criação (bcrypt + inserts ~mesmo custo).
  if (existing) {
    await bcrypt.hash(parsedPass.data, 10);
    return res.status(201).json({
      user: { id: Date.now(), name: parsedName.data, email: parsedEmail.data, email_verified: false },
    });
  }
  const hash = await bcrypt.hash(parsedPass.data, 10);
  const id = Date.now();
  await users.insertOne({ _id: id, id, name: parsedName.data, email: parsedEmail.data, password_hash: hash, email_verified: false, created_at: new Date().toISOString() });

  // Send verification email
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const verifications = await col("email_verifications");
  await verifications.insertOne({
    user_id: id,
    token_hash: hashToken(verificationToken),
    expires_at: expires.toISOString(),
    created_at: new Date().toISOString(),
  });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const APP_URL = process.env.APP_URL || "https://agrolote.marcostuliogc.com.br";
  const verifyUrl = `${APP_URL}/verify-email?token=${verificationToken}`;

  if (RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "Agrolote <noreply@agrolote.marcostuliogc.com.br>",
        to: parsedEmail.data,
        subject: "Confirme seu e-mail - Agrolote",
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <div style="display: inline-block; background: #16a34a; color: white; width: 48px; height: 48px; border-radius: 12px; line-height: 48px; font-size: 24px;">🌱</div>
              <h1 style="color: #1c1917; margin-top: 16px;">Confirme seu e-mail</h1>
            </div>
            <p style="color: #57534e; font-size: 14px;">
              Olá <strong>${sanitizeText(parsedName.data)}</strong>,
            </p>
            <p style="color: #57534e; font-size: 14px;">
              Clique no botão abaixo para confirmar seu e-mail e ativar sua conta no Agrolote:
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${verifyUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                Confirmar e-mail
              </a>
            </div>
            <p style="color: #a8a29e; font-size: 12px; text-align: center;">
              Este link expira em 24 horas. Se você não criou uma conta no Agrolote, ignore este e-mail.
            </p>
          </div>
        `,
      });
      console.log(`[register] Email de verificação enviado para ${parsedEmail.data}`);
    } catch (e) {
      console.error("[register] Erro ao enviar email de verificação:", e.message);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[register] URL de verificação (fallback): ${verifyUrl}`);
      }
    }
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[register] RESEND_API_KEY não configurado. URL de verificação: ${verifyUrl}`);
    } else {
      console.log("[register] RESEND_API_KEY não configurado");
    }
  }

  const user = { id, name: parsedName.data, email: parsedEmail.data, email_verified: false };
  // VULN-007/023: sem JWT no body e sem cookie em register — o cliente
  // mostra a tela genérica e o usuário entra via /login (fluxo idêntico
  // para e-mail novo e já cadastrado).
  res.status(201).json({ user });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) return res.status(401).json({ error: "Credenciais invalidas" });
  try {
    const users = await col("users");
    const user = await users.findOne({ email: { $regex: new RegExp("^" + escapeRegExp(parsedEmail.data) + "$", "i") } });
    // VULN-008: compare SEMPRE roda (não há short-circuit no ||) — mesmo
    // tempo para usuário inexistente e senha incorreta; mensagem igual.
    const hash = user?.password_hash || DUMMY_HASH;
    const okPassword = await bcrypt.compare(typeof password === "string" ? password : "", hash);
    if (!user || !okPassword) {
      return res.status(401).json({ error: "Credenciais invalidas" });
    }
    const safe = { id: user.id, name: user.name, email: user.email, email_verified: user.email_verified !== false };
    const token = signToken(safe);
    setAuthCookie(res, token);
    // VULN-023: JWT só no cookie HttpOnly — não volta no body (client ignora).
    res.json({ user: safe });
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
  await users.insertOne({ _id: id, id, name: "Produtor Demo", email: "demo@agrolote.app", password_hash: hash, email_verified: true, created_at: new Date().toISOString() });
  return id;
}

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

export default router;
