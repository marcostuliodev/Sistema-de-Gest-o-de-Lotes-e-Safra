import { ObjectId } from "mongodb";
import { v4 as uuid, validate as validateUuid } from "uuid";
import { col } from "./db.js";
import { escapeRegExp, sanitizeText } from "./validation.js";

export class AuthzError extends Error {
  constructor(message, status = 403, code = "FORBIDDEN") {
    super(message);
    this.name = "AuthzError";
    this.status = status;
    this.code = code;
  }
}

export const PERMISSIONS = Object.freeze({
  PROJECT_READ: "project.read",
  PROJECT_UPDATE: "project.update",
  MEMBERS_READ: "members.read",
  MEMBERS_MANAGE: "members.manage",
  ROLES_READ: "roles.read",
  ROLES_MANAGE: "roles.manage",
  ENTITIES_READ: "entities.read",
  ENTITIES_CREATE: "entities.create",
  ENTITIES_UPDATE: "entities.update",
  ENTITIES_DELETE: "entities.delete",
  ENTITIES_DELETE_CASCADE: "entities.delete_cascade",
  REPORTS_READ: "reports.read",
  PHOTOS_READ: "photos.read",
  PHOTOS_WRITE: "photos.write",
  AI_USE: "ai.use",
  WEATHER_READ: "weather.read",
});

export const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
const PERMISSION_SET = new Set(ALL_PERMISSIONS);

const PERMISSION_ALIASES = Object.freeze({
  "project:read": PERMISSIONS.PROJECT_READ,
  "projects:read": PERMISSIONS.PROJECT_READ,
  "projects.read": PERMISSIONS.PROJECT_READ,
  "project:update": PERMISSIONS.PROJECT_UPDATE,
  "projects:update": PERMISSIONS.PROJECT_UPDATE,
  "projects.update": PERMISSIONS.PROJECT_UPDATE,
  "members:read": PERMISSIONS.MEMBERS_READ,
  "member.read": PERMISSIONS.MEMBERS_READ,
  "members:manage": PERMISSIONS.MEMBERS_MANAGE,
  "member.manage": PERMISSIONS.MEMBERS_MANAGE,
  "roles:read": PERMISSIONS.ROLES_READ,
  "role.read": PERMISSIONS.ROLES_READ,
  "roles:manage": PERMISSIONS.ROLES_MANAGE,
  "role.manage": PERMISSIONS.ROLES_MANAGE,
  "entities:read": PERMISSIONS.ENTITIES_READ,
  "entity:read": PERMISSIONS.ENTITIES_READ,
  "entities:create": PERMISSIONS.ENTITIES_CREATE,
  "entity:create": PERMISSIONS.ENTITIES_CREATE,
  "entities:update": PERMISSIONS.ENTITIES_UPDATE,
  "entity:update": PERMISSIONS.ENTITIES_UPDATE,
  "entities:delete": PERMISSIONS.ENTITIES_DELETE,
  "entity:delete": PERMISSIONS.ENTITIES_DELETE,
  "entities:delete_cascade": PERMISSIONS.ENTITIES_DELETE_CASCADE,
  "entities.delete_cascade": PERMISSIONS.ENTITIES_DELETE_CASCADE,
  "entity.delete_cascade": PERMISSIONS.ENTITIES_DELETE_CASCADE,
  "reports:read": PERMISSIONS.REPORTS_READ,
  "report:read": PERMISSIONS.REPORTS_READ,
  "photos:read": PERMISSIONS.PHOTOS_READ,
  "photo:read": PERMISSIONS.PHOTOS_READ,
  "photos:write": PERMISSIONS.PHOTOS_WRITE,
  "photo:write": PERMISSIONS.PHOTOS_WRITE,
  "ai:use": PERMISSIONS.AI_USE,
  "ai.chat": PERMISSIONS.AI_USE,
  "weather:read": PERMISSIONS.WEATHER_READ,
  "climate:read": PERMISSIONS.WEATHER_READ,
  "clima:read": PERMISSIONS.WEATHER_READ,
});

export const PERMISSION_CATALOG = Object.freeze(
  Object.fromEntries(
    ALL_PERMISSIONS.map((permission) => [
      permission,
      Object.freeze({ key: permission, label: permission }),
    ])
  )
);

export const SYSTEM_ROLE_IDS = Object.freeze({
  OWNER: "owner",
  EDITOR: "editor",
  VIEWER: "viewer",
});

const SYSTEM_ROLE_DEFINITIONS = {
  owner: {
    id: SYSTEM_ROLE_IDS.OWNER,
    name: SYSTEM_ROLE_IDS.OWNER,
    label: "Proprietário",
    system: true,
    permissions: ALL_PERMISSIONS,
  },
  editor: {
    id: SYSTEM_ROLE_IDS.EDITOR,
    name: SYSTEM_ROLE_IDS.EDITOR,
    label: "Editor",
    system: true,
    permissions: [
      PERMISSIONS.PROJECT_READ,
      PERMISSIONS.MEMBERS_READ,
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.ENTITIES_READ,
      PERMISSIONS.ENTITIES_CREATE,
       PERMISSIONS.ENTITIES_UPDATE,
       PERMISSIONS.ENTITIES_DELETE,
       PERMISSIONS.ENTITIES_DELETE_CASCADE,
       PERMISSIONS.REPORTS_READ,
       PERMISSIONS.PHOTOS_READ,
       PERMISSIONS.PHOTOS_WRITE,
       PERMISSIONS.AI_USE,
      PERMISSIONS.WEATHER_READ,
    ],
  },
  viewer: {
    id: SYSTEM_ROLE_IDS.VIEWER,
    name: SYSTEM_ROLE_IDS.VIEWER,
    label: "Visualizador",
    system: true,
    permissions: [
      PERMISSIONS.PROJECT_READ,
      PERMISSIONS.MEMBERS_READ,
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.ENTITIES_READ,
      PERMISSIONS.REPORTS_READ,
      PERMISSIONS.PHOTOS_READ,
      PERMISSIONS.WEATHER_READ,
    ],
  },
};

export const SYSTEM_ROLES = Object.freeze(
  Object.fromEntries(
    Object.entries(SYSTEM_ROLE_DEFINITIONS).map(([key, role]) => [
      key,
      Object.freeze({
        ...role,
        permissions: Object.freeze([...role.permissions]),
      }),
    ])
  )
);

export const DEFAULT_PROJECT_NAME = "Meu projeto";

export function idToString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    if (typeof value.toString === "function") {
      const result = value.toString();
      if (result !== "[object Object]") return result;
    }
  }
  return "";
}

export function normalizeId(value) {
  const result = idToString(value);
  if (!result || result.length > 120 || /[\u0000-\u001f]/.test(result)) return "";
  return validateUuid(result) ? result.toLowerCase() : result;
}

export function isUuid(value) {
  return validateUuid(idToString(value));
}

function isSupportedProjectId(value) {
  const text = normalizeId(value);
  return isUuid(text) || /^[a-f\d]{24}$/i.test(text) || /^\d{1,20}$/.test(text);
}

export function cleanText(value, maxLength = 120) {
  if (typeof value !== "string") return "";
  return sanitizeText(value.trim().replace(/\s+/g, " ").slice(0, maxLength));
}

export function normalizePermission(permission) {
  if (typeof permission !== "string") return null;
  const raw = permission.trim().toLowerCase();
  if (PERMISSION_SET.has(raw)) return raw;
  return PERMISSION_ALIASES[raw] || null;
}

export function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) return [];
  const out = [];
  const seen = new Set();
  for (const permission of permissions) {
    const normalized = normalizePermission(permission);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function validatePermissions(permissions) {
  if (!Array.isArray(permissions)) return null;
  const out = [];
  const seen = new Set();
  for (const permission of permissions) {
    const normalized = normalizePermission(permission);
    if (!normalized || seen.has(normalized)) return null;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function getSystemRole(roleId) {
  const key = idToString(roleId).trim().toLowerCase();
  const role = SYSTEM_ROLES[key];
  if (!role) return null;
  return { ...role, permissions: [...role.permissions] };
}

export function hasPermission(access, permission) {
  const normalized = normalizePermission(permission);
  if (!normalized) return false;
  if (!access || typeof access !== "object") return false;
  if (access.isOwner === true) return true;
  return normalizePermissions(access.permissions).includes(normalized);
}

export const can = hasPermission;

export function createUserKey() {
  return uuid();
}

function addReference(value, out, seen) {
  if (value === undefined || value === null) return;
  const id = idToString(value);
  if (!id) return;
  const values = [value];
  if (typeof value !== "string") values.push(id);
  if (value instanceof ObjectId || /^[a-f\d]{24}$/i.test(id)) {
    if (ObjectId.isValid(id)) values.push(new ObjectId(id));
  }
  if (/^\d{1,20}$/.test(id)) values.push(Number(id));
  for (const item of values) {
    const itemId = idToString(item);
    if (!itemId) continue;
    const key = `${typeof item}:${itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
}

function userReferenceValues(input) {
  const source = input?.user && typeof input.user === "object" ? input.user : input || {};
  const values = [];
  const seen = new Set();
  addReference(source.user_key, values, seen);
  addReference(source.userKey, values, seen);
  addReference(source._id, values, seen);
  addReference(source.id, values, seen);
  addReference(source.uid, values, seen);
  addReference(source.userId, values, seen);
  addReference(input?.uid, values, seen);
  addReference(input?.user_key, values, seen);
  return values;
}

function userEmail(input) {
  const source = input?.user && typeof input.user === "object" ? input.user : input || {};
  return idToString(source.email || input?.email).trim().toLowerCase();
}

function userIdentityValues(user, userKey = null) {
  const values = [];
  const seen = new Set();
  addReference(userKey, values, seen);
  addReference(user?.user_key, values, seen);
  addReference(user?.userKey, values, seen);
  addReference(user?._id, values, seen);
  addReference(user?.id, values, seen);
  addReference(user?.uid, values, seen);
  addReference(user?.userId, values, seen);
  return values;
}

export async function ensureUserKey(user, usersCollection = null) {
  if (!user || typeof user !== "object") return null;
  const existing = idToString(user.user_key);
  if (existing) return existing;

  const users = usersCollection || (await col("users"));
  const generated = createUserKey();
  const baseFilter = user._id !== undefined && user._id !== null
    ? { _id: user._id }
    : user.id !== undefined && user.id !== null
      ? { id: user.id }
      : null;
  if (!baseFilter) return generated;

  const result = await users.updateOne(
    {
      ...baseFilter,
      $or: [{ user_key: { $exists: false } }, { user_key: null }, { user_key: "" }],
    },
    { $set: { user_key: generated } }
  );
  if (result?.matchedCount !== 0) {
    user.user_key = generated;
    return generated;
  }

  const fresh = await users.findOne(baseFilter);
  const resolved = idToString(fresh?.user_key);
  if (resolved) {
    user.user_key = fresh.user_key;
    return resolved;
  }
  user.user_key = generated;
  return generated;
}

export const ensureUserKeyForUser = ensureUserKey;

export async function resolveUser(input) {
  const users = await col("users");
  const references = userReferenceValues(input);
  const email = userEmail(input);
  const or = [];
  for (const reference of references) {
    or.push({ user_key: reference }, { _id: reference }, { id: reference });
  }
  if (email) {
    or.push({ email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, "i") } });
  }
  if (or.length === 0) {
    throw new AuthzError("Usuário não autenticado", 401, "UNAUTHENTICATED");
  }

  const user = await users.findOne({ $or: or });
  if (!user) {
    throw new AuthzError("Conta não encontrada", 401, "USER_NOT_FOUND");
  }
  const userKey = await ensureUserKey(user, users);
  return { ...user, user_key: userKey };
}

export const resolveUserById = resolveUser;

function projectIdValues(value) {
  const values = [];
  const seen = new Set();
  addReference(value, values, seen);
  if (value && typeof value === "object") {
    addReference(value.id, values, seen);
    addReference(value._id, values, seen);
  }
  return values;
}

function projectIdFromDocument(project) {
  return normalizeId(project?.id || project?._id);
}

function projectQueryValues(project) {
  const values = [];
  const seen = new Set();
  addReference(project?.id, values, seen);
  addReference(project?._id, values, seen);
  addReference(projectIdFromDocument(project), values, seen);
  return values;
}

export async function resolveProject(projectOrId) {
  if (projectOrId && typeof projectOrId === "object") return projectOrId;
  const values = projectIdValues(projectOrId);
  if (values.length === 0) return null;
  const projects = await col("projects");
  const or = [];
  for (const value of values) or.push({ _id: value }, { id: value });
  return projects.findOne({ $or: or });
}

export const getProject = resolveProject;

function projectOwnerMatches(project, user, userKey) {
  const ownerValues = [];
  const seen = new Set();
  addReference(project?.owner_id, ownerValues, seen);
  addReference(project?.owner_key, ownerValues, seen);
  addReference(project?.created_by, ownerValues, seen);
  if (ownerValues.length === 0) return false;
  const candidateValues = userIdentityValues(user, userKey);
  const email = userEmail(user);
  if (email && ownerValues.some((value) => idToString(value).toLowerCase() === email)) {
    return true;
  }
  const ownerStrings = ownerValues.map(idToString).filter(Boolean);
  return candidateValues.some((candidate) => ownerStrings.includes(idToString(candidate)));
}

function projectMemberFilter(project, user, userKey) {
  const projectValues = projectQueryValues(project);
  const userValues = userIdentityValues(user, userKey);
  if (projectValues.length === 0 || userValues.length === 0) return null;
  const projectOr = projectValues.map((value) => ({ project_id: value }));
  const userOr = [];
  for (const value of userValues) {
    userOr.push({ user_key: value }, { user_id: value });
  }
  const email = userEmail(user);
  if (email) {
    userOr.push({ email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, "i") } });
  }
  return {
    $and: [
      { $or: projectOr },
      { $or: userOr },
      { $or: [{ status: { $exists: false } }, { status: null }, { status: "active" }] },
    ],
  };
}

function systemRoleDocument(projectId, role) {
  const normalizedProjectId = normalizeId(projectId);
  return {
    _id: `${normalizedProjectId}:${role.id}`,
    id: role.id,
    project_id: normalizedProjectId,
    name: role.name,
    label: role.label,
    permissions: [...role.permissions],
    system: true,
    is_system: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function ensureSystemRoles(projectOrId) {
  const project = typeof projectOrId === "object" ? projectOrId : await resolveProject(projectOrId);
  if (!project) return [];
  const projectId = projectIdFromDocument(project);
  if (!projectId) return [];
  const roles = await col("roles");
  const projectValues = projectQueryValues(project);
  const result = [];
  for (const role of Object.values(SYSTEM_ROLES)) {
    const roleOr = [{ _id: `${projectId}:${role.id}` }, { id: role.id }, { role_id: role.id }];
    const filter = {
      $and: [{ $or: projectValues.map((value) => ({ project_id: value })) }, { $or: roleOr }],
    };
    const document = systemRoleDocument(projectId, role);
    await roles.updateOne(filter, { $setOnInsert: document }, { upsert: true });
    result.push(getSystemRole(role.id));
  }
  return result;
}

async function roleDefinitionForProject(project, roleId, rolesCollection = null) {
  const rawRoleId = idToString(roleId);
  if (!rawRoleId) return null;
  const system = getSystemRole(rawRoleId);
  if (system) return system;

  const roles = rolesCollection || (await col("roles"));
  const projectValues = projectQueryValues(project);
  const roleValues = projectIdValues(rawRoleId);
  const roleOr = [];
  for (const value of roleValues) roleOr.push({ _id: value }, { id: value }, { role_id: value });
  if (roleOr.length === 0 || projectValues.length === 0) return null;
  const role = await roles.findOne({
    $and: [
      { $or: projectValues.map((value) => ({ project_id: value })) },
      { $or: roleOr },
    ],
  });
  if (!role) return null;
  const isSystem = role.system === true || role.is_system === true;
  const id = normalizeId(role.id || role.role_id || role._id);
  return {
    id: id || rawRoleId,
    name: cleanText(role.name || role.role || id || rawRoleId, 120) || rawRoleId,
    label: cleanText(role.label || role.name || id || rawRoleId, 120) || rawRoleId,
    system: isSystem,
    permissions: isSystem ? [] : normalizePermissions(role.permissions),
  };
}

export async function getRoleForProject(project, roleId, rolesCollection = null) {
  return roleDefinitionForProject(project, roleId, rolesCollection);
}

export async function getPermissionsForRole(project, roleId, rolesCollection = null) {
  const role = await getRoleForProject(project, roleId, rolesCollection);
  return role ? [...role.permissions] : [];
}

async function resolveAccessForResolvedUser(project, user, userKey) {
   const members = await col("project_members");
   const filter = projectMemberFilter(project, user, userKey);
   const member = filter ? await members.findOne(filter) : null;
   const owner = projectOwnerMatches(project, user, userKey);
   if (!member && !owner) return null;
   const roleIdFromMember = idToString(member?.role_id || member?.role);
   const role = roleIdFromMember ? await roleDefinitionForProject(project, roleIdFromMember) : null;
   const roleIsOwner = roleIdFromMember.toLowerCase() === SYSTEM_ROLE_IDS.OWNER;
   const isOwner = owner || roleIsOwner;
  if (!isOwner && !role) {
    return {
      projectId: projectIdFromDocument(project),
      userKey,
      role: roleIdFromMember || "unknown",
      roleId: roleIdFromMember || null,
      permissions: [],
      isOwner: false,
    };
  }
  return {
    projectId: projectIdFromDocument(project),
    userKey,
    role: isOwner ? SYSTEM_ROLE_IDS.OWNER : role.name,
    roleId: isOwner ? SYSTEM_ROLE_IDS.OWNER : role.id,
    permissions: isOwner ? [...ALL_PERMISSIONS] : [...role.permissions],
    isOwner,
  };
}

export async function resolveProjectAccess(projectOrId, user) {
  const resolvedUser = await resolveUser(user);
  const project = await resolveProject(projectOrId);
  if (!project) return null;
  return resolveAccessForResolvedUser(project, resolvedUser, resolvedUser.user_key);
}

export const getProjectAccess = resolveProjectAccess;

export async function resolveProjectPermissions(projectOrId, user) {
  const access = await resolveProjectAccess(projectOrId, user);
  return access ? [...access.permissions] : [];
}

export function assertPermission(access, permission) {
  if (!hasPermission(access, permission)) {
    throw new AuthzError("Permissão insuficiente", 403, "PERMISSION_DENIED");
  }
  return true;
}

export function canAccessProject(access) {
  return !!access;
}

export function canManageProject(access) {
  return access?.isOwner === true || hasPermission(access, PERMISSIONS.PROJECT_UPDATE);
}

export function canManageMembers(access) {
  return access?.isOwner === true || hasPermission(access, PERMISSIONS.MEMBERS_MANAGE);
}

export function canManageRoles(access) {
  return access?.isOwner === true || hasPermission(access, PERMISSIONS.ROLES_MANAGE);
}

function ownerProjectFilter(user, userKey) {
  const values = userIdentityValues(user, userKey);
  if (values.length === 0) return null;
  const or = [];
  for (const value of values) {
    or.push({ owner_id: value }, { owner_key: value }, { created_by: value });
  }
  return { $or: or };
}

async function insertOwnerMembership(project, userKey) {
  const members = await col("project_members");
  const projectValues = projectQueryValues(project);
  const rawOwner = project.owner_id || project.owner_key || project.created_by;
  const legacyOwner = normalizeId(rawOwner);
  const userOr = [{ user_key: userKey }, { user_id: userKey }];
  if (rawOwner !== undefined && rawOwner !== null) userOr.push({ user_id: rawOwner });
  if (legacyOwner && legacyOwner !== idToString(rawOwner)) userOr.push({ user_id: legacyOwner });
  const existing = await members.findOne({ $and: [{ $or: projectValues.map((value) => ({ project_id: value })) }, { $or: userOr }] });
  if (existing) {
    await members.updateOne(
      { _id: existing._id },
      { $set: { user_key: userKey, user_id: userKey, role_id: SYSTEM_ROLE_IDS.OWNER, status: "active", updated_at: new Date().toISOString() } }
    );
    return;
  }
  const memberId = uuid();
  await members.insertOne({
    _id: memberId,
    id: memberId,
    project_id: projectIdFromDocument(project),
    user_key: userKey,
    user_id: userKey,
    role_id: SYSTEM_ROLE_IDS.OWNER,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function migrateLegacyCollaborators(project, ownerKey) {
  const collaborators = await col("collaborators");
  const ownerValues = [];
  const seenOwners = new Set();
  for (const value of [project?.owner_id, project?.owner_key, project?.created_by, ownerKey]) {
    addReference(value, ownerValues, seenOwners);
  }
  if (ownerKey) {
    try {
      const owner = await resolveUser({ uid: ownerKey });
      for (const value of [owner?._id, owner?.id, owner?.user_key, owner?.email]) {
        addReference(value, ownerValues, seenOwners);
      }
    } catch {
      // owner ainda pode existir apenas com o ID legado
    }
  }
  if (ownerValues.length === 0) return;

  const rows = await collaborators.find({
    $and: [
      { $or: ownerValues.map((value) => ({ owner_id: value })) },
      { $or: [{ migrated_at: { $exists: false } }, { migrated_at: null }] },
    ],
  }).toArray();
  if (rows.length === 0) return;

  const members = await col("project_members");
  const projectValues = projectQueryValues(project);
  for (const row of rows) {
     const existingProjectId = idToString(row.project_id);
     if (existingProjectId && existingProjectId !== projectIdFromDocument(project)) continue;
     // Convites legados sem project_id só podem ser claimados pelo projeto
     // default; replicá-los em todo projeto do owner violaria o isolamento.
     if (!existingProjectId && project.is_default !== true) continue;

    let memberUserKey = idToString(row.user_key);
    if (!memberUserKey && row.user_id !== undefined && row.user_id !== null) {
      try {
        const resolved = await resolveUser({ uid: row.user_id, email: row.email });
        memberUserKey = idToString(resolved.user_key);
      } catch {
        memberUserKey = idToString(row.user_id);
      }
    }
    if (!memberUserKey && row.email) {
      try {
        const resolved = await resolveUser({ email: row.email });
        memberUserKey = idToString(resolved.user_key);
      } catch {
        memberUserKey = "";
      }
    }
    if (!memberUserKey) continue;

    const roleId = row.role === "admin" ? SYSTEM_ROLE_IDS.EDITOR : SYSTEM_ROLE_IDS.VIEWER;
    const userOr = [{ user_key: memberUserKey }, { user_id: memberUserKey }];
    if (row.email) userOr.push({ email: row.email });
    const filter = {
      $and: [
        { $or: projectValues.map((value) => ({ project_id: value })) },
        { $or: userOr },
      ],
    };
    const existing = await members.findOne(filter);
    const memberDocument = {
      project_id: projectIdFromDocument(project),
      user_key: memberUserKey,
      user_id: memberUserKey,
      role_id: roleId,
      status: row.status === "active" ? "active" : row.status === "pending" ? "pending" : "revoked",
      email: cleanText(row.email, 254) || undefined,
      legacy_collaborator_id: idToString(row._id || row.id) || undefined,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      await members.updateOne({ _id: existing._id }, { $set: memberDocument });
    } else {
      await members.insertOne({
        _id: uuid(),
        id: uuid(),
        ...memberDocument,
        created_at: new Date().toISOString(),
      });
    }
    await collaborators.updateOne(
      { _id: row._id },
      { $set: { project_id: projectIdFromDocument(project), migrated_at: new Date().toISOString() } },
    );
  }
}

async function migrateLegacyProjectData(project, ownerKey) {
  const ownerValues = [];
  const seenOwners = new Set();
  for (const value of [project?.owner_id, project?.owner_key, project?.created_by, ownerKey]) {
    addReference(value, ownerValues, seenOwners);
  }
  if (ownerValues.length === 0) return;
  try {
    const owner = await resolveUser({ uid: ownerKey });
    for (const value of [owner?._id, owner?.id, owner?.user_key, owner?.email]) {
      addReference(value, ownerValues, seenOwners);
    }
  } catch {
    // mantém os aliases legados já coletados
  }

  const projectId = projectIdFromDocument(project);
  const ownerOr = [];
  for (const value of ownerValues) {
    ownerOr.push({ user_id: value }, { owner_id: value });
  }
  const noProject = {
    $or: [
      { project_id: { $exists: false } },
      { project_id: null },
      { project_id: "" },
    ],
  };
  for (const entity of ["lotes", "plantios", "insumos", "gastos", "colheitas", "photos_metadata"]) {
    const collection = await col(entity);
    await collection.updateMany(
      { $and: [noProject, { $or: ownerOr }] },
      { $set: { project_id: projectId, migrated_at: new Date().toISOString() } },
    );
  }
}

async function initializeProject(project) {
  const ownerKey = normalizeId(project.owner_id || project.owner_key || project.created_by);
  if (ownerKey) await insertOwnerMembership(project, ownerKey);
  await ensureSystemRoles(project);
  await migrateLegacyCollaborators(project, ownerKey);
  // Registros sem project_id são legado do modelo single-project. Só o
  // projeto default pode reivindicar esses registros; um projeto novo não
  // pode capturar dados de outro escopo durante a inicialização.
  if (project.is_default === true) await migrateLegacyProjectData(project, ownerKey);
}

export async function createProjectForUser(user, nameInput) {
  const resolvedUser = await resolveUser(user);
  const name = cleanText(nameInput, 120);
  if (!name) throw new AuthzError("Nome do projeto é obrigatório", 400, "INVALID_PROJECT_NAME");
  const userKey = resolvedUser.user_key;
  const projects = await col("projects");
  const ownerFilter = ownerProjectFilter(resolvedUser, userKey);
  const maxProjects = Number.parseInt(process.env.MAX_PROJECTS_PER_OWNER || "20", 10);
  const existingProjectCount = ownerFilter ? await projects.countDocuments(ownerFilter) : 0;
  if (Number.isSafeInteger(maxProjects) && maxProjects > 0 && existingProjectCount >= maxProjects) {
    throw new AuthzError(`Limite de ${maxProjects} projetos atingido`, 403, "PROJECT_LIMIT");
  }
  const existingDefault = ownerFilter ? await projects.findOne({ ...ownerFilter, is_default: true }) : null;
  const projectId = uuid();
  const now = new Date().toISOString();
  const project = {
    _id: projectId,
    id: projectId,
    name,
    nome: name,
    owner_id: userKey,
    owner_key: userKey,
    created_by: userKey,
    is_default: !existingDefault,
    created_at: now,
    updated_at: now,
  };
  try {
    await projects.insertOne(project);
  } catch (error) {
    // Em logins simultâneos, o índice único do projeto default pode falhar
    // para uma das requisições. Reaproveita o projeto já criado em vez de
    // duplicar o escopo.
    if (error?.code !== 11000 || !project.is_default) throw error;
    const existingDefault = await projects.findOne({ ...ownerFilter, is_default: true });
    if (!existingDefault) throw error;
    await initializeProject(existingDefault);
    return { project: existingDefault, user: resolvedUser };
  }
  await initializeProject(project);
  return { project, user: resolvedUser };
}

export async function ensureDefaultProject(user) {
  const resolvedUser = await resolveUser(user);
  const userKey = resolvedUser.user_key;
  const projects = await col("projects");
  const ownerFilter = ownerProjectFilter(resolvedUser, userKey);
  if (!ownerFilter) throw new AuthzError("Usuário inválido", 401, "INVALID_USER");
  const explicit = await projects.findOne({ ...ownerFilter, is_default: true });
  if (explicit) {
    await initializeProject(explicit);
    return explicit;
  }
  const existing = await projects.findOne(ownerFilter, { sort: { created_at: 1, _id: 1 } });
  if (existing) {
    await projects.updateOne({ _id: existing._id }, { $set: { is_default: true, updated_at: new Date().toISOString() } });
    const refreshed = await projects.findOne({ _id: existing._id });
    await initializeProject(refreshed || existing);
    return refreshed || existing;
  }
  const created = await createProjectForUser(resolvedUser, DEFAULT_PROJECT_NAME);
  return created.project;
}

async function listAccessibleProjectsForResolvedUser(resolvedUser) {
  const userKey = resolvedUser.user_key;
  const members = await col("project_members");
  const userValues = userIdentityValues(resolvedUser, userKey);
  const userOr = [];
  for (const value of userValues) userOr.push({ user_key: value }, { user_id: value });
  const email = userEmail(resolvedUser);
  if (email) userOr.push({ email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, "i") } });
  const membershipRows = userOr.length ? await members.find({ $or: userOr }).toArray() : [];
  const projectValues = [];
  const seenProjectValues = new Set();
  for (const row of membershipRows) {
    for (const value of projectIdValues(row.project_id)) {
      const key = idToString(value);
      if (!key || seenProjectValues.has(key)) continue;
      seenProjectValues.add(key);
      projectValues.push(value);
    }
  }
  const projects = await col("projects");
  const ownerFilter = ownerProjectFilter(resolvedUser, userKey);
  if (ownerFilter) {
    const owned = await projects.find(ownerFilter).toArray();
    for (const project of owned) {
      for (const value of projectQueryValues(project)) {
        const key = idToString(value);
        if (!key || seenProjectValues.has(key)) continue;
        seenProjectValues.add(key);
        projectValues.push(value);
      }
    }
  }
  if (projectValues.length === 0) return [];
  const projectOr = [];
  for (const value of projectValues) projectOr.push({ _id: value }, { id: value });
  const projectDocs = await projects.find({ $or: projectOr }).toArray();
  const result = [];
  const seenProjects = new Set();
  for (const project of projectDocs) {
    const projectId = projectIdFromDocument(project);
    if (!projectId || seenProjects.has(projectId)) continue;
    const access = await resolveAccessForResolvedUser(project, resolvedUser, userKey);
    if (!access) continue;
    seenProjects.add(projectId);
    result.push({ project, access });
  }
  return result.sort((left, right) => {
    const leftDate = idToString(left.project.created_at);
    const rightDate = idToString(right.project.created_at);
    return leftDate.localeCompare(rightDate) || projectIdFromDocument(left.project).localeCompare(projectIdFromDocument(right.project));
  });
}

export async function listAccessibleProjects(user) {
  const resolvedUser = await resolveUser(user);
  return listAccessibleProjectsForResolvedUser(resolvedUser);
}

export async function getProjectRoles(project) {
  const system = await ensureSystemRoles(project);
  const roles = await col("roles");
  const projectValues = projectQueryValues(project);
  const custom = await roles.find({
    $and: [
      { $or: projectValues.map((value) => ({ project_id: value })) },
      { $and: [{ $or: [{ system: { $exists: false } }, { system: false }] }, { $or: [{ is_system: { $exists: false } }, { is_system: false }] }] },
    ],
  }).toArray();
  const customRoles = custom
    .map((role) => ({
      id: normalizeId(role.id || role.role_id || role._id),
      name: cleanText(role.name || role.role || role.id || role._id, 120),
      label: cleanText(role.label || role.name || role.id || role._id, 120),
      system: false,
      permissions: normalizePermissions(role.permissions),
      created_at: role.created_at,
      updated_at: role.updated_at,
    }))
    .filter((role) => role.id && role.name);
  const systemRoles = system.map((role) => ({ ...role, permissions: [...role.permissions] }));
  return [...systemRoles, ...customRoles];
}

export async function getProjectMembers(project) {
  const members = await col("project_members");
  const projectValues = projectQueryValues(project);
  return members.find({
    $or: projectValues.map((value) => ({ project_id: value })),
  }).sort({ created_at: 1 }).toArray();
}

function safePublicUser(user, fallbackKey = "") {
  if (!user) return { id: fallbackKey, key: fallbackKey, name: "", email: "" };
  const id = idToString(user.id || user._id || user.user_key || fallbackKey);
  const key = idToString(user.user_key || fallbackKey);
  return {
    id,
    key,
    name: cleanText(user.name, 120),
    email: cleanText(user.email, 254),
  };
}

export async function publicProjectSummary(project, access) {
  const id = projectIdFromDocument(project);
  const name = cleanText(project.name || project.nome || id, 120);
  return {
    id,
    name,
    nome: name,
    role: access?.role || null,
    role_id: access?.roleId || null,
    permissions: [...(access?.permissions || [])],
    isOwner: access?.isOwner === true,
    is_default: project.is_default === true,
  };
}

export async function publicProjectMember(member, usersCollection = null) {
  const users = usersCollection || (await col("users"));
  const references = [];
  const seen = new Set();
  addReference(member?.user_key, references, seen);
  addReference(member?.user_id, references, seen);
  const or = [];
  for (const reference of references) or.push({ user_key: reference }, { _id: reference }, { id: reference });
  const email = idToString(member?.email).trim().toLowerCase();
  if (email) or.push({ email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, "i") } });
  const user = or.length > 0 ? await users.findOne({ $or: or }) : null;
  const userKey = idToString(member?.user_key || member?.user_id) || idToString(user?.user_key) || idToString(user?.id || user?._id);
  const publicUser = safePublicUser(user, userKey);
  return {
    id: idToString(member?.id || member?._id),
    project_id: normalizeId(member?.project_id),
    user_id: userKey,
    user_key: idToString(member?.user_key || userKey),
    name: publicUser.name,
    email: publicUser.email,
    role_id: idToString(member?.role_id || member?.role),
    status: member?.status === "active" || member?.status === undefined || member?.status === null ? "active" : cleanText(member.status, 20),
    created_at: member?.created_at,
    updated_at: member?.updated_at,
  };
}

export async function publicProjectRole(role) {
  return {
    id: normalizeId(role.id || role._id),
    name: cleanText(role.name || role.role || role.id, 120),
    label: cleanText(role.label || role.name || role.id, 120),
    system: role.system === true || role.is_system === true,
    permissions: normalizePermissions(role.permissions),
    created_at: role.created_at,
    updated_at: role.updated_at,
  };
}

function authzResponseError(res, error) {
  if (!(error instanceof AuthzError)) return false;
  if (res.headersSent) return true;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

function attachProject(req, resolvedUser, project, access) {
  req.authUser = resolvedUser;
  req.userKey = resolvedUser.user_key;
  req.project = project;
  req.projectId = access.projectId;
  req.projectAccess = {
    projectId: access.projectId,
    userKey: access.userKey,
    role: access.role,
    roleId: access.roleId,
    permissions: [...access.permissions],
    isOwner: access.isOwner === true,
  };
  req.projectPermissions = [...access.permissions];
}

export function projectMiddleware(req, res, next) {
  Promise.resolve().then(async () => {
    if (!req.user) throw new AuthzError("Usuário não autenticado", 401, "UNAUTHENTICATED");
    const resolvedUser = await resolveUser(req.user);
     const headerId = idToString(req.get?.("X-Project-Id") || req.headers?.["x-project-id"]);
     const queryId = idToString(req.query?.project_id || req.query?.projectId);
     const pathId = idToString(req.params?.projectId);
     const suppliedIds = [headerId, queryId, pathId].filter(Boolean);
     if (suppliedIds.some((value) => normalizeId(value) !== normalizeId(suppliedIds[0]))) {
       throw new AuthzError("Identificadores de projeto não correspondem", 400, "PROJECT_SELECTION_MISMATCH");
     }
     const selectedId = pathId || headerId || queryId;
    if (selectedId) {
       if (!isSupportedProjectId(selectedId)) {
        throw new AuthzError("ID de projeto inválido", 400, "INVALID_PROJECT_ID");
      }
      const project = await resolveProject(selectedId);
      if (!project) throw new AuthzError("Projeto não encontrado", 404, "PROJECT_NOT_FOUND");
      const access = await resolveAccessForResolvedUser(project, resolvedUser, resolvedUser.user_key);
      if (!access) throw new AuthzError("Acesso negado ao projeto", 403, "PROJECT_ACCESS_DENIED");
      attachProject(req, resolvedUser, project, access);
      next();
      return;
    }
    const accessible = await listAccessibleProjectsForResolvedUser(resolvedUser);
    if (accessible.length === 0) {
      throw new AuthzError("Nenhum projeto acessível", 404, "PROJECT_NOT_FOUND");
    }
    if (accessible.length !== 1) {
      throw new AuthzError("Informe X-Project-Id", 400, "PROJECT_SELECTION_REQUIRED");
    }
    attachProject(req, resolvedUser, accessible[0].project, accessible[0].access);
    next();
  }).catch((error) => {
    if (!authzResponseError(res, error)) next(error);
  });
}

export function requireProjectPermission(permission) {
  return (req, res, next) => {
    if (!req.projectAccess) {
      return next(new AuthzError("Projeto não selecionado", 400, "PROJECT_NOT_SELECTED"));
    }
    if (!hasPermission(req.projectAccess, permission)) {
      return res.status(403).json({ error: "Permissão insuficiente", code: "PERMISSION_DENIED" });
    }
    next();
  };
}

export const requirePermission = requireProjectPermission;

export function requireProjectOwner(req, res, next) {
  if (!req.projectAccess || req.projectAccess.isOwner !== true) {
    return res.status(403).json({ error: "Apenas o owner pode executar esta ação", code: "OWNER_REQUIRED" });
  }
  next();
}

