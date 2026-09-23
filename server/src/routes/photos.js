import { Router } from "express";
import { GridFSBucket, ObjectId } from "mongodb";
import { col, getGridFSBucket } from "../db.js";
import { authMiddleware } from "../auth.js";
import { asyncHandler } from "../asyncHandler.js";
import { getPlanFeatures, resolveEffectivePlan } from "../plans.js";

const router = Router();
router.use(authMiddleware);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
// Teto do corpo multipart: 5MB (arquivo) + 50KB de margem p/ fields/boundary
const MULTIPART_BODY_LIMIT = MAX_FILE_SIZE + 50 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

function getExtension(filename) {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

/** Só permite extensões da whitelist (evita .svg/.html etc. no GridFS). */
function getAllowedExtension(ext) {
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : ".jpg";
}

/** Remove caracteres perigosos do nome exibido (path traversal / HTML). */
function sanitizeFilename(name) {
  return String(name).replace(/[<>"'`/\\]/g, "").slice(0, 200) || "photo.jpg";
}

function validateImageFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`Arquivo excede o limite de 5MB (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
  }
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    throw new Error(`Tipo de arquivo não permitido: ${file.mimetype}. Use JPEG, PNG ou WebP.`);
  }
}

/**
 * VULN-027: verifica magic bytes do buffer contra o mimetype declarado.
 * JPEG: FF D8 FF | PNG: 89 50 4E 47 | WebP: RIFF....WEBP
 * Retorna true se bate (ou se não dá para checar buffer vazio demais → false).
 */
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

async function checkPhotoLimit(userId, count) {
  const { resolveEffectivePlan } = await import("../plans.js");
  const { plan: activePlan } = await resolveEffectivePlan(userId);
  const features = getPlanFeatures(activePlan);
  const max = features.maxFotos;
  if (max === 0) {
    throw new Error("Seu plano não permite uploads de fotos. Faça upgrade para usar esta funcionalidade.");
  }
  if (max !== Infinity && count >= max) {
    throw new Error(`Limite de fotos atingido (${max}). Faça upgrade do seu plano.`);
  }
  return { activePlan, max };
}

// POST /api/photos — Upload via multipart/form-data
router.post("/", asyncHandler(async (req, res) => {
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    // VULN-004: aborta cedo se o Content-Length declarado já excede o limite
    const declaredLength = Number.parseInt(req.headers["content-length"] || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MULTIPART_BODY_LIMIT) {
      return res.status(413).json({ error: "Corpo da requisição excede o limite de 5MB." });
    }

    // Handle multipart form data
    const chunks = [];
    const fields = {};
    let receivedBytes = 0;
    let aborted = false;

    try {
      await new Promise((resolve, reject) => {
        let currentField = null;
        let currentData = [];
        let boundary = "";

        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (boundaryMatch) boundary = boundaryMatch[1];

        req.on("data", (chunk) => {
          if (aborted) return;
          receivedBytes += chunk.length;
          if (receivedBytes > MULTIPART_BODY_LIMIT) {
            aborted = true;
            const err = new Error("Corpo da requisição excede o limite de 5MB.");
            err.status = 413;
            if (!res.headersSent) res.status(413).json({ error: err.message });
            req.destroy();
            reject(err);
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
              const str = part.toString("utf-8");
              const headerEnd = str.indexOf("\r\n\r\n");
              if (headerEnd === -1) continue;

              const headerSection = str.slice(0, headerEnd);
              const nameMatch = headerSection.match(/name="([^"]+)"/);
              const filenameMatch = headerSection.match(/filename="([^"]+)"/);
              const contentTypeMatch = headerSection.match(/Content-Type:\s*(.+)/i);

              if (nameMatch) {
                const fieldName = nameMatch[1];
                const rawData = part.slice(Buffer.byteLength(str.slice(0, headerEnd + 4)));

                if (filenameMatch) {
                  // This is a file field
                  fields[fieldName] = {
                    originalname: filenameMatch[1],
                    mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
                    buffer: rawData,
                    size: rawData.length,
                  };
                } else {
                  // This is a regular field
                  fields[fieldName] = rawData.toString("utf-8").trim();
                }
              }
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        req.on("error", reject);
      });
    } catch (err) {
      if (res.headersSent) return;
      return res.status(err.status || 400).json({ error: err.message || "Falha ao processar o upload." });
    }

    const file = fields.photo;
    if (!file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado. Use o campo 'photo'." });
    }

    validateImageFile(file);

    // VULN-027: magic bytes precisam bater com o mimetype declarado (400)
    if (!magicBytesMatch(file.buffer, file.mimetype)) {
      return res.status(400).json({ error: "Conteúdo do arquivo não corresponde ao tipo declarado. Use JPEG, PNG ou WebP válidos." });
    }

    const plantio_id = typeof fields.plantio_id === "string" ? fields.plantio_id : "";
    const lote_id = typeof fields.lote_id === "string" ? fields.lote_id : "";

    // Check photo count limit
    const photoCount = await (await col("photos_metadata")).countDocuments({ user_id: req.user.uid });
    await checkPhotoLimit(req.user.uid, photoCount);

    // Upload to GridFS
    const bucket = getGridFSBucket();
    const ext = getAllowedExtension(getExtension(file.originalname));
    const filename = `${req.user.uid}/${Date.now()}${ext}`;

    const uploadStream = bucket.openUploadStream(filename, {
      contentType: file.mimetype,
      metadata: { user_id: req.user.uid },
    });

    await new Promise((resolve, reject) => {
      uploadStream.on("error", reject);
      uploadStream.on("finish", resolve);
      uploadStream.end(file.buffer);
    });

    // Save metadata
    const metadata = {
      _id: new ObjectId().toHexString(),
      user_id: req.user.uid,
      plantio_id,
      lote_id,
      filename: sanitizeFilename(file.originalname),
      mimetype: file.mimetype,
      size: file.size,
      gridfs_id: uploadStream.id.toString(),
      created_at: new Date().toISOString(),
    };

    await (await col("photos_metadata")).insertOne(metadata);
    res.status(201).json(metadata);
  } else if (contentType.includes("application/json")) {
    // Handle base64 JSON
    const { plantio_id, lote_id, filename, mimetype, data } = req.body || {};
    if (typeof data !== "string" || !data) {
      return res.status(400).json({ error: "Campo 'data' (base64) obrigatório." });
    }

    const buffer = Buffer.from(data, "base64");
    if (buffer.length > MAX_FILE_SIZE) {
      return res.status(400).json({ error: `Arquivo excede o limite de 5MB` });
    }

    const finalMimetype = typeof mimetype === "string" && mimetype ? mimetype : "image/jpeg";
    if (!ALLOWED_TYPES.includes(finalMimetype)) {
      return res.status(400).json({ error: `Tipo não permitido: ${finalMimetype}` });
    }

    // VULN-027: magic bytes do buffer base64 precisam bater com o mimetype
    if (!magicBytesMatch(buffer, finalMimetype)) {
      return res.status(400).json({ error: "Conteúdo do arquivo não corresponde ao tipo declarado. Use JPEG, PNG ou WebP válidos." });
    }

    const safeFilename = typeof filename === "string" && filename ? filename : "photo.jpg";
    const plantioRef = typeof plantio_id === "string" ? plantio_id : "";
    const loteRef = typeof lote_id === "string" ? lote_id : "";

    const photoCount = await (await col("photos_metadata")).countDocuments({ user_id: req.user.uid });
    await checkPhotoLimit(req.user.uid, photoCount);

    const bucket = getGridFSBucket();
    const ext = getAllowedExtension(getExtension(safeFilename));
    const gfFilename = `${req.user.uid}/${Date.now()}${ext}`;

    const uploadStream = bucket.openUploadStream(gfFilename, {
      contentType: finalMimetype,
      metadata: { user_id: req.user.uid },
    });

    await new Promise((resolve, reject) => {
      uploadStream.on("error", reject);
      uploadStream.on("finish", resolve);
      uploadStream.end(buffer);
    });

    const metadata = {
      _id: new ObjectId().toHexString(),
      user_id: req.user.uid,
      plantio_id: plantioRef,
      lote_id: loteRef,
      filename: sanitizeFilename(safeFilename),
      mimetype: finalMimetype,
      size: buffer.length,
      gridfs_id: uploadStream.id.toString(),
      created_at: new Date().toISOString(),
    };

    await (await col("photos_metadata")).insertOne(metadata);
    res.status(201).json(metadata);
  } else {
    return res.status(400).json({ error: "Content-Type não suportado. Use multipart/form-data ou application/json." });
  }
}));

// GET /api/photos?plantio_id=xxx or ?lote_id=xxx
router.get("/", asyncHandler(async (req, res) => {
  const { plantio_id, lote_id } = req.query;
  const filter = { user_id: req.user.uid };
  if (plantio_id) filter.plantio_id = plantio_id;
  if (lote_id) filter.lote_id = lote_id;

  const photos = await (await col("photos_metadata"))
    .find(filter)
    .sort({ created_at: -1 })
    .toArray();

  res.json(photos);
}));

// GET /api/photos/:id/file — Serve the actual image file
router.get("/:id/file", asyncHandler(async (req, res) => {
  const photo = await (await col("photos_metadata")).findOne({
    _id: req.params.id,
    user_id: req.user.uid,
  });
  if (!photo) return res.status(404).json({ error: "Foto não encontrada" });

  const bucket = getGridFSBucket();
  const gridfsId = new ObjectId(photo.gridfs_id);

  res.set("Content-Type", photo.mimetype);
  res.set("Cache-Control", "public, max-age=31536000");

  const downloadStream = bucket.openDownloadStream(gridfsId);
  downloadStream.on("error", () => res.status(404).json({ error: "Arquivo não encontrado" }));
  downloadStream.pipe(res);
}));

// DELETE /api/photos/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const photo = await (await col("photos_metadata")).findOne({
    _id: req.params.id,
    user_id: req.user.uid,
  });
  if (!photo) return res.status(404).json({ error: "Foto não encontrada" });

  // Delete from GridFS
  try {
    const bucket = getGridFSBucket();
    await bucket.delete(new ObjectId(photo.gridfs_id));
  } catch {
    // File might not exist in GridFS, continue with metadata deletion
  }

  // Delete metadata
  await (await col("photos_metadata")).deleteOne({ _id: req.params.id });
  res.status(204).end();
}));

// Helper: split buffer by delimiter
function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(delimiter, start);
    if (idx === -1) break;
    if (start > 0) {
      const part = buffer.slice(start, idx - 2); // -2 for \r\n before delimiter
      if (part.length > 0) parts.push(part);
    }
    start = idx + delimiter.length + 2; // +2 for \r\n after delimiter
  }
  return parts;
}

export default router;
