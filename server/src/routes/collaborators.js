import { Router } from "express";
import { v4 as uuid } from "uuid";
import { col } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { sanitizeRow } from "../validation.js";
import { getPlanFeatures } from "../plans.js";

const router = Router();
router.use(authMiddleware);

// POST /api/collaborators/invite - Invite a collaborator
router.post("/invite", asyncHandler(async (req, res) => {
  const { email, role } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email obrigatorio" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (!["admin", "viewer"].includes(role)) {
    return res.status(400).json({ error: "Role invalida. Use 'admin' ou 'viewer'" });
  }

  // Check if user is trying to invite themselves
  const usersCol = await col("users");
  const invitedUser = await usersCol.findOne({ email: normalizedEmail });
  if (invitedUser && invitedUser._id === req.user.uid) {
    return res.status(400).json({ error: "Voce nao pode convidar a si mesmo" });
  }

  // Check plan limit
  const sub = await (await col("subscriptions")).findOne({ user_id: req.user.uid });
  const activePlan = sub?.status === "trial" ? sub.trial_plan : (sub?.plan || "free");
  const features = getPlanFeatures(activePlan);
  const maxColab = features.maxColaboradores;

  if (maxColab === 0) {
    return res.status(403).json({
      error: "Seu plano nao permite colaboradores. Faca upgrade para usar esta funcionalidade.",
      plan: activePlan,
    });
  }

  // Count current active collaborators
  const collabsCol = await col("collaborators");
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

  const id = uuid();
  const doc = {
    _id: id,
    id,
    owner_id: req.user.uid,
    user_id: invitedUser?._id || null,
    email: normalizedEmail,
    role,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  await collabsCol.insertOne(doc);
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

  // Check if the current user is the invited one
  const usersCol = await col("users");
  const currentUser = await usersCol.findOne({ _id: req.user.uid });

  if (!currentUser || currentUser.email !== invite.email) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

  await collabsCol.updateOne(
    { _id: id },
    {
      $set: {
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
  const rows = await collabsCol
    .find({ user_id: req.user.uid, status: "pending" })
    .sort({ created_at: -1 })
    .toArray();

  // Get owner info for each invitation
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

  // Check if the current user is the invited one
  const usersCol = await col("users");
  const currentUser = await usersCol.findOne({ _id: req.user.uid });

  if (!currentUser || currentUser.email !== invite.email) {
    return res.status(403).json({ error: "Voce nao e o destinatario deste convite" });
  }

  await collabsCol.deleteOne({ _id: id });
  res.json({ ok: true });
}));

export default router;