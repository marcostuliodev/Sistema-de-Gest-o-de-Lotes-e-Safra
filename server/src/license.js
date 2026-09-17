/**
 * Sistema de licença assinado com RS256 (RSA + SHA-256).
 *
 * O servidor gera um par de chaves RSA no primeiro boot e salva em disco.
 * A chave privada assina a licença; a chave pública é embutida no cliente
 * para validação offline — não é segredo, a segurança está na impossibilidade
 * de forjar a assinatura sem a privada.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlanFeatures } from "./plans.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let privateKey = null;
let publicKey = null;

/**
 * Carrega chaves RSA.
 * Prioridade:
 *   1. Env vars LICENSE_PRIVATE_KEY / LICENSE_PUBLIC_KEY (Vercel, produção)
 *   2. Arquivos em server/data/keys/ (local, Render)
 *   3. Gera novas chaves no primeiro boot (local)
 */
function ensureKeys() {
  if (privateKey && publicKey) return;

  // 1. Tenta env vars (ideal para Vercel/serverless)
  if (process.env.LICENSE_PRIVATE_KEY && process.env.LICENSE_PUBLIC_KEY) {
    privateKey = process.env.LICENSE_PRIVATE_KEY.replace(/\\n/g, "\n");
    publicKey = process.env.LICENSE_PUBLIC_KEY.replace(/\\n/g, "\n");
    return;
  }

  // 2. Tenta arquivos locais (Render, VPS, desenvolvimento)
  const KEYS_DIR = path.join(__dirname, "..", "data", "keys");
  const PRIVATE_KEY_PATH = path.join(KEYS_DIR, "license_private.pem");
  const PUBLIC_KEY_PATH = path.join(KEYS_DIR, "license_public.pem");

  try {
    if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
      privateKey = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
      publicKey = fs.readFileSync(PUBLIC_KEY_PATH, "utf8");
      return;
    }
  } catch { /* filesystem read-only (Vercel) */ }

  // 3. Gera novas chaves em memória (serverless) ou em disco (local)
  console.log("[license] Gerando par de chaves RS256 para assinatura de licenças...");
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privateKey = priv;
  publicKey = pub;

  try {
    if (!fs.existsSync(KEYS_DIR)) {
      fs.mkdirSync(KEYS_DIR, { recursive: true });
    }
    fs.writeFileSync(PRIVATE_KEY_PATH, priv, { mode: 0o600 });
    fs.writeFileSync(PUBLIC_KEY_PATH, pub, { mode: 0o644 });
    console.log("[license] Chaves salvas em:", KEYS_DIR);
  } catch {
    console.warn("[license] Filesystem read-only (Vercel). Chaves geradas em memória. Defina LICENSE_PRIVATE_KEY e LICENSE_PUBLIC_KEY como env vars.");
  }
}

/** Retorna a chave pública PEM (para embutir no bundle do cliente). */
export function getPublicKeyPem() {
  ensureKeys();
  return publicKey;
}

/**
 * Gera uma licença assinada.
 * @param {number} userId
 * @param {string} plan - 'free' | 'basico' | 'pro' | 'premium'
 * @param {string|null} stripeSubscriptionId
 * @param {Date|null} trialEnd - se trial, data de expiração; senão null
 * @returns {string} JSON.stringify do payload assinado
 */
export function generateLicense(userId, plan, stripeSubscriptionId = null, trialEnd = null) {
  ensureKeys();
  const features = getPlanFeatures(plan);
  const now = new Date();

  const payload = {
    v: 1, // versão do formato
    uid: userId,
    plan,
    features: { ...features },
    iat: now.toISOString(),
    exp: trialEnd ? trialEnd.toISOString() : addMonths(now, 1).toISOString(), // 1 mês por ciclo
    sub: stripeSubscriptionId,
  };

  const signature = crypto.sign("sha256", Buffer.from(JSON.stringify(payload)), privateKey);
  const license = { ...payload, sig: signature.toString("base64") };
  return JSON.stringify(license);
}

/**
 * Verifica a assinatura e validade de uma licença.
 * @param {string} signedLicense - JSON.stringify da licença
 * @param {number} expectedUserId - userId do usuário logado
 * @returns {{ valid: boolean, plan: string, features: object, reason?: string }}
 */
export function verifyLicense(signedLicense, expectedUserId) {
  ensureKeys();
  try {
    const license = JSON.parse(signedLicense);

    if (!license.sig || !license.plan || !license.uid || !license.exp) {
      return { valid: false, plan: "free", features: getPlanFeatures("free"), reason: "formato_invalido" };
    }

    // Verifica assinatura
    const { sig, ...payloadPart } = license;
    const validSig = crypto.verify(
      "sha256",
      Buffer.from(JSON.stringify(payloadPart)),
      publicKey,
      Buffer.from(sig, "base64")
    );
    if (!validSig) {
      return { valid: false, plan: "free", features: getPlanFeatures("free"), reason: "assinatura_invalida" };
    }

    // Verifica userId (impede cópia entre contas)
    if (license.uid !== expectedUserId) {
      return { valid: false, plan: "free", features: getPlanFeatures("free"), reason: "user_mismatch" };
    }

    // Verifica expiração
    if (new Date(license.exp) < new Date()) {
      return { valid: false, plan: "free", features: getPlanFeatures("free"), reason: "expirado" };
    }

    return {
      valid: true,
      plan: license.plan,
      features: getPlanFeatures(license.plan),
      exp: license.exp,
    };
  } catch {
    return { valid: false, plan: "free", features: getPlanFeatures("free"), reason: "parse_error" };
  }
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}
