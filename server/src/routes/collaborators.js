import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { col, withMongoTransaction } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { sanitizeRow, passwordSchema, emailSchema, uuidSchema, sanitizeText, escapeRegExp } from "../validation.js";
import { hashToken } from "../auth.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";
import { ensureDefaultProject, resolveUser, SYSTEM_ROLE_IDS } from "../authz.js";

const router = Router();
router.use(authMiddleware);

// VULN-018: bloqueia convites apenas por relógio adulterado (não por DevTools).
// Fail-open em erro de leitura (não derruba o fluxo por indisponibilidade).
router.use(async (req, res, next) => {
  try {
    const scoreCol = await col("integrity_score");
    const row = await scoreCol.findOne({ user_id: req.user.uid });
    const reason = String(row?.block_reason || "");
    if (row?.blocked && (reason === "clock_rolled_back" || reason === "excessive_drift")) {
      return res.status(403).json({ error: "Acesso bloqueado" });
    }
  } catch {
    /* fail-open */
  }
  next();
});

/** Mascara e-mail em logs (VULN-024): mail@dom.com → m***@dom.com */
function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at <= 0) return "***";
  const local = s.slice(0, at);
  return `${local[0]}***@${s.slice(at + 1)}`;
}

// POST /api/collaborators/invite - Invite a collaborator
router.post("/invite", asyncHandler(async (req, res) => {
  // Bloquear convites feitos por colaboradores
  const collabsCol = await col("collaborators");
  const asCollab = await collabsCol.findOne({ user_id: req.user.uid, status: "active" });
  if (asCollab) {
    return res.status(403).json({ error: "Colaboradores nao podem convidar outros colaboradores." });
  }

  if (process.env.ALLOW_LEGACY_INVITES !== "true") {
    return res.status(410).json({
      error: "Convites legados desativados. Use /api/projects/:projectId/invites.",
    });
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
      token_hash: hashToken(resetToken),
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
     expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
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
      console.log(`[invite] Email de convite enviado para ${maskEmail(normalizedEmail)}`);
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
  const invite = await collabsCol.findOne({ _id: parsedId.data, owner_id: req.user.uid });
  if (!invite) {
    return res.status(404).json({ error: "Colaborador nao encontrado" });
  }
  let projectId = invite.project_id ? String(invite.project_id) : "";
  if (!projectId) {
    const owner = await resolveUser({ uid: req.user.uid });
    const defaultProject = await ensureDefaultProject(owner);
    projectId = String(defaultProject?.id || defaultProject?._id || "");
  }
  const invitedUser = await resolveUser({ uid: invite.user_id || invite.user_key || invite.email }).catch(() => null);
  const identityValues = [...new Set([
    invite.user_id,
    invite.user_key,
    invitedUser?._id,
    invitedUser?.id,
    invitedUser?.user_key,
  ].filter((value) => value !== undefined && value !== null && value !== "").map(String))];
  await withMongoTransaction(async (session) => {
    const result = await collabsCol.deleteOne({ _id: parsedId.data, owner_id: req.user.uid }, { session });
    if (result.deletedCount === 0) throw new Error("COLLABORATOR_NOT_FOUND");
    if (projectId) {
      const members = await col("project_members");
      const identityFilter = identityValues.flatMap((value) => [{ user_id: value }, { user_key: value }]);
      if (invite.email) identityFilter.push({ email: String(invite.email).toLowerCase() });
      await members.deleteMany({ project_id: projectId, $or: identityFilter }, { session });
      const push = await col("push_subscriptions");
      const pushFilter = identityValues.flatMap((value) => [{ user_id: value }, { actor: value }]);
      await push.deleteMany({ project_id: projectId, $or: pushFilter }, { session });
    }
  });
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

   if (typeof invite.token !== "string" || !invite.token || typeof token !== "string" || token !== invite.token) {
     return res.status(403).json({ error: "Token do convite inválido" });
   }
    const inviteExpiry = invite.expires_at || invite.expiresAt || (
      invite.created_at && Number.isFinite(new Date(invite.created_at).getTime())
        ? new Date(new Date(invite.created_at).getTime() + 30 * 86400000).toISOString()
        : null
    );
    if (inviteExpiry && Number.isFinite(new Date(inviteExpiry).getTime()) && new Date(inviteExpiry).getTime() <= Date.now()) {
      return res.status(410).json({ error: "Convite expirado" });
    }

  // Check if the current user is the invited one (case-insensitive)
  const currentUser = await resolveUser(req.user);
  const inviteEmail = String(invite.email || "").toLowerCase();
  const userEmail = String(currentUser?.email || "").toLowerCase();

  if (!currentUser || !userEmail || userEmail !== inviteEmail) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

       if (currentUser.email_verified !== true) {
      return res.status(403).json({ error: "Confirme seu e-mail antes de aceitar o convite" });
    }

    let membershipProjectId = invite.project_id ? String(invite.project_id) : "";
   if (!membershipProjectId) {
     const owner = await resolveUser({ uid: invite.owner_id });
     const defaultProject = await ensureDefaultProject(owner);
     membershipProjectId = String(defaultProject?.id || defaultProject?._id || "");
   }
   if (!membershipProjectId) return res.status(400).json({ error: "Projeto default do owner não encontrado" });

   const effective = await resolveEffectivePlan(invite.owner_id, membershipProjectId);
   const maxMembers = getPlanFeatures(effective.plan).maxColaboradores;
   if (maxMembers === 0) return res.status(403).json({ error: "O plano do proprietário não permite mais colaboradores." });

   const accepted = await withMongoTransaction(async (session) => {
     const lock = await col("member_count_locks");
     await lock.updateOne(
       { _id: `members:${membershipProjectId}` },
       { $inc: { revision: 1 }, $set: { updated_at: new Date().toISOString() } },
       { upsert: true, session },
     );
     const members = await col("project_members");
     const current = await members.countDocuments({
       project_id: membershipProjectId,
       status: { $in: ["active", "pending"] },
       $nor: [{ role_id: "owner" }, { role: "owner" }],
     }, { session });
     if (current >= maxMembers) return { limitReached: true };

     const updatedInvite = await collabsCol.updateOne(
       { _id: parsedId.data, status: "pending" },
       { $set: { user_id: req.user.uid, status: "active", project_id: membershipProjectId } },
       { session },
     );
     if (updatedInvite.matchedCount === 0) throw new Error("INVITE_ALREADY_PROCESSED");

     if (membershipProjectId) {
       const resolved = await resolveUser(req.user);
       const roleId = invite.role === "admin" ? SYSTEM_ROLE_IDS.EDITOR : SYSTEM_ROLE_IDS.VIEWER;
       const projectId = membershipProjectId;
       const userKey = String(resolved.user_key);
       const existing = await members.findOne(
         {
           $or: [
             { project_id: projectId, user_key: userKey },
             { project_id: projectId, user_id: userKey },
             { project_id: projectId, user_id: req.user.uid },
           ],
         },
         { session },
       );
       if (existing) {
         await members.updateOne(
           { _id: existing._id },
           { $set: { user_key: userKey, user_id: userKey, role_id: roleId, status: "active", updated_at: new Date().toISOString() } },
           { session },
         );
       } else {
         await members.insertOne({
           _id: crypto.randomUUID(),
           id: crypto.randomUUID(),
           project_id: projectId,
           user_key: userKey,
           user_id: userKey,
           role_id: roleId,
           status: "active",
           created_at: new Date().toISOString(),
           updated_at: new Date().toISOString(),
         }, { session });
         }
       }
       return { limitReached: false };
     });

    if (accepted?.limitReached) {
      return res.status(403).json({ error: "Limite de colaboradores do projeto atingido." });
    }

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

   if (typeof invite.token !== "string" || !invite.token || typeof token !== "string" || token !== invite.token) {
     return res.status(403).json({ error: "Token do convite inválido" });
   }

  // Check if the current user is the invited one (case-insensitive)
  const currentUser = await resolveUser(req.user);
  const inviteEmail = String(invite.email || "").toLowerCase();
  const userEmail = String(currentUser?.email || "").toLowerCase();

  if (!currentUser || !userEmail || userEmail !== inviteEmail) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

  await withMongoTransaction(async (session) => {
    const deleted = await collabsCol.deleteOne({ _id: parsedId.data, status: "pending" }, { session });
    if (deleted.deletedCount === 0) throw new Error("INVITE_ALREADY_PROCESSED");
     if (invite.project_id) {
       const members = await col("project_members");
       await members.deleteMany({
         project_id: String(invite.project_id),
         $or: [{ user_id: req.user.uid }, { email: String(invite.email || "").toLowerCase() }],
       }, { session });
     }
  });
  res.json({ ok: true });
}));

export default router;