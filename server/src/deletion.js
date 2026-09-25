import { ObjectId } from "mongodb";
import { col, deleteGridFSFile, getGridFSBucket, withMongoTransaction } from "./db.js";
import { hasPermission, idToString, normalizeId, PERMISSIONS } from "./authz.js";
import {
  buildProjectFilter,
  combineFilters,
  documentIdReferenceValues,
  findProjectDocument,
  getProjectId,
} from "./projectScope.js";

export const CASCADE_DELETE_PERMISSION = "entities.delete_cascade";
const DELETE_ENTITIES = new Set(["lotes", "plantios", "insumos", "gastos", "colheitas"]);

async function deletionProjectFilter(req, options = {}) {
  return buildProjectFilter(req, options);
}

export class DeletionError extends Error {
  constructor(message, { status = 400, code = "DELETE_INVALID", dependents = null } = {}) {
    super(message);
    this.name = "DeletionError";
    this.status = status;
    this.code = code;
    this.dependents = dependents;
  }
}

export function parseCascade(value) {
  if (value === undefined || value === null || value === "") return false;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new DeletionError("cascade deve ser true ou false", { code: "INVALID_CASCADE" });
}

function permissionMatches(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === CASCADE_DELETE_PERMISSION
    || normalized === "entities:delete_cascade"
    || normalized === "entity.delete_cascade";
}

async function roleHasCascadePermission(req) {
  const access = req?.projectAccess;
  if (!access || access.isOwner === true) return false;
  if (Array.isArray(access.permissions) && access.permissions.some(permissionMatches)) return true;
  const roleId = idToString(access.roleId || access.role_id || access.role);
  if (!roleId) return false;

  try {
    const project = req.project || {};
    const projectValues = [project.id, project._id, getProjectId(req)]
      .filter((value) => value !== undefined && value !== null && value !== "");
    if (projectValues.length === 0) return false;
    const roles = await col("roles");
    const role = await roles.findOne({
      $and: [
        { $or: projectValues.map((value) => ({ project_id: value })) },
        { $or: [{ _id: roleId }, { id: roleId }, { role_id: roleId }] },
      ],
    });
    return Array.isArray(role?.permissions) && role.permissions.some(permissionMatches);
  } catch {
    return false;
  }
}

export async function hasCascadeDeletePermission(req) {
  if (req?.projectAccess?.isOwner === true) return true;
  return roleHasCascadePermission(req);
}

export async function assertCascadeDeletePermission(req) {
  if (await hasCascadeDeletePermission(req)) return;
  throw new DeletionError("Permissão insuficiente para exclusão em cascata", {
    status: 403,
    code: "PERMISSION_DENIED",
  });
}

function valueKey(value) {
  return `${typeof value}:${idToString(value)}`;
}

function referenceValues(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    for (const candidate of documentIdReferenceValues(value)) {
      const key = valueKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function referenceFilter(field, values) {
  const candidates = referenceValues(values);
  return candidates.length > 0 ? { [field]: { $in: candidates } } : { $or: [] };
}

function documentValues(row) {
  return [row?.id, row?._id].filter((value) => value !== undefined && value !== null && value !== "");
}

function documentValue(row) {
  return row?.id ?? row?._id;
}

function rowDocumentFilter(row) {
  const values = referenceValues(documentValues(row));
  const clauses = [];
  for (const value of values) {
    clauses.push({ _id: value }, { id: value });
  }
  return clauses.length > 0 ? { $or: clauses } : { $or: [] };
}

function publicId(value) {
  const candidate = value && typeof value === "object" ? documentValue(value) : value;
  return idToString(candidate);
}

function uniqueRows(rows) {
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const id = publicId(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
}

function findOptions(session) {
  return session ? { session } : undefined;
}

function writeOptions(session, options = {}) {
  if (session) return { ...options, session };
  return Object.keys(options).length > 0 ? options : undefined;
}

async function rowsForReference(req, collectionName, field, values, { session, scope } = {}) {
  if (!values.length) return [];
  const collection = await col(collectionName);
  const projectFilter = scope || await deletionProjectFilter(req, { session });
  const filter = combineFilters(projectFilter, referenceFilter(field, values));
  return collection.find(filter, findOptions(session)).toArray();
}

async function rowsForPhotoReferences(req, association, { session, scope } = {}) {
  const clauses = [];
  for (const [field, values] of Object.entries(association)) {
    if (!values.length) continue;
    clauses.push(referenceFilter(field, values));
  }
  if (clauses.length === 0) return [];
  const collection = await col("photos_metadata");
  const projectFilter = scope || await deletionProjectFilter(req, { session });
  const filter = combineFilters(projectFilter, { $or: clauses });
  return uniqueRows(await collection.find(filter, findOptions(session)).toArray());
}

function dependencyData(counts, ids, blockingTotal) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    ids,
    total,
    blockingTotal: blockingTotal ?? total,
  };
}

export async function getDependencies(req, entity, existing, options = {}) {
  if (entity !== "lotes" && entity !== "plantios" && entity !== "insumos") {
    return dependencyData({}, {}, 0);
  }
  const { session, scope } = options || {};
  const projectScope = scope || await deletionProjectFilter(req, { session });
  const parentIds = documentValues(existing);
  if (entity === "lotes") {
    const plantios = await rowsForReference(req, "plantios", "lote_id", parentIds, {
      session,
      scope: projectScope,
    });
    const plantioIds = plantios.flatMap(documentValues);
    const gastos = await rowsForReference(req, "gastos", "plantio_id", plantioIds, {
      session,
      scope: projectScope,
    });
    const colheitas = await rowsForReference(req, "colheitas", "plantio_id", plantioIds, {
      session,
      scope: projectScope,
    });
    const photos = await rowsForPhotoReferences(
      req,
      { lote_id: parentIds, plantio_id: plantioIds },
      { session, scope: projectScope },
    );
    return dependencyData(
      { plantios: plantios.length, gastos: gastos.length, colheitas: colheitas.length, fotos: photos.length },
      { plantios, gastos, colheitas, fotos: photos },
      plantios.length + gastos.length + colheitas.length + photos.length,
    );
  }

  if (entity === "plantios") {
    const gastos = await rowsForReference(req, "gastos", "plantio_id", parentIds, {
      session,
      scope: projectScope,
    });
    const colheitas = await rowsForReference(req, "colheitas", "plantio_id", parentIds, {
      session,
      scope: projectScope,
    });
    const photos = await rowsForPhotoReferences(req, { plantio_id: parentIds }, {
      session,
      scope: projectScope,
    });
    return dependencyData(
      { gastos: gastos.length, colheitas: colheitas.length, fotos: photos.length },
      { gastos, colheitas, fotos: photos },
      gastos.length + colheitas.length + photos.length,
    );
  }

  if (entity === "insumos") {
    const gastos = await rowsForReference(req, "gastos", "insumo_id", parentIds, {
      session,
      scope: projectScope,
    });
    return dependencyData({ gastos: gastos.length }, { gastos }, 0);
  }

  return dependencyData({}, {}, 0);
}

function gridObjectId(value) {
  const text = idToString(value);
  return text && ObjectId.isValid(text) ? new ObjectId(text) : null;
}

async function gridFileBelongsToProject(bucket, gridId, req, session) {
  if (typeof bucket.find !== "function") return true;
  const cursor = bucket.find({ _id: gridId }, findOptions(session));
  if (!cursor || typeof cursor.next !== "function") return true;
  let file;
  try {
    file = await cursor.next();
  } finally {
    if (typeof cursor.close === "function") {
      try {
        await cursor.close();
      } catch {
      }
    }
  }
  if (!file) return true;
  const storedProject = file.metadata?.project_id ?? file.project_id;
  if (storedProject !== undefined && storedProject !== null && storedProject !== "") {
    return (normalizeId(storedProject) || idToString(storedProject)) === getProjectId(req);
  }
  return false;
}

function emptyPhotoResult() {
  return { metadata: 0, gridfs: 0, ids: [], rows: [], gridFiles: [], bucket: null };
}

async function collectGridFiles(req, photos, { bucket, session } = {}) {
  if (!bucket || photos.length === 0) return [];
  const gridFiles = [];
  const seen = new Set();
  for (const photo of photos) {
    const gridId = gridObjectId(photo.gridfs_id);
    if (!gridId) continue;
    const key = idToString(gridId);
    if (seen.has(key)) continue;
    let belongsToProject;
    try {
      belongsToProject = await gridFileBelongsToProject(bucket, gridId, req, session);
    } catch (error) {
      if (session) throw error;
      continue;
    }
    if (!belongsToProject) continue;
    seen.add(key);
    gridFiles.push({ gridId });
  }
  return gridFiles;
}

async function deletePhotos(req, photos, { session, scope } = {}) {
  const result = emptyPhotoResult();
  if (photos.length === 0) return result;
  const metadata = await col("photos_metadata");
  const projectScope = scope || await deletionProjectFilter(req, { session });
  try {
    result.bucket = getGridFSBucket();
  } catch (error) {
    if (session) throw error;
    result.bucket = null;
  }

  for (const photo of photos) {
    const deletion = await metadata.deleteOne(
      combineFilters(projectScope, rowDocumentFilter(photo)),
      writeOptions(session),
    );
    if (!deletion.deletedCount) continue;
    result.metadata += 1;
    result.rows.push(photo);
    const photoId = publicId(photo);
    if (photoId) result.ids.push(photoId);
  }
  result.gridFiles = await collectGridFiles(req, result.rows, {
    bucket: result.bucket,
    session,
  });
  return result;
}

async function deleteGridFiles(req, gridFiles, { session, bucket } = {}) {
  let deleted = 0;
  for (const { gridId } of gridFiles) {
    if (bucket && typeof bucket.find === "function") {
      try {
        if (!await gridFileBelongsToProject(bucket, gridId, req, session)) continue;
      } catch (error) {
        if (session) throw error;
        console.error("[deletion] GridFS cleanup skipped:", error?.message || error);
        continue;
      }
    }
    try {
      let removed = false;
      if (!session && bucket && typeof bucket.delete === "function") {
        try {
          await bucket.delete(gridId);
          removed = true;
        } catch (error) {
          try {
            removed = await deleteGridFSFile(gridId);
          } catch {
            throw error;
          }
        }
      } else {
        removed = await deleteGridFSFile(gridId, { session });
      }
      if (removed) deleted += 1;
    } catch (error) {
      if (session) throw error;
      console.error("[deletion] GridFS cleanup failed:", error?.message || error);
    }
  }
  return deleted;
}

async function deleteRows(req, entity, rows, { session, scope } = {}) {
  if (rows.length === 0) return { count: 0, rows: [] };
  const collection = await col(entity);
  const projectFilter = scope || await deletionProjectFilter(req, { session });
  const deletedRows = [];
  for (const row of rows) {
    const result = await collection.deleteOne(
      combineFilters(projectFilter, rowDocumentFilter(row)),
      writeOptions(session),
    );
    if (result.deletedCount) deletedRows.push(row);
  }
  return { count: deletedRows.length, rows: deletedRows };
}

function tombstones(rows, entity, cascade, now) {
  return rows.map((row) => ({
    entity,
    id: publicId(row),
    deleted_at: now,
    cascade,
  }));
}

function deletedIdEntries(entity, rows) {
  return rows.map((row) => ({ entity, id: publicId(row) }));
}

function photoIdEntries(ids) {
  return ids.map((id) => ({ entity: "photos_metadata", id }));
}

function photoTombstones(ids, now) {
  return ids.map((id) => ({ entity: "photos_metadata", id, deleted_at: now, cascade: true }));
}

function appendDeletedRows(deletedRows, deletedEntries, allTombstones, rows, entity, cascade, now) {
  if (rows.length === 0) return;
  deletedRows.push(...rows);
  deletedEntries.push(...deletedIdEntries(entity, rows));
  allTombstones.push(...tombstones(rows, entity, cascade, now));
}

async function nextTombstoneSequence(projectId, session) {
  const counters = await col("counters");
  const result = await counters.findOneAndUpdate(
    { _id: `tombstone:${projectId}` },
    { $inc: { value: 1 }, $setOnInsert: { created_at: new Date().toISOString() } },
    { upsert: true, returnDocument: "after", ...(session ? { session } : {}) },
  );
  const value = result?.value?.value ?? result?.value ?? result;
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Não foi possível reservar sequência de exclusão");
  return sequence;
}

async function persistTombstones(req, allTombstones, { session } = {}) {
  if (!Array.isArray(allTombstones) || allTombstones.length === 0) return;
  const collection = await col("tombstones");
  for (const tombstone of allTombstones) {
    const projectId = getProjectId(req);
    const entity = String(tombstone.entity);
    const id = String(tombstone.id);
    if (!projectId || !entity || !id) continue;
    await collection.updateOne(
      { project_id: projectId, entity, id },
      {
         $set: {
           seq: await nextTombstoneSequence(projectId, session),
           deleted_at: tombstone.deleted_at || new Date().toISOString(),
           cascade: tombstone.cascade === true,
           updated_at: new Date().toISOString(),
         },
        $setOnInsert: { project_id: projectId, entity, id, created_at: new Date().toISOString() },
      },
      writeOptions(session, { upsert: true }),
    );
  }
}

async function executeDeletion(req, entity, existing, dependencies, cascade, scope, session, now) {
  const deletedRows = [];
  const deletedEntries = [];
  const allTombstones = [];
  let counts = {};
  let photoResult = emptyPhotoResult();
  let disassociated = { count: 0, ids: [] };

  if (entity === "lotes" && cascade) {
    photoResult = await deletePhotos(req, dependencies.ids.fotos || [], { session, scope });
    deletedRows.push(...photoResult.rows);
    deletedEntries.push(...photoIdEntries(photoResult.ids));
    allTombstones.push(...photoTombstones(photoResult.ids, now));

    const gastos = dependencies.ids.gastos || [];
    const colheitas = dependencies.ids.colheitas || [];
    const plantios = dependencies.ids.plantios || [];
    const gastosResult = await deleteRows(req, "gastos", gastos, { session, scope });
    const colheitasResult = await deleteRows(req, "colheitas", colheitas, { session, scope });
    const plantiosResult = await deleteRows(req, "plantios", plantios, { session, scope });
    counts = {
      fotos: photoResult.metadata,
      gastos: gastosResult.count,
      colheitas: colheitasResult.count,
    };
    appendDeletedRows(deletedRows, deletedEntries, allTombstones, gastosResult.rows, "gastos", true, now);
    appendDeletedRows(deletedRows, deletedEntries, allTombstones, colheitasResult.rows, "colheitas", true, now);
    appendDeletedRows(deletedRows, deletedEntries, allTombstones, plantiosResult.rows, "plantios", true, now);
  } else if (entity === "plantios" && cascade) {
    photoResult = await deletePhotos(req, dependencies.ids.fotos || [], { session, scope });
    deletedRows.push(...photoResult.rows);
    deletedEntries.push(...photoIdEntries(photoResult.ids));
    allTombstones.push(...photoTombstones(photoResult.ids, now));

    const gastosResult = await deleteRows(req, "gastos", dependencies.ids.gastos || [], { session, scope });
    const colheitasResult = await deleteRows(req, "colheitas", dependencies.ids.colheitas || [], { session, scope });
    counts = {
      fotos: photoResult.metadata,
      gastos: gastosResult.count,
      colheitas: colheitasResult.count,
    };
    appendDeletedRows(deletedRows, deletedEntries, allTombstones, gastosResult.rows, "gastos", true, now);
    appendDeletedRows(deletedRows, deletedEntries, allTombstones, colheitasResult.rows, "colheitas", true, now);
  } else if (entity === "insumos" && cascade) {
    const gastosResult = await deleteRows(req, "gastos", dependencies.ids.gastos || [], { session, scope });
    counts = { gastos: gastosResult.count };
    appendDeletedRows(deletedRows, deletedEntries, allTombstones, gastosResult.rows, "gastos", true, now);
  } else if (entity === "insumos" && !cascade) {
    const gastos = dependencies.ids.gastos || [];
    if (gastos.length > 0) {
      const expenses = await col("gastos");
      const result = await expenses.updateMany(
        combineFilters(scope, referenceFilter("insumo_id", documentValues(existing))),
        { $set: { insumo_id: null, updated_at: now } },
        writeOptions(session),
      );
      disassociated = {
        count: result.modifiedCount || 0,
        ids: gastos.map((row) => publicId(row)).filter(Boolean),
      };
    }
    counts = { gastos: 0 };
  }

  const collection = await col(entity);
  const parentResult = await collection.deleteOne(
    combineFilters(scope, rowDocumentFilter(existing)),
    writeOptions(session),
  );
  if (!parentResult.deletedCount) {
    throw new DeletionError("Registro não encontrado", { status: 404, code: "NOT_FOUND" });
  }

  const parentId = publicId(existing);
  deletedRows.push(existing);
  deletedEntries.push({ entity, id: parentId });
  allTombstones.push({ entity, id: parentId, deleted_at: now, cascade });
  await persistTombstones(req, allTombstones, { session });
  photoResult.gridfs = await deleteGridFiles(req, photoResult.gridFiles, {
    session,
    bucket: photoResult.bucket,
  });

  return {
    entity,
    id: parentId,
    cascade,
    deleted: true,
    deletedCount: deletedRows.length,
    deletedIds: deletedEntries.map((entry) => entry.id),
    deletedEntities: deletedEntries,
    counts: { ...counts, parent: 1 },
    photos: {
      metadata: photoResult.metadata,
      gridfs: photoResult.gridfs,
      ids: photoResult.ids,
    },
    disassociatedCount: disassociated.count,
    disassociatedIds: disassociated.ids,
    tombstones: allTombstones,
  };
}

async function runDeletion(req, entity, id, cascade, scope, now) {
  const operation = async (session) => {
    const collection = await col(entity);
    const current = await findProjectDocument(
      req,
      collection,
      id,
      session ? { session, scope } : { scope },
    );
    if (!current) {
      throw new DeletionError("Registro não encontrado", { status: 404, code: "NOT_FOUND" });
    }
   const dependencies = await getDependencies(req, entity, current, { session, scope });
   const hasPhotoDependencies = Array.isArray(dependencies.ids?.fotos) && dependencies.ids.fotos.length > 0;
   if (cascade && hasPhotoDependencies && !hasPermission(req.projectAccess, PERMISSIONS.PHOTOS_WRITE)) {
     throw new DeletionError("Permissão insuficiente para remover fotos em cascata", {
       status: 403,
       code: "PERMISSION_DENIED",
     });
   }
   if (!cascade && dependencies.blockingTotal > 0) {
      throw new DeletionError(
        `O registro possui ${dependencies.blockingTotal} dependência(s) associada(s)`,
        { status: 409, code: "DEPENDENTS_EXIST", dependents: dependencies },
      );
    }
    return executeDeletion(req, entity, current, dependencies, cascade, scope, session, now);
  };

  try {
    return await withMongoTransaction(operation);
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    if (
      message.includes("transaction numbers are only allowed")
      || message.includes("transactions are not supported")
      || message.includes("replica set member or mongos")
      || message.includes("current topology does not support sessions")
    ) {
      throw new DeletionError("Exclusão requer MongoDB com transações habilitadas", {
        status: 503,
        code: "TRANSACTIONS_REQUIRED",
      });
    }
    throw error;
  }
}

export async function deleteEntity(req, entity, id, cascade = false) {
  if (!DELETE_ENTITIES.has(entity)) {
    throw new DeletionError("Entidade inválida para exclusão", { code: "INVALID_ENTITY" });
  }
  const collection = await col(entity);
  const existing = await findProjectDocument(req, collection, id);
  if (!existing) {
    throw new DeletionError("Registro não encontrado", { status: 404, code: "NOT_FOUND" });
  }
  if (cascade) await assertCascadeDeletePermission(req);

  const now = new Date().toISOString();
  const scope = await deletionProjectFilter(req);
  return runDeletion(req, entity, id, cascade, scope, now);
}
