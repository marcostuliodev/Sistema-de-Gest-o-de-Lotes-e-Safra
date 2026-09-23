import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { sanitizeRow, passwordSchema, emailSchema, uuidSchema, sanitizeText, escapeRegExp } from "../validation.js";
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

  // Validação real de e-mail (antes era só typeof string — permitia e-mails
  // inválidos e, pior, metacaracteres de regex no lookup por e-mail).
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) {
    return res.status(400).json({ error: parsedEmail.error.issues[0]?.message || "Email invalido" });
  }
  const normalizedEmail = parsedEmail.data; // trim + lowercase (zod emailSchema)

  if (!["admin", "viewer"].includes(role)) {
    return res.status(400).json({ error: "Role invalida. Use 'admin' ou 'viewer'" });
  }

  // Senha: aceita se fornecida; obrigatória apenas para contas novas é
  // verificada abaixo (para conta existente a senha fornecida é IGNORADA —
  // nunca trocamos a senha de quem já tem conta).
  let parsedPass = null;
  if (password !== undefined && password !== null && password !== "") {
    const r = passwordSchema.safeParse(password);
    if (!r.success) {
      return res.status(400).json({ error: r.error.issues[0]?.message || "Senha invalida" });
    }
    parsedPass = r;
  }

  // Check if user is trying to invite themselves
  const usersCol = await col("users");
  const invitedUser = await usersCol.findOne({
    email: { $regex: new RegExp("^" + escapeRegExp(normalizedEmail) + "$", "i") },
  });
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
  let createdAccount = false;
  let resetToken = null;
  if (!invitedUser) {
    const newUserId = uuid();
    // Senha do dono (se fornecida) ou aleatória — em ambos os casos o email
    // do convite NUNCA contém a senha; enviamos um link para o colaborador
    // definir a própria senha.
    const rawPassword = parsedPass ? parsedPass.data : crypto.randomBytes(24).toString("hex");
    const hash = await bcrypt.hash(rawPassword, 10);
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
    createdAccount = true;

    // Token de redefinição para o colaborador escolher a própria senha
    resetToken = crypto.randomBytes(32).toString("hex");
    const resets = await col("password_resets");
    await resets.deleteMany({ user_id: newUserId });
    await resets.insertOne({
      user_id: newUserId,
      token: resetToken,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    });
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
  const resetUrl = resetToken ? `${APP_URL}/reset-password?token=${resetToken}` : null;
  const roleLabel = role === "admin" ? "Administrador" : "Visualizador";
  const safeOwnerName = sanitizeText(owner?.name || "Alguém");
  const safeOwnerEmail = sanitizeText(owner?.email || req.user.email || "");
  const safeInviteEmail = sanitizeText(normalizedEmail);

  // NUNCA envia a senha em texto puro por e-mail. Conta nova recebe um link
  // para definir a própria senha; conta existente apenas faz login normal.
  const credentialBlock = createdAccount && resetUrl
    ? `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="color: #166534; font-size: 14px; margin: 0 0 8px 0;"><strong>Sua conta foi criada:</strong></p>
              <p style="color: #166534; font-size: 14px; margin: 0;">E-mail: <strong>${safeInviteEmail}</strong></p>
              <p style="color: #166534; font-size: 14px; margin: 8px 0 0 0;">
                Defina sua senha pelo link abaixo e depois entre com ela:
              </p>
              <div style="text-align: center; margin: 12px 0 0 0;">
                <a href="${resetUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                  Definir minha senha
                </a>
              </div>
            </div>`
    : `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="color: #166534; font-size: 14px; margin: 0 0 8px 0;"><strong>Você já tem uma conta no Agrolote:</strong></p>
              <p style="color: #166534; font-size: 14px; margin: 0;">Entre com o e-mail <strong>${safeInviteEmail}</strong> e sua senha atual.</p>
            </div>`;

  if (RESEND_API_KEY) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "Agrolote <noreply@agrolote.marcostuliogc.com.br>",
        to: normalizedEmail,
        subject: `${safeOwnerName} te convidou para colaborar no Agrolote`,
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
              <strong>${safeOwnerName}</strong> (${safeOwnerEmail}) te convidou para colaborar no Agrolote.
            </p>
            <p style="color: #57534e; font-size: 14px;">
              Papel: <strong>${roleLabel}</strong>
            </p>
            ${credentialBlock}
            <div style="text-align: center; margin: 32px 0;">
              <a href="${inviteUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                Entrar no Agrolote
              </a>
            </div>
            <p style="color: #57534e; font-size: 14px;">
              Após entrar, aceite o convite na página Colaboradores.
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
      if (process.env.NODE_ENV !== "production") {
        console.log(`[invite] URL de convite (fallback): ${inviteUrl}`);
        if (resetUrl) console.log(`[invite] URL para definir senha (fallback): ${resetUrl}`);
      }
    }
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[invite] RESEND_API_KEY não configurado. URL de convite: ${inviteUrl}`);
      if (resetUrl) console.log(`[invite] URL para definir senha: ${resetUrl}`);
    } else {
      console.log("[invite] RESEND_API_KEY não configurado");
    }
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
  const parsedId = uuidSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ error: "ID invalido" });
  }
  const collabsCol = await col("collaborators");
  const result = await collabsCol.deleteOne({
    _id: parsedId.data,
    owner_id: req.user.uid,
  });
  if (result.deletedCount === 0) {
    return res.status(404).json({ error: "Colaborador nao encontrado" });
  }
  res.status(204).end();
}));

// POST /api/collaborators/accept - Accept an invitation
router.post("/accept", asyncHandler(async (req, res) => {
  const { id, token } = req.body || {};

  const parsedId = uuidSchema.safeParse(id);
  if (!parsedId.success) {
    return res.status(400).json({ error: "ID do convite invalido" });
  }

  const collabsCol = await col("collaborators");
  const invite = await collabsCol.findOne({ _id: parsedId.data });

  if (!invite) {
    return res.status(404).json({ error: "Convite nao encontrado" });
  }

  if (invite.status !== "pending") {
    return res.status(400).json({ error: "Este convite ja foi processado" });
  }

  // O token era gerado no /invite mas NUNCA validado — agora é exigido
  // quando o convite possui token (convites legados sem token seguem ok).
  if (invite.token && (typeof token !== "string" || token !== invite.token)) {
    return res.status(403).json({ error: "Token do convite invalido" });
  }

  // Check if the current user is the invited one (case-insensitive)
  const usersCol = await col("users");
  const currentUser = await usersCol.findOne({ _id: req.user.uid });
  const inviteEmail = String(invite.email || "").toLowerCase();
  const userEmail = String(currentUser?.email || "").toLowerCase();

  if (!currentUser || !userEmail || userEmail !== inviteEmail) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

  await collabsCol.updateOne(
    { _id: parsedId.data },
    {
      $set: {
        // SEMPRE o uid autenticado — nunca preserva user_id potencialmente
        // errado gravado no invite (ex.: convite criado para conta nova).
        user_id: req.user.uid,
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
  // Tokens legados podem não ter e-mail — evita TypeError em 500.
  const myEmail = String(req.user.email || "").toLowerCase();
  if (!myEmail) {
    return res.json([]);
  }
  const emailRegex = new RegExp("^" + escapeRegExp(myEmail) + "$", "i");
  const pending = await collabsCol.find({
    $or: [
      { user_id: req.user.uid, status: "pending" },
      // Busca por email cobre convites cujo user_id ainda não aponta para o
      // usuário autenticado (criados antes do login). Sem filtro user_id: null
      // — o invite SEMPRE grava user_id na criação.
      { email: emailRegex, status: "pending" },
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
  const { id, token } = req.body || {};

  const parsedId = uuidSchema.safeParse(id);
  if (!parsedId.success) {
    return res.status(400).json({ error: "ID do convite invalido" });
  }

  const collabsCol = await col("collaborators");
  const invite = await collabsCol.findOne({ _id: parsedId.data });

  if (!invite) {
    return res.status(404).json({ error: "Convite nao encontrado" });
  }

  if (invite.status !== "pending") {
    return res.status(400).json({ error: "Este convite ja foi processado" });
  }

  // Mesma exigência de token do /accept.
  if (invite.token && (typeof token !== "string" || token !== invite.token)) {
    return res.status(403).json({ error: "Token do convite invalido" });
  }

  // Check if the current user is the invited one (case-insensitive)
  const usersCol = await col("users");
  const currentUser = await usersCol.findOne({ _id: req.user.uid });
  const inviteEmail = String(invite.email || "").toLowerCase();
  const userEmail = String(currentUser?.email || "").toLowerCase();

  if (!currentUser || !userEmail || userEmail !== inviteEmail) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

  await collabsCol.deleteOne({ _id: parsedId.data });
  res.json({ ok: true });
}));

export default router;