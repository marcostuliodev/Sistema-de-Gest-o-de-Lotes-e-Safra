import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { col, withMongoTransaction } from "../db.js";
import { emailSchema, escapeRegExp, passwordSchema } from "../validation.js";
import { getPlanFeatures, getSubscriptionPlan } from "../plans.js";
import {
  AuthzError,
  PERMISSIONS,
  SYSTEM_ROLE_IDS,
  cleanText,
  createProjectForUser,
  ensureDefaultProject,
  ensureUserKey,
  getProjectMembers,
  getProjectRoles,
  getRoleForProject,
  getSystemRole,
  idToString,
  listAccessibleProjects,
  normalizeId,
  publicProjectMember,
  publicProjectRole,
  publicProjectSummary,
  projectMiddleware,
  requireProjectOwner,
  requireProjectPermission,
  resolveProjectAccess,
  validatePermissions,
} from "../authz.js";
import { getProjectOwner } from "../projectScope.js";

const router = Router();
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas convites. Tente novamente mais tarde." },
});
router.use(authMiddleware);

function authzRoute(handler) {
  return asyncHandler(async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof AuthzError) {
        if (!res.headersSent) res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  });
}

function invalidRequest(message, code = "INVALID_REQUEST") {
  return new AuthzError(message, 400, code);
}

function memberQueryValues(value) {
  const normalized = normalizeId(value);
  if (!normalized) return [];
  return [normalized, String(value)];
}

async function findMember(req, memberId) {
  const values = memberQueryValues(memberId);
  if (values.length === 0) return null;
  const projectOr = projectValues(req).map((value) => ({ project_id: value }));
  const memberOr = [];
  for (const value of values) memberOr.push({ _id: value }, { id: value });
  return (await col("project_members")).findOne({ $and: [{ $or: projectOr }, { $or: memberOr }] });
}

function projectValues(req) {
  const values = [];
  const seen = new Set();
  for (const value of [req.project?.id, req.project?._id, req.projectId]) {
    if (value === undefined || value === null) continue;
    const id = idToString(value);
    if (!id) continue;
    for (const candidate of [value, id, /^\d{1,20}$/.test(id) ? Number(id) : null]) {
      if (candidate === null || candidate === undefined) continue;
      const key = `${typeof candidate}:${idToString(candidate)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(candidate);
    }
  }
  return values;
}

function addIdentityValue(values, seen, value) {
  if (value === undefined || value === null) return;
  const id = idToString(value);
  if (!id) return;
  for (const candidate of [value, id]) {
    const candidateId = idToString(candidate);
    if (!candidateId || seen.has(candidateId)) continue;
    seen.add(candidateId);
    values.push({ user_key: candidate }, { user_id: candidate });
  }
}

async function findMemberForUser(req, user, userKey, email, session = null) {
  const projectOr = projectValues(req).map((value) => ({ project_id: value }));
  if (projectOr.length === 0) return null;
  const userOr = [];
  const seen = new Set();
  addIdentityValue(userOr, seen, user?._id);
  addIdentityValue(userOr, seen, user?.id);
  addIdentityValue(userOr, seen, user?.user_key);
  addIdentityValue(userOr, seen, userKey);
  if (email) {
    userOr.push({ email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, "i") } });
  }
  if (userOr.length === 0) return null;
  return (await col("project_members")).findOne(
    { $and: [{ $or: projectOr }, { $or: userOr }] },
    session ? { session } : undefined,
  );
}

function isProjectOwnerUser(project, user, userKey) {
  const owner = normalizeId(idToString(project?.owner_id || project?.owner_key || project?.created_by).trim().toLowerCase());
  if (!owner) return false;
  const candidates = [userKey, user?._id, user?.id, user?.user_key, user?.email]
    .map((value) => normalizeId(idToString(value).trim().toLowerCase()))
    .filter(Boolean);
  return candidates.includes(owner);
}

async function findRoleDocument(req, roleId) {
  const normalized = normalizeId(roleId);
  if (!normalized) return null;
  const projectOr = projectValues(req).map((value) => ({ project_id: value }));
  const roleOr = [{ _id: normalized }, { id: normalized }, { role_id: normalized }, { id: String(roleId) }];
  return (await col("roles")).findOne({ $and: [{ $or: projectOr }, { $or: roleOr }] });
}

function isProjectOwnerMember(project, member) {
  const owner = normalizeId(project.owner_id || project.owner_key || project.created_by);
  const memberUser = normalizeId(member?.user_key || member?.user_id);
  const roleId = normalizeId(member?.role_id || member?.role).toLowerCase();
  return !!owner && memberUser === owner || roleId === SYSTEM_ROLE_IDS.OWNER;
}

function projectRoleName(role) {
  return role?.name || role?.role || role?.id || "unknown";
}

function parseProjectName(body) {
  const value = body && typeof body === "object" ? body.name ?? body.nome : undefined;
  const name = cleanText(value, 120);
  if (!name) throw invalidRequest("Nome do projeto é obrigatório", "INVALID_PROJECT_NAME");
  return name;
}

function parseRolePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("Dados da role inválidos", "INVALID_ROLE");
  }
  const hasName = Object.hasOwn(body, "name") || Object.hasOwn(body, "nome");
  const hasPermissions = Object.hasOwn(body, "permissions");
  if (!hasName && !hasPermissions) throw invalidRequest("Informe name ou permissions", "INVALID_ROLE");
  const patch = {};
  if (hasName) {
    const rawName = body.name ?? body.nome;
    const name = cleanText(rawName, 120);
    if (!name) throw invalidRequest("Nome da role é obrigatório", "INVALID_ROLE_NAME");
    if (Object.values(SYSTEM_ROLE_IDS).some((id) => id === name.toLowerCase())) {
      throw invalidRequest("Nome reservado para role de sistema", "RESERVED_ROLE_NAME");
    }
    patch.name = name;
    patch.label = name;
  }
  if (hasPermissions) {
    const permissions = validatePermissions(body.permissions);
    if (permissions === null) throw invalidRequest("Permissão inválida", "INVALID_PERMISSION");
    patch.permissions = permissions;
  }
  return patch;
}

async function revokeLegacyMembership(project, projectId, member) {
  const userValues = [member?.user_key, member?.user_id, member?.email]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String);
  if (userValues.length === 0) return;
  const scope = [{ project_id: { $in: projectValues({ projectId }) } }];
  if (project?.is_default === true) {
    for (const value of [project.owner_id, project.owner_key, project.created_by]) {
      if (value !== undefined && value !== null) scope.push({ owner_id: value });
    }
  }
  await (await col("collaborators")).updateMany(
    {
      $and: [
        { $or: scope },
        { $or: userValues.flatMap((value) => [{ user_id: value }, { user_key: value }, { email: value }]) },
      ],
    },
    { $set: { status: "revoked", migrated_at: new Date().toISOString(), revoked_at: new Date().toISOString() } },
  );
}

async function revokePushAccess(projectId, member) {
  const values = [member?.user_key, member?.user_id].filter(Boolean).map(String);
  if (values.length === 0) return;
  await (await col("push_subscriptions")).deleteMany({
    project_id: { $in: projectValues({ projectId }) },
    $or: values.flatMap((value) => [{ user_id: value }, { actor: value }]),
  });
}

async function memberResponse(req, member) {
  const users = await col("users");
  const publicMember = await publicProjectMember(member, users);
  const role = await getRoleForProject(req.project, member.role_id || member.role);
  return {
    ...publicMember,
    role: role ? projectRoleName(role) : "unknown",
    role_id: role?.id || publicMember.role_id || null,
    permissions: role?.permissions || [],
  };
}

router.get("/", authzRoute(async (req, res) => {
  await ensureDefaultProject(req.user);
  const projects = await listAccessibleProjects(req.user);
  const response = [];
  for (const entry of projects) {
    response.push(await publicProjectSummary(entry.project, entry.access));
  }
  res.json(response);
}));

router.post("/", authzRoute(async (req, res) => {
  const name = parseProjectName(req.body);
  const created = await createProjectForUser(req.user, name);
  const access = await resolveProjectAccess(created.project, created.user);
  res.status(201).json(await publicProjectSummary(created.project, access));
}));

router.get(
  "/:projectId/roles",
  projectMiddleware,
  requireProjectPermission(PERMISSIONS.ROLES_READ),
  authzRoute(async (req, res) => {
    const roles = await getProjectRoles(req.project);
    const response = [];
    for (const role of roles) response.push(await publicProjectRole(role));
    res.json(response);
  })
);

router.post(
  "/:projectId/roles",
  projectMiddleware,
  requireProjectOwner,
  requireProjectPermission(PERMISSIONS.ROLES_MANAGE),
  authzRoute(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || (!Object.hasOwn(body, "name") && !Object.hasOwn(body, "nome"))) {
      throw invalidRequest("Informe name", "INVALID_ROLE_NAME");
    }
    const patch = parseRolePatch({ name: body.name ?? body.nome, permissions: body.permissions });
    if (!patch.permissions) throw invalidRequest("Informe permissions", "INVALID_PERMISSION");
    const roleId = uuid();
    const now = new Date().toISOString();
    const document = {
      _id: roleId,
      id: roleId,
      project_id: req.projectId,
      name: patch.name,
      label: patch.label,
      permissions: patch.permissions,
      system: false,
      is_system: false,
      created_at: now,
      updated_at: now,
    };
    await (await col("roles")).insertOne(document);
    res.status(201).json(await publicProjectRole(document));
  })
);

router.patch(
  "/:projectId/roles/:roleId",
  projectMiddleware,
  requireProjectOwner,
  requireProjectPermission(PERMISSIONS.ROLES_MANAGE),
  authzRoute(async (req, res) => {
    const role = await findRoleDocument(req, req.params.roleId);
    const systemRole = getSystemRole(req.params.roleId);
    if (systemRole || role?.system === true || role?.is_system === true) {
      throw invalidRequest("Roles de sistema não podem ser alteradas", "SYSTEM_ROLE_IMMUTABLE");
    }
    if (!role) throw new AuthzError("Role não encontrada", 404, "ROLE_NOT_FOUND");
    const patch = parseRolePatch(req.body);
    patch.updated_at = new Date().toISOString();
    await (await col("roles")).updateOne({ _id: role._id, project_id: req.projectId }, { $set: patch });
    const updated = await (await col("roles")).findOne({ _id: role._id, project_id: req.projectId });
    res.json(await publicProjectRole(updated));
  })
);

router.delete(
  "/:projectId/roles/:roleId",
  projectMiddleware,
  requireProjectOwner,
  requireProjectPermission(PERMISSIONS.ROLES_MANAGE),
  authzRoute(async (req, res) => {
    const role = await findRoleDocument(req, req.params.roleId);
    if (getSystemRole(req.params.roleId) || role?.system === true || role?.is_system === true) {
      throw invalidRequest("Roles de sistema não podem ser removidas", "SYSTEM_ROLE_IMMUTABLE");
    }
    if (!role) throw new AuthzError("Role não encontrada", 404, "ROLE_NOT_FOUND");
    const members = await col("project_members");
    const roles = await col("roles");
    const inUse = await members.countDocuments({ project_id: req.projectId, role_id: role.id });
    if (inUse > 0) {
      throw new AuthzError("Role está em uso por membros", 409, "ROLE_IN_USE");
    }
    await roles.deleteOne({ _id: role._id, project_id: req.projectId });
    res.status(204).end();
  })
);

router.post(
  "/:projectId/invites",
  inviteLimiter,
  projectMiddleware,
  requireProjectOwner,
  requireProjectPermission(PERMISSIONS.MEMBERS_MANAGE),
  authzRoute(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.role_id !== "string" || !body.role_id.trim()) {
      throw invalidRequest("Informe role_id", "INVALID_MEMBER_ROLE");
    }

    const parsedEmail = emailSchema.safeParse(body.email);
    if (!parsedEmail.success) {
      throw invalidRequest(parsedEmail.error.issues[0]?.message || "E-mail inválido", "INVALID_EMAIL");
    }
    const email = parsedEmail.data;
    const role = await getRoleForProject(req.project, body.role_id);
    if (!role) throw invalidRequest("Role inválida para este projeto", "INVALID_MEMBER_ROLE");
    if (String(role.id).toLowerCase() === SYSTEM_ROLE_IDS.OWNER) {
      throw invalidRequest("O owner não pode ser atribuído por convite", "OWNER_MEMBER_IMMUTABLE");
    }

     const ownerContext = await getProjectOwner(req);
     const rawOwnerValues = [req.project?.owner_id, req.project?.owner_key, req.project?.created_by, req.authUser?._id, req.authUser?.id, req.authUser?.user_key, ...(ownerContext.values || [])]
       .filter((value) => value !== undefined && value !== null);
     const ownerValues = [...new Set(rawOwnerValues.flatMap((value) => [value, String(value)]))];
     const subscriptions = await col("subscriptions");
     const subscription = ownerValues.length > 0
       ? await subscriptions.findOne({ $or: ownerValues.map((value) => ({ user_id: value })) })
       : null;
     const plan = getSubscriptionPlan(subscription);
    const maxMembers = getPlanFeatures(plan).maxColaboradores;


    const actorEmail = String(req.authUser?.email || req.user?.email || "").trim().toLowerCase();
    if (actorEmail && actorEmail === email) {
      throw invalidRequest("Você não pode convidar a si mesmo", "SELF_INVITE");
    }

    const users = await col("users");
    const emailFilter = { email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, "i") } };
     let invitedUser = await users.findOne(emailFilter);
     let userKey;
     let createdAccountId = null;

    if (invitedUser) {
      userKey = await ensureUserKey(invitedUser, users);
      if (isProjectOwnerUser(req.project, invitedUser, userKey)) {
        throw invalidRequest("O owner não pode ser alterado", "OWNER_MEMBER_IMMUTABLE");
      }
    } else {
      const parsedPassword = passwordSchema.safeParse(body.password);
      if (!parsedPassword.success) {
        throw invalidRequest(parsedPassword.error.issues[0]?.message || "Informe uma senha de no mínimo 8 caracteres", "PASSWORD_REQUIRED");
      }
      const accountId = uuid();
      userKey = uuid();
      const now = new Date().toISOString();
      const userDocument = {
        _id: accountId,
        id: accountId,
        user_key: userKey,
        name: cleanText(email.split("@")[0], 120) || "Colaborador",
        email,
        password_hash: await bcrypt.hash(parsedPassword.data, 10),
         email_verified: false,
        created_at: now,
        updated_at: now,
      };
      try {
         await users.insertOne(userDocument);
         createdAccountId = accountId;
         invitedUser = userDocument;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        invitedUser = await users.findOne(emailFilter);
        if (!invitedUser) throw error;
        userKey = await ensureUserKey(invitedUser, users);
      }
    }

    if (isProjectOwnerUser(req.project, invitedUser, userKey)) {
      throw invalidRequest("O owner não pode ser alterado", "OWNER_MEMBER_IMMUTABLE");
    }

     const now = new Date().toISOString();
     let member;
     try {
       member = await withMongoTransaction(async (session) => {
         const projectsCol = await col("projects");
         const memberLocks = await col("member_count_locks");
         await memberLocks.updateOne(
           { _id: `members:${req.projectId}` },
           { $inc: { revision: 1 }, $set: { updated_at: new Date().toISOString() } },
           { upsert: true, session },
         );
         await projectsCol.updateOne(
         { $or: [{ _id: req.project._id || req.projectId }, { id: req.projectId }] },
         { $inc: { membership_revision: 1 }, $set: { updated_at: new Date().toISOString() } },
         { session },
       );
       const members = await col("project_members");
         const existing = await findMemberForUser(req, invitedUser, userKey, email, session);
         const existingCountsTowardLimit = existing && ["active", "pending"].includes(String(existing.status || "active").toLowerCase());
          const collaboratorCount = await members.countDocuments({
          project_id: { $in: projectValues(req) },
          status: { $in: ["active", "pending"] },
          $nor: [{ role_id: SYSTEM_ROLE_IDS.OWNER }, { role: SYSTEM_ROLE_IDS.OWNER }],
        }, { session });
         if (maxMembers === 0 || (!existingCountsTowardLimit && collaboratorCount >= maxMembers)) {
         throw new AuthzError(
           maxMembers === 0
             ? "Seu plano não permite adicionar membros ao projeto."
             : `Limite de ${maxMembers} membros atingido para este projeto.`,
           403,
           "PLAN_LIMIT",
         );
       }
       if (existing) {
         if (isProjectOwnerMember(req.project, existing) || String(existing.role_id || existing.role || "").toLowerCase() === SYSTEM_ROLE_IDS.OWNER) {
           throw invalidRequest("O owner não pode ser alterado", "OWNER_MEMBER_IMMUTABLE");
         }
         await members.updateOne(
           { _id: existing._id },
           {
             $set: {
               project_id: req.projectId,
               user_key: userKey,
               user_id: userKey,
               role_id: role.id,
               status: "active",
               email,
               updated_at: now,
             },
           },
           { session },
         );
         return members.findOne({ _id: existing._id }, { session });
       }
       const memberId = uuid();
       const document = {
         _id: memberId,
         id: memberId,
         project_id: req.projectId,
         user_key: userKey,
         user_id: userKey,
         role_id: role.id,
         status: "active",
         email,
         created_at: now,
         updated_at: now,
       };
       await members.insertOne(document, { session });
       return document;
      });
      } catch (error) {
        if (createdAccountId) {
          try {
            const members = await col("project_members");
            const hasMembership = await members.findOne({
              $or: [{ user_id: createdAccountId }, { user_key: userKey }],
            });
            if (!hasMembership) await users.deleteOne({ _id: createdAccountId, email });
          } catch {
            // best-effort cleanup; the original error is more useful to the caller
          }
        }
        if (error?.code === 11000) {
          throw invalidRequest("Este usuário já é membro do projeto", "DUPLICATE_MEMBER");
        }
        throw error;
      }

     res.status(201).json(await memberResponse(req, member));
  })
);

router.get(
  "/:projectId/members",
  projectMiddleware,
  requireProjectPermission(PERMISSIONS.MEMBERS_READ),
  authzRoute(async (req, res) => {
    const rows = await getProjectMembers(req.project);
    const response = [];
    for (const row of rows) response.push(await memberResponse(req, row));
    res.json(response);
  })
);

router.patch(
  "/:projectId/members/:memberId",
  projectMiddleware,
  requireProjectOwner,
  requireProjectPermission(PERMISSIONS.MEMBERS_MANAGE),
  authzRoute(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || !Object.hasOwn(body, "role_id") || typeof body.role_id !== "string") {
      throw invalidRequest("Informe role_id", "INVALID_MEMBER_ROLE");
    }
    const role = await getRoleForProject(req.project, body.role_id);
    if (!role) throw invalidRequest("Role inválida", "INVALID_MEMBER_ROLE");
    if (role.id === SYSTEM_ROLE_IDS.OWNER) {
      throw invalidRequest("O owner não pode ser alterado", "OWNER_MEMBER_IMMUTABLE");
    }
    const member = await findMember(req, req.params.memberId);
    if (!member) throw new AuthzError("Membro não encontrado", 404, "MEMBER_NOT_FOUND");
    if (isProjectOwnerMember(req.project, member)) {
      throw invalidRequest("O owner não pode ser alterado", "OWNER_MEMBER_IMMUTABLE");
    }
     if (!Array.isArray(role.permissions) || !role.permissions.includes(PERMISSIONS.WEATHER_READ)) {
       await revokePushAccess(req.projectId, member);
     }
     const updated = await (await col("project_members")).findOneAndUpdate(
       { _id: member._id, project_id: { $in: projectValues(req) } },
      { $set: { role_id: role.id, updated_at: new Date().toISOString() } },
      { returnDocument: "after" }
    );
     const fresh = updated || await (await col("project_members")).findOne({ _id: member._id, project_id: { $in: projectValues(req) } });
    res.json(await memberResponse(req, fresh));
  })
);

router.delete(
  "/:projectId/members/:memberId",
  projectMiddleware,
  requireProjectPermission(PERMISSIONS.MEMBERS_MANAGE),
  authzRoute(async (req, res) => {
    const member = await findMember(req, req.params.memberId);
    if (!member) throw new AuthzError("Membro não encontrado", 404, "MEMBER_NOT_FOUND");
    if (isProjectOwnerMember(req.project, member)) {
      throw invalidRequest("O owner não pode ser removido", "OWNER_MEMBER_IMMUTABLE");
    }
     await revokePushAccess(req.projectId, member);
     await revokeLegacyMembership(req.project, req.projectId, member);
      const result = await (await col("project_members")).deleteOne({ _id: member._id, project_id: { $in: projectValues(req) } });
    if (result.deletedCount === 0) throw new AuthzError("Membro não encontrado", 404, "MEMBER_NOT_FOUND");
    res.status(204).end();
  })
);

router.get(
  "/:projectId",
  projectMiddleware,
  requireProjectPermission(PERMISSIONS.PROJECT_READ),
  authzRoute(async (req, res) => {
    res.json(await publicProjectSummary(req.project, req.projectAccess));
  })
);

export default router;
