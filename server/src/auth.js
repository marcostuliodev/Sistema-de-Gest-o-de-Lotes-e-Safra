import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { col } from "./db.js";
import { ObjectId } from "mongodb";

const DEFAULT_SECRET = "dev-secret-agrolote";
export const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;

const IS_PROD = process.env.NODE_ENV === "production";

if (IS_PROD && JWT_SECRET === DEFAULT_SECRET) {
  console.error("FATAL: JWT_SECRET nao definido em producao. Defina a variavel de ambiente JWT_SECRET.");
  process.exit(1);
}

if (!IS_PROD && !process.env.JWT_SECRET) {
  console.warn("[auth] JWT_SECRET nao definido — usando segredo padrao de desenvolvimento. NUNCA use o padrao em producao.");
}

// VULN-013: TTL mantido em 7d para nao quebrar sessoes longas do usuario.
// Reduzir para 24h exigiria re-login frequente (risco de UX) — deixamos o
// TTL configuravel via env JWT_TTL para ajuste futuro sem redeploy de codigo.
const TOKEN_TTL = process.env.JWT_TTL || "7d";

export function signToken(user) {
  return jwt.sign(
    {
      uid: user.id,
      email: user.email,
      email_verified: user.email_verified === true,
      token_version: Number(user.token_version || 0),
    },
    JWT_SECRET,
    {
      expiresIn: TOKEN_TTL,
      algorithm: "HS256",
      issuer: "agrolote",
      audience: "agrolote-app",
    }
  );
}

// SHA-256 do token em texto — o valor cru NUNCA vai ao banco (VULN-021).
export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

// Preferencialmente o token vem do cookie HttpOnly (inacessível via JS/XSS).
// Mantemos compatibilidade com o header Authorization para clientes legados.
function getTokenFromReq(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  const cookies = parseCookies(req);
  return cookies.agrolote_token || null;
}

const TOKEN_MAX_AGE = 7 * 24 * 3600; // 7d, alinhado com JWT_TTL

export function setAuthCookie(res, token) {
  const attrs = [
    `agrolote_token=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${TOKEN_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearAuthCookie(res) {
  const attrs = ["agrolote_token=", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

async function tokenVersionIsCurrent(payload) {
  const users = await col("users");
  const idFilters = [
    { id: payload.uid },
    { _id: payload.uid },
    { user_key: payload.uid },
  ];
  if (typeof payload.uid === "string" && ObjectId.isValid(payload.uid)) {
    idFilters.push({ _id: new ObjectId(payload.uid) });
  }
  if (typeof payload.uid === "string" && /^\d+$/.test(payload.uid)) {
    idFilters.push({ id: Number(payload.uid) }, { _id: Number(payload.uid) });
  }
  const user = await users.findOne({ $or: idFilters });
  if (!user) return false;
  if (payload.token_version !== undefined) {
    return Number(user.token_version || 0) === Number(payload.token_version || 0);
  }
  // Tokens legados sem claim são aceitos apenas até o primeiro logout/reset.
  const invalidBefore = Number(user.token_invalid_before || 0);
  return invalidBefore === 0 || Number(payload.iat || 0) > invalidBefore;
}

export function authMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: "Nao autenticado" });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "agrolote",
      audience: "agrolote-app",
    });
  } catch {
    return res.status(401).json({ error: "Sessao expirada, faca login novamente" });
  }
  tokenVersionIsCurrent(payload)
    .then((valid) => {
      if (!valid) return res.status(401).json({ error: "Sessao encerrada, faca login novamente" });
      req.user = payload;
      next();
    })
    .catch(() => res.status(503).json({ error: "Servico de autenticacao indisponivel" }));
}

export function optionalAuthMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return next();
  try {
    req.user = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "agrolote",
      audience: "agrolote-app",
    });
  } catch {
    // Logout deve limpar o cookie mesmo com token expirado.
  }
  next();
}

// VULN-010: bloqueia apenas rotas sensíveis (checkout/trial/invite).
// Tokens antigos sem claim são aceitos até token_invalid_before; novos
// logins sempre carregam token_version.
export function requireVerified(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user && req.user.email_verified === false) {
      return res.status(403).json({ error: "Confirme seu e-mail para continuar" });
    }
    next();
  });
}
