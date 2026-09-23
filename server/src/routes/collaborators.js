import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { sanitizeRow, passwordSchema } from "../validation.js";
import { getPlanFeatures } from "../plans.js";

const router = Router();
router.use(authMiddleware);

// POST /api/collaborators/invite - Invite a collaborator
router.post("/invite", asyncHandler(async (req, res) => {
  // Bloquear convites feitos por colaboradores
  const collabsCol = await col("collaborators");
  const asCollab = await collabsCol.findOne({ user_id: req.user.uid, status: "active" });
  if (asCollab) {
    return res.status(403).json({ error: "Colaboradores nao podem convidar outros colaboradores." });
  }

  const { email, role, password } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email obrigatorio" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (!["admin", "viewer"].includes(role)) {
    return res.status(400).json({ error: "Role invalida. Use 'admin' ou 'viewer'" });
  }

  // Validate password (required for new accounts)
  const parsedPass = passwordSchema.safeParse(password);
  if (!parsedPass.success) {
    return res.status(400).json({ error: parsedPass.error.issues[0]?.message || "Senha invalida" });
  }

  // Check if user is trying to invite themselves
  const usersCol = await col("users");
  const invitedUser = await usersCol.findOne({ email: { $regex: new RegExp("^" + normalizedEmail + "$", "i") } });
  if (invitedUser && invitedUser._id === req.user.uid) {
    return res.status(400).json({ error: "Voce nao pode convidar a si mesmo" });
  }

  // Check plan limit (colaborador herda o plano do dono)
  const { resolveEffectivePlan } = await import("../plans.js");
  const effective = await resolveEffectivePlan(req.user.uid);
  const activePlan = effective.plan;
  const features = getPlanFeatures(activePlan);
  const maxColab = features.maxColaboradores;

  if (maxColab === 0) {
    return res.status(403).json({
      error: "Seu plano nao permite colaboradores. Faca upgrade para usar esta funcionalidade.",
      plan: activePlan,
    });
  }

  // Count current active collaborators
  const currentCount = await collabsCol.countDocuments({
    owner_id: req.user.uid,
    status: { $in: ["pending", "active"] },
  });

  if (currentCount >= maxColab) {
    return res.status(403).json({
      error: `Limite de colaboradores atingido (${maxColab}). Faca upgrade do seu plano.`,
      limit: maxColab,
      current: currentCount,
      plan: activePlan,
    });
  }

  // Check if already invited
  const existingInvite = await collabsCol.findOne({
    owner_id: req.user.uid,
    email: normalizedEmail,
    status: { $in: ["pending", "active"] },
  });

  if (existingInvite) {
    return res.status(409).json({ error: "Este usuario ja foi convidado ou e colaborador" });
  }

  // Create collaborator account if it doesn't exist
  let userId = invitedUser?._id || null;
  if (!invitedUser) {
    const newUserId = uuid();
    const hash = await bcrypt.hash(parsedPass.data, 10);
    await usersCol.insertOne({
      _id: newUserId,
      id: newUserId,
      name: normalizedEmail.split("@")[0],
      email: normalizedEmail,
      password_hash: hash,
      email_verified: true,
      created_at: new Date().toISOString(),
    });
    userId = newUserId;
  }

  const id = uuid();
  const inviteToken = crypto.randomBytes(32).toString("hex");
  const doc = {
    _id: id,
    id,
    owner_id: req.user.uid,
    user_id: userId,
    email: normalizedEmail,
    role,
    status: "pending",
    token: inviteToken,
    created_at: new Date().toISOString(),
  };

  await collabsCol.insertOne(doc);

  // Send invitation email
  const owner = await usersCol.findOne({ _id: req.user.uid });
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const APP_URL = process.env.APP_URL || "https://agrolote.marcostuliogc.com.br";
  const inviteUrl = `${APP_URL}/login`;
  const roleLabel = role === "admin" ? "Administrador" : "Visualizador";

  if (RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "Agrolote <noreply@agrolote.marcostuliogc.com.br>",
        to: normalizedEmail,
        subject: `${owner?.name || "Alguém"} te convidou para colaborar no Agrolote`,
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <div style="display: inline-block; background: #16a34a; color: white; width: 48px; height: 48px; border-radius: 12px; line-height: 48px; font-size: 24px;">🌱</div>
              <h1 style="color: #1c1917; margin-top: 16px;">Convite para colaborar</h1>
            </div>
            <p style="color: #57534e; font-size: 14px;">
              Olá,
            </p>
            <p style="color: #57534e; font-size: 14px;">
              <strong>${owner?.name || "Alguém"}</strong> (${owner?.email || req.user.email}) te convidou para colaborar no Agrolote.
            </p>
            <p style="color: #57534e; font-size: 14px;">
              Papel: <strong>${roleLabel}</strong>
            </p>
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="color: #166534; font-size: 14px; margin: 0 0 8px 0;"><strong>Suas credenciais:</strong></p>
              <p style="color: #166534; font-size: 14px; margin: 0;">E-mail: <strong>${normalizedEmail}</strong></p>
              <p style="color: #166534; font-size: 14px; margin: 4px 0 0 0;">Senha: <strong>${password}</strong></p>
            </div>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${inviteUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                Entrar no Agrolote
              </a>
            </div>
            <p style="color: #57534e; font-size: 14px;">
              Faça login com as credenciais acima e aceite o convite na página Colaboradores.
            </p>
            <p style="color: #a8a29e; font-size: 12px; text-align: center;">
              Se você não esperava este convite, ignore este e-mail.
            </p>
          </div>
        `,
      });
      console.log(`[invite] Email de convite enviado para ${normalizedEmail}`);
    } catch (e) {
      console.error("[invite] Erro ao enviar email de convite:", e.message);
      console.log(`[invite] URL de convite (fallback): ${inviteUrl}`);
    }
  } else {
    console.log(`[invite] RESEND_API_KEY não configurado. URL de convite: ${inviteUrl}`);
  }

  res.status(201).json(sanitizeRow(doc));
}));

// GET /api/collaborators - List collaborators for current user's projects
router.get("/", asyncHandler(async (req, res) => {
  const collabsCol = await col("collaborators");
  const rows = await collabsCol
    .find({ owner_id: req.user.uid })
    .sort({ created_at: -1 })
    .toArray();
  res.json(rows.map(sanitizeRow));
}));

// DELETE /api/collaborators/:id - Remove a collaborator (owner only)
router.delete("/:id", asyncHandler(async (req, res) => {
  const collabsCol = await col("collaborators");
  const result = await collabsCol.deleteOne({
    _id: req.params.id,
    owner_id: req.user.uid,
  });
  if (result.deletedCount === 0) {
    return res.status(404).json({ error: "Colaborador nao encontrado" });
  }
  res.status(204).end();
}));

// POST /api/collaborators/accept - Accept an invitation
router.post("/accept", asyncHandler(async (req, res) => {
  const { id } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "ID do convite obrigatorio" });
  }

  const collabsCol = await col("collaborators");
  const invite = await collabsCol.findOne({ _id: id });

  if (!invite) {
    return res.status(404).json({ error: "Convite nao encontrado" });
  }

  if (invite.status !== "pending") {
    return res.status(400).json({ error: "Este convite ja foi processado" });
  }

  // Check if the current user is the invited one (case-insensitive)
  const usersCol = await col("users");
  const currentUser = await usersCol.findOne({ _id: req.user.uid });

  if (!currentUser || currentUser.email.toLowerCase() !== invite.email.toLowerCase()) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

  await collabsCol.updateOne(
    { _id: id },
    {
      $set: {
        user_id: invite.user_id ?? req.user.uid,
        status: "active",
      },
    }
  );

  res.json({ ok: true });
}));

// GET /api/collaborators/my-access - List projects user has access to
router.get("/my-access", asyncHandler(async (req, res) => {
  const collabsCol = await col("collaborators");
  const rows = await collabsCol
    .find({ user_id: req.user.uid, status: "active" })
    .sort({ created_at: -1 })
    .toArray();

  // Get owner info for each collaboration
  const usersCol = await col("users");
  const result = [];
  for (const row of rows) {
    const owner = await usersCol.findOne({ _id: row.owner_id });
    result.push({
      ...sanitizeRow(row),
      owner_name: owner?.name || "Desconhecido",
      owner_email: owner?.email || "",
    });
  }

  res.json(result);
}));

// GET /api/collaborators/pending - List pending invitations for current user
router.get("/pending", asyncHandler(async (req, res) => {
  const collabsCol = await col("collaborators");
  const emailRegex = new RegExp("^" + req.user.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
  const pending = await collabsCol.find({
    $or: [
      { user_id: req.user.uid, status: "pending" },
      { email: emailRegex, status: "pending", user_id: null },
    ],
  }).sort({ created_at: -1 }).toArray();

  // Get owner info for each invitation
  const usersCol = await col("users");
  const result = [];
  for (const row of pending) {
    const owner = await usersCol.findOne({ _id: row.owner_id });
    result.push({
      ...sanitizeRow(row),
      owner_name: owner?.name || "Desconhecido",
      owner_email: owner?.email || "",
    });
  }

  res.json(result);
}));

// POST /api/collaborators/decline - Decline an invitation
router.post("/decline", asyncHandler(async (req, res) => {
  const { id } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: "ID do convite obrigatorio" });
  }

  const collabsCol = await col("collaborators");
  const invite = await collabsCol.findOne({ _id: id });

  if (!invite) {
    return res.status(404).json({ error: "Convite nao encontrado" });
  }

  if (invite.status !== "pending") {
    return res.status(400).json({ error: "Este convite ja foi processado" });
  }

  // Check if the current user is the invited one (case-insensitive)
  const usersCol = await col("users");
  const currentUser = await usersCol.findOne({ _id: req.user.uid });

  if (!currentUser || currentUser.email.toLowerCase() !== invite.email.toLowerCase()) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

  await collabsCol.deleteOne({ _id: id });
  res.json({ ok: true });
}));

export default router;