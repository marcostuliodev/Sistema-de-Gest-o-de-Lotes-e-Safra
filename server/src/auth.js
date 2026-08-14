import jwt from "jsonwebtoken";

const DEFAULT_SECRET = "dev-secret-agrolote";
export const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;

const IS_PROD = process.env.NODE_ENV === "production";

if (IS_PROD && JWT_SECRET === DEFAULT_SECRET) {
  console.error("FATAL: JWT_SECRET nao definido em producao. Defina a variavel de ambiente JWT_SECRET.");
  process.exit(1);
}

const TOKEN_TTL = process.env.JWT_TTL || "7d";

export function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
    algorithm: "HS256",
    issuer: "agrolote",
    audience: "agrolote-app",
  });
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
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${TOKEN_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearAuthCookie(res) {
  const attrs = ["agrolote_token=", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function authMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: "Nao autenticado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "agrolote",
      audience: "agrolote-app",
    });
    next();
  } catch {
    return res.status(401).json({ error: "Sessao expirada, faca login novamente" });
  }
}
