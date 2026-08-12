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

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
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
