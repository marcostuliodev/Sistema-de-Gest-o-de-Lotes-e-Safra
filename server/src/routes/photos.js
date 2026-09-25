import { Router } from "express";
import { ObjectId } from "mongodb";
import { v4 as uuid } from "uuid";
import { col, getGridFSBucket, withMongoTransaction } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { getPlanFeatures, getSubscriptionPlan } from "../plans.js";
import {
  PERMISSIONS,
  idToString,
  normalizeId,
  projectMiddleware,
  requireProjectPermission,
} from "../authz.js";
import {
  buildProjectFilter,
  combineFilters,
  documentIdFilter,
  findProjectDocument,
  getActorKey,
  getProjectId,
  getProjectOwner,
} from "../projectScope.js";

const router = Router();
router.use(authMiddleware);
router.use(projectMiddleware);

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MULTIPART_BODY_LIMIT = MAX_FILE_SIZE + 50 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

class PhotoError extends Error {
  constructor(message, status = 400, code = "PHOTO_INVALID") {
    super(message);
    this.name = "PhotoError";
    this.status = status;
    this.code = code;
  }
}

function getExtension(filename) {
  const idx = String(filename).lastIndexOf(".");
  return idx >= 0 ? String(filename).slice(idx).toLowerCase() : "";
}

function getAllowedExtension(ext) {
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : ".jpg";
}

function sanitizeFilename(name) {
  return String(name).replace(/[<>"'`/\\]/g, "").slice(0, 200) || "photo.jpg";
}

function validateImageFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    throw new PhotoError(`Arquivo excede o limite de 5MB (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
  }
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    throw new PhotoError(`Tipo de arquivo não permitido: ${file.mimetype}. Use JPEG, PNG ou WebP.`);
  }
}

function magicBytesMatch(buffer, mimetype) {
  if (!buffer || buffer.length < 12) return false;
  if (mimetype === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimetype === "image/png") {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimetype === "image/webp") {
    return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

async function activePlanForOwner(owner, session) {
  const subscriptions = await col("subscriptions");
  const clauses = owner.values.map((value) => ({ user_id: value }));
  const subscription = clauses.length > 0
    ? await subscriptions.findOne({ $or: clauses }, session ? { session } : undefined)
    : null;
  return getSubscriptionPlan(subscription);
}

async function checkPhotoLimit(owner, req, session) {
  const activePlan = await activePlanForOwner(owner, session);
  const features = getPlanFeatures(activePlan);
  const max = features.maxFotos;
  if (max === 0) {
    throw new PhotoError(
      "Seu plano não permite uploads de fotos. Faça upgrade para usar esta funcionalidade.",
      403,
      "PLAN_LIMIT"
    );
  }
  if (max !== Infinity) {
    const lock = await col("photo_count_locks");
    await lock.updateOne(
      { _id: `${getProjectId(req)}:photos` },
      { $inc: { revision: 1 }, $set: { updated_at: new Date().toISOString() } },
      { upsert: true, session },
    );
    const count = await (await col("photos_metadata")).countDocuments(
      await buildProjectFilter(req),
      session ? { session } : undefined,
    );
    if (count >= max) {
      throw new PhotoError(`Limite de fotos atingido (${max}). Faça upgrade do seu plano.`, 403, "PLAN_LIMIT");
    }
  }
}

function assertSuppliedProject(value, req) {
  if (value === undefined || value === null || value === "") return;
  const supplied = normalizeId(value) || idToString(value);
  if (supplied !== getProjectId(req)) {
    throw new PhotoError("Operação pertence a outro projeto", 403, "PROJECT_SCOPE");
  }
}

async function validatePhotoReferences(req, plantioId, loteId) {
  const references = [];
  if (plantioId) references.push({ collection: "plantios", value: plantioId, label: "plantio" });
  if (loteId) references.push({ collection: "lotes", value: loteId, label: "lote" });
  for (const reference of references) {
    const collection = await col(reference.collection);
    const found = await findProjectDocument(req, collection, reference.value);
    if (!found) {
      throw new PhotoError(`Referência de ${reference.label} inválida para este projeto`, 400, "PROJECT_REFERENCE_INVALID");
    }
  }
}

async function uploadBuffer(req, owner, buffer, originalname, mimetype, plantioId, loteId) {
  const file = { buffer, size: buffer.length, mimetype, originalname };
  validateImageFile(file);
  if (!magicBytesMatch(buffer, mimetype)) {
    throw new PhotoError("Conteúdo do arquivo não corresponde ao tipo declarado. Use JPEG, PNG ou WebP válidos.");
  }

  await validatePhotoReferences(req, plantioId, loteId);

  const bucket = getGridFSBucket();
  const ext = getAllowedExtension(getExtension(originalname));
  const filename = `${getProjectId(req)}/${owner.userId}/${Date.now()}-${uuid()}${ext}`;
  const gridMetadata = {
    project_id: getProjectId(req),
    user_id: owner.userId,
    actor: getActorKey(req),
    created_by: getActorKey(req),
  };
  let uploadedId = null;
  try {
    return await withMongoTransaction(async (session) => {
      // O lock é mantido até a inserção do metadata; assim dois uploads
      // simultâneos não observam o mesmo contador abaixo do limite.
      await checkPhotoLimit(owner, req, session);
      const uploadStream = bucket.openUploadStream(filename, {
        contentType: mimetype,
        metadata: gridMetadata,
      });
      uploadedId = uploadStream.id;
      await new Promise((resolve, reject) => {
        uploadStream.on("error", reject);
        uploadStream.on("finish", resolve);
        uploadStream.end(buffer);
      });
      const metadata = {
        _id: new ObjectId().toHexString(),
        project_id: getProjectId(req),
        user_id: owner.userId,
        actor: getActorKey(req),
        created_by: getActorKey(req),
        plantio_id: plantioId,
        lote_id: loteId,
        filename: sanitizeFilename(originalname),
        mimetype,
        size: buffer.length,
        gridfs_id: uploadStream.id.toString(),
        created_at: new Date().toISOString(),
      };
      await (await col("photos_metadata")).insertOne(metadata, { session });
      return metadata;
    });
  } catch (error) {
    if (uploadedId) {
      try {
        await bucket.delete(uploadedId);
      } catch {
      }
    }
    throw error;
  }
}

function publicPhoto(photo) {
  const { gridfs_id, user_id, actor, project_id, ...safe } = photo || {};
  return safe;
}

function photoErrorResponse(res, error) {
  if (!(error instanceof PhotoError)) return null;
  return res.status(error.status).json({ error: error.message, code: error.code });
}

router.post(
  "/",
  requireProjectPermission(PERMISSIONS.PHOTOS_WRITE),
  asyncHandler(async (req, res) => {
    const contentType = req.headers["content-type"] || "";
    try {
      if (contentType.includes("multipart/form-data")) {
        const declaredLength = Number.parseInt(req.headers["content-length"] || "", 10);
        if (Number.isFinite(declaredLength) && declaredLength > MULTIPART_BODY_LIMIT) {
          return res.status(413).json({ error: "Corpo da requisição excede o limite de 5MB." });
        }

        const chunks = [];
         const fields = Object.create(null);
        let receivedBytes = 0;
        let aborted = false;

        try {
          await new Promise((resolve, reject) => {
            let boundary = "";
            const boundaryMatch = contentType.match(/boundary=(.+)/);
            if (boundaryMatch) boundary = boundaryMatch[1];

            req.on("data", (chunk) => {
              if (aborted) return;
              receivedBytes += chunk.length;
              if (receivedBytes > MULTIPART_BODY_LIMIT) {
                aborted = true;
                const error = new Error("Corpo da requisição excede o limite de 5MB.");
                error.status = 413;
                if (!res.headersSent) res.status(413).json({ error: error.message });
                req.destroy();
                reject(error);
                return;
              }
              chunks.push(chunk);
            });

            req.on("end", () => {
              try {
                const fullBuffer = Buffer.concat(chunks);
                const boundaryBuf = Buffer.from(`--${boundary}`);
                const parts = splitBuffer(fullBuffer, boundaryBuf);
                for (const part of parts) {
                  const text = part.toString("utf-8");
                  const headerEnd = text.indexOf("\r\n\r\n");
                  if (headerEnd === -1) continue;
                  const headerSection = text.slice(0, headerEnd);
                  const nameMatch = headerSection.match(/name="([^"]+)"/);
                  const filenameMatch = headerSection.match(/filename="([^"]+)"/);
                  const contentTypeMatch = headerSection.match(/Content-Type:\s*(.+)/i);
                  if (!nameMatch) continue;
                  const fieldName = nameMatch[1];
                  const rawData = part.slice(Buffer.byteLength(text.slice(0, headerEnd + 4)));
                  if (filenameMatch) {
                    fields[fieldName] = {
                      originalname: filenameMatch[1],
                      mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
                      buffer: rawData,
                      size: rawData.length,
                    };
                  } else {
                    fields[fieldName] = rawData.toString("utf-8").trim();
                  }
                }
                resolve();
              } catch (error) {
                reject(error);
              }
            });
            req.on("error", reject);
          });
        } catch (error) {
          if (res.headersSent) return;
          return res.status(error.status || 400).json({ error: error.message || "Falha ao processar o upload." });
        }

        const file = fields.photo;
        if (!file) return res.status(400).json({ error: "Nenhum arquivo enviado. Use o campo 'photo'." });
        assertSuppliedProject(fields.project_id, req);
        assertSuppliedProject(fields.projectId, req);
        const plantioId = typeof fields.plantio_id === "string" ? fields.plantio_id : "";
        const loteId = typeof fields.lote_id === "string" ? fields.lote_id : "";
        const owner = await getProjectOwner(req);
        const metadata = await uploadBuffer(
          req,
          owner,
          file.buffer,
          file.originalname,
          file.mimetype,
          plantioId,
          loteId
        );
         return res.status(201).json(publicPhoto(metadata));
      }

      if (contentType.includes("application/json")) {
        const body = req.body || {};
        const data = body.data;
        if (typeof data !== "string" || !data) {
          return res.status(400).json({ error: "Campo 'data' (base64) obrigatório." });
        }
        assertSuppliedProject(body.project_id, req);
        assertSuppliedProject(body.projectId, req);
        const buffer = Buffer.from(data, "base64");
        if (buffer.length > MAX_FILE_SIZE) {
          return res.status(400).json({ error: "Arquivo excede o limite de 5MB" });
        }
        const mimetype = typeof body.mimetype === "string" && body.mimetype ? body.mimetype : "image/jpeg";
        const filename = typeof body.filename === "string" && body.filename ? body.filename : "photo.jpg";
        const plantioId = typeof body.plantio_id === "string" ? body.plantio_id : "";
        const loteId = typeof body.lote_id === "string" ? body.lote_id : "";
        const owner = await getProjectOwner(req);
        const metadata = await uploadBuffer(req, owner, buffer, filename, mimetype, plantioId, loteId);
         return res.status(201).json(publicPhoto(metadata));
      }

      return res.status(400).json({ error: "Content-Type não suportado. Use multipart/form-data ou application/json." });
    } catch (error) {
      const response = photoErrorResponse(res, error);
      if (response) return response;
      throw error;
    }
  })
);

router.get(
  "/",
  requireProjectPermission(PERMISSIONS.PHOTOS_READ),
  asyncHandler(async (req, res) => {
    const scope = await buildProjectFilter(req);
    const filters = [scope];
    if (req.query.plantio_id) {
      const collection = await col("plantios");
      const found = await findProjectDocument(req, collection, req.query.plantio_id);
      if (!found) return res.status(400).json({ error: "Referência de plantio inválida para este projeto", code: "PROJECT_REFERENCE_INVALID" });
      filters.push({ plantio_id: req.query.plantio_id });
    }
    if (req.query.lote_id) {
      const collection = await col("lotes");
      const found = await findProjectDocument(req, collection, req.query.lote_id);
      if (!found) return res.status(400).json({ error: "Referência de lote inválida para este projeto", code: "PROJECT_REFERENCE_INVALID" });
      filters.push({ lote_id: req.query.lote_id });
    }

    const photos = await (await col("photos_metadata"))
      .find(combineFilters(...filters))
      .sort({ created_at: -1 })
      .toArray();
     return res.json(photos.map(publicPhoto));
  })
);

function gridFsObjectId(value) {
  if (value instanceof ObjectId) return value;
  const id = idToString(value);
  return id && ObjectId.isValid(id) ? new ObjectId(id) : null;
}

async function gridFileScope(bucket, gridfsId, req) {
  if (typeof bucket.find !== "function") return { checked: false, allowed: true };
  const cursor = bucket.find({ _id: gridfsId });
  if (!cursor || typeof cursor.next !== "function") return { checked: false, allowed: true };
  const file = await cursor.next();
  if (!file) return { checked: true, allowed: false };
  const storedProject = file.metadata?.project_id ?? file.project_id;
  if (storedProject !== undefined && storedProject !== null && storedProject !== "") {
    return { checked: true, allowed: (normalizeId(storedProject) || idToString(storedProject)) === getProjectId(req) };
  }
  const storedOwner = file.metadata?.user_id ?? file.metadata?.owner_id ?? file.user_id ?? file.owner_id;
  if (storedOwner !== undefined && storedOwner !== null && storedOwner !== "") {
    const owner = await getProjectOwner(req);
    return {
      checked: true,
      allowed: req.project?.is_default === true
        && owner.values.some((value) => (normalizeId(value) || idToString(value)) === (normalizeId(storedOwner) || idToString(storedOwner))),
    };
  }
  return { checked: true, allowed: false };
}

router.get(
  "/:id/file",
  requireProjectPermission(PERMISSIONS.PHOTOS_READ),
  asyncHandler(async (req, res) => {
    const photos = await col("photos_metadata");
    const photo = await findProjectDocument(req, photos, req.params.id);
    if (!photo) return res.status(404).json({ error: "Foto não encontrada" });

    if (!ALLOWED_TYPES.includes(photo.mimetype)) return res.status(404).json({ error: "Arquivo não encontrado" });
    const gridfsId = gridFsObjectId(photo.gridfs_id);
    if (!gridfsId) return res.status(404).json({ error: "Arquivo não encontrado" });
    const bucket = getGridFSBucket();
    const scope = await gridFileScope(bucket, gridfsId, req);
    if (scope.checked && !scope.allowed) return res.status(404).json({ error: "Arquivo não encontrado" });

    res.set("Content-Type", photo.mimetype);
    res.set("Cache-Control", "private, no-store");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const downloadStream = bucket.openDownloadStream(gridfsId);
    downloadStream.on("error", () => {
      if (!res.headersSent) res.status(404).json({ error: "Arquivo não encontrado" });
      else res.destroy();
    });
    downloadStream.pipe(res);
  })
);

router.delete(
  "/:id",
  requireProjectPermission(PERMISSIONS.PHOTOS_WRITE),
  asyncHandler(async (req, res) => {
    const photos = await col("photos_metadata");
    const photo = await findProjectDocument(req, photos, req.params.id);
    if (!photo) return res.status(404).json({ error: "Foto não encontrada" });

    const gridfsId = gridFsObjectId(photo.gridfs_id);
    if (gridfsId) {
      const bucket = getGridFSBucket();
      const fileScope = await gridFileScope(bucket, gridfsId, req);
      if (fileScope.checked && !fileScope.allowed) return res.status(404).json({ error: "Foto não encontrada" });
      try {
        await bucket.delete(gridfsId);
      } catch {
      }
    }

    const result = await photos.deleteOne(
      combineFilters(await buildProjectFilter(req), documentIdFilter(photo._id ?? photo.id))
    );
    if (result.deletedCount === 0) return res.status(404).json({ error: "Foto não encontrada" });
    return res.status(204).end();
  })
);

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  while (true) {
    const index = buffer.indexOf(delimiter, start);
    if (index === -1) break;
    if (start > 0) {
      const part = buffer.slice(start, index - 2);
      if (part.length > 0) parts.push(part);
    }
    start = index + delimiter.length + 2;
  }
  return parts;
}

export default router;
