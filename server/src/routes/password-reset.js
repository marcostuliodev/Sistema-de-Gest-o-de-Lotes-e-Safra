import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { col } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";
import { emailSchema } from "../validation.js";

const router = Router();
const RESET_TOKEN_TTL = 60 * 60 * 1000; // 1 hour

// POST /api/auth/forgot-password
router.post("/forgot-password", asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) {
    return res.json({ ok: true, message: "Se o e-mail existir, você receberá um link de recuperação." });
  }

  const users = await col("users");
  const user = await users.findOne({ email: { $regex: new RegExp("^" + parsed.data + "$", "i") } });

  if (!user) {
    return res.json({ ok: true, message: "Se o e-mail existir, você receberá um link de recuperação." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + RESET_TOKEN_TTL);

  const resets = await col("password_resets");
  await resets.deleteMany({ user_id: user.id || user._id });
  await resets.insertOne({
    user_id: user.id || user._id,
    token,
    expires_at: expires.toISOString(),
    created_at: new Date().toISOString(),
  });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const APP_URL = process.env.APP_URL || "https://agrolote.marcostuliogc.com.br";
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  if (RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "Agrolote <noreply@agrolote.marcostuliogc.com.br>",
        to: user.email,
        subject: "Recuperação de senha - Agrolote",
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <div style="display: inline-block; background: #16a34a; color: white; width: 48px; height: 48px; border-radius: 12px; line-height: 48px; font-size: 24px;">🌱</div>
              <h1 style="color: #1c1917; margin-top: 16px;">Recuperação de senha</h1>
            </div>
            <p style="color: #57534e; font-size: 14px;">
              Olá <strong>${user.name || user.email}</strong>,
            </p>
            <p style="color: #57534e; font-size: 14px;">
              Recebemos uma solicitação para redefinir sua senha. Clique no botão abaixo para criar uma nova senha:
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${resetUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                Redefinir senha
              </a>
            </div>
            <p style="color: #a8a29e; font-size: 12px; text-align: center;">
              Este link expira em 1 hora. Se você não solicitou a recuperação, ignore este e-mail.
            </p>
          </div>
        `,
      });
      console.log(`[password-reset] Email enviado para ${user.email}`);
    } catch (e) {
      console.error("[password-reset] Erro ao enviar email:", e.message);
      console.log(`[password-reset] URL de reset (fallback): ${resetUrl}`);
    }
  } else {
    console.log(`[password-reset] RESEND_API_KEY não configurado. URL de reset: ${resetUrl}`);
  }

  res.json({ ok: true, message: "Se o e-mail existir, você receberá um link de recuperação." });
}));

// POST /api/auth/reset-password
router.post("/reset-password", asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};

  if (!token || !password) {
    return res.status(400).json({ error: "Token e senha são obrigatórios" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres" });
  }

  const resets = await col("password_resets");
  const resetRecord = await resets.findOne({ token });

  if (!resetRecord) {
    return res.status(400).json({ error: "Token inválido ou expirado" });
  }

  if (new Date(resetRecord.expires_at) < new Date()) {
    await resets.deleteOne({ _id: resetRecord._id });
    return res.status(400).json({ error: "Token expirado. Solicite uma nova recuperação." });
  }

  const users = await col("users");
  const hash = await bcrypt.hash(password, 10);

  const result = await users.updateOne(
    { id: resetRecord.user_id },
    { $set: { password_hash: hash } }
  );

  if (result.matchedCount === 0) {
    return res.status(400).json({ error: "Usuário não encontrado" });
  }

  await resets.deleteOne({ _id: resetRecord._id });

  res.json({ ok: true, message: "Senha redefinida com sucesso. Faça login." });
}));

// GET /api/auth/verify-reset-token/:token
router.get("/verify-reset-token/:token", asyncHandler(async (req, res) => {
  const resets = await col("password_resets");
  const resetRecord = await resets.findOne({ token: req.params.token });

  if (!resetRecord) {
    return res.status(400).json({ valid: false, error: "Token inválido" });
  }

  if (new Date(resetRecord.expires_at) < new Date()) {
    await resets.deleteOne({ _id: resetRecord._id });
    return res.status(400).json({ valid: false, error: "Token expirado" });
  }

  res.json({ valid: true });
}));

export default router;
