import { ObjectId } from "mongodb";
import { col } from "./db.js";
import { idToString, normalizeId, resolveUser } from "./authz.js";

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function addReference(value, values, seen) {
  if (value === undefined || value === null || value === "") return;
  const id = idToString(value);
  if (!id || id.length > 120 || /[\u0000-\u001f]/.test(id)) return;
  const candidates = [value];
  if (typeof value !== "string") candidates.push(id);
  const normalized = normalizeId(id);
  if (normalized && normalized !== id) candidates.push(normalized);
  if (ObjectId.isValid(id) && !candidates.some((item) => item instanceof ObjectId)) {
    candidates.push(new ObjectId(id));
  }
  for (const candidate of candidates) {
    const candidateId = idToString(candidate);
    if (!candidateId) continue;
    const key = `${typeof candidate}:${candidateId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(candidate);
  }
}

function addUserField(user, field, values, seen) {
  if (!user) return;
  addReference(user[field], values, seen);
}

function projectIdForRequest(req) {
  const project = req?.project || {};
  const explicit = normalizeId(req?.projectId) || idToString(req?.projectId);
  const fromProject = normalizeId(project.id || project._id) || idToString(project.id || project._id);
  return explicit || fromProject;
}

export function projectReferenceValues(project, projectId = "") {
  const values = [];
  const seen = new Set();
  addReference(project?.id, values, seen);
  addReference(project?._id, values, seen);
  addReference(project?.project_id, values, seen);
  addReference(projectId, values, seen);
  addReference(normalizeId(project?.id || project?._id), values, seen);
  return values;
}

export function documentIdReferenceValues(value) {
  const values = [];
  const seen = new Set();
  addReference(value, values, seen);
  return values;
}

function ownerSeeds(project) {
  const seeds = [];
  const seen = new Set();
  for (const value of [project?.owner_id, project?.owner_key, project?.created_by]) {
    addReference(value, seeds, seen);
  }
  return seeds;
}

function ownerUserValues(project, user) {
  const values = [];
  const seen = new Set();
  for (const value of ownerSeeds(project)) addReference(value, values, seen);
  for (const field of ["_id", "id", "uid", "userId", "user_key"]) addUserField(user, field, values, seen);
  if (user?.email) addReference(user.email, values, seen);
  return values;
}

async function resolveOwner(project) {
  const seeds = ownerSeeds(project);
  if (seeds.length === 0) {
    throw new Error("Projeto sem owner");
  }

  const seed = seeds[0];
  const input = { _id: seed, id: seed, uid: seed, user_key: seed };
  const seedText = idToString(seed);
  if (seedText.includes("@")) input.email = seedText;

  let user = null;
  try {
    user = await resolveUser(input);
  } catch {
    user = null;
  }

  const values = ownerUserValues(project, user);
  if (values.length === 0) addReference(seed, values, new Set());
  const userId = seed ?? user?.user_key ?? user?.userId ?? user?.id ?? user?._id;
  return { project, user, userId, values, raw: seed };
}

export async function getProjectOwner(req) {
  if (!req || typeof req !== "object") throw new Error("Projeto não selecionado");
  if (req._projectOwner) return req._projectOwner;
  const owner = await resolveOwner(req.project || {});
  Object.defineProperty(req, "_projectOwner", { value: owner, configurable: true, enumerable: false, writable: true });
  return owner;
}

export function getActorKey(req) {
  return idToString(req?.projectAccess?.userKey || req?.userKey || req?.authUser?.user_key || req?.user?.uid);
}

export function getProjectId(req) {
  return projectIdForRequest(req);
}

function noProjectFilter() {
  return {
    $or: [
      { project_id: { $exists: false } },
      { project_id: null },
      { project_id: "" },
    ],
  };
}

function ownerLegacyFilter(owner) {
  const clauses = [];
  for (const value of owner.values) {
    clauses.push({ $or: [{ user_id: value }, { owner_id: value }] });
  }
  return { $and: [noProjectFilter(), { $or: clauses }] };
}

export async function buildProjectFilter(req, { legacy } = {}) {
  const project = req?.project || {};
  const projectId = getProjectId(req);
  const projectValues = projectReferenceValues(project, projectId);
  const projectClauses = projectValues.map((value) => ({ project_id: value }));
  const allowLegacy = legacy === undefined ? project?.is_default === true : legacy === true;
  if (!allowLegacy) return { $or: projectClauses };

  const owner = await getProjectOwner(req);
  return {
    $or: [
      { $or: projectClauses },
      ownerLegacyFilter(owner),
    ],
  };
}

export function combineFilters(...filters) {
  const valid = filters.filter(Boolean);
  if (valid.length === 0) return {};
  if (valid.length === 1) return valid[0];
  return { $and: valid };
}

export function documentIdFilter(id, fields = ["_id", "id"]) {
  const values = documentIdReferenceValues(id);
  const clauses = [];
  for (const value of values) {
    for (const field of fields) clauses.push({ [field]: value });
  }
  return clauses.length > 0 ? { $or: clauses } : { $or: [] };
}

export async function findProjectDocument(req, collection, id, options = {}) {
  const { session, scope, ...filterOptions } = options || {};
  const projectFilter = scope || await buildProjectFilter(req, filterOptions);
  return collection.findOne(combineFilters(projectFilter, documentIdFilter(id)), session ? { session } : undefined);
}

export async function findAnyDocument(collection, id, options = {}) {
  const idFilter = documentIdFilter(id);
  if (!idFilter.$or.length) return null;
  return collection.findOne(idFilter, options.session ? { session: options.session } : undefined);
}

export function projectDocumentFilter(req) {
  const project = req?.project || {};
  if (project._id !== undefined && project._id !== null) return { _id: project._id };
  const projectId = getProjectId(req);
  const values = projectReferenceValues(project, projectId);
  const clauses = [];
  for (const value of values) {
    clauses.push({ id: value });
  }
  return clauses.length > 0 ? { $or: clauses } : { $or: [] };
}

export async function findProjectOwnerUser(req) {
  const owner = await getProjectOwner(req);
  if (owner.user) return owner.user;
  const users = await col("users");
  const clauses = [];
  for (const value of owner.values) {
    clauses.push({ _id: value });
    clauses.push({ id: value });
    clauses.push({ user_key: value });
    clauses.push({ uid: value });
  }
  return clauses.length > 0 ? users.findOne({ $or: clauses }) : null;
}

export function isRecord(value) {
  return isObject(value);
}
