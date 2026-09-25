/**
 * Sistema de licença assinado com RS256 (RSA + SHA-256).
 *
 * O servidor carrega um par de chaves RSA estável (env, MongoDB ou disco local).
 * A chave privada assina a licença; a chave pública é embutida no cliente
 * para validação offline — não é segredo, a segurança está na impossibilidade
 * de forjar a assinatura sem a privada.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlanFeatures } from "./plans.js";
import { col } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let privateKey = null;
let publicKey = null;

function setKeyPair(privatePem, publicPem) {
  if (!privatePem || !publicPem) return false;
  try {
    crypto.createPrivateKey(privatePem);
    crypto.createPublicKey(publicPem);
    privateKey = privatePem;
    publicKey = publicPem;
    return true;
  } catch {
    return false;
  }
}

function generateKeyPair() {
  const generated = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  setKeyPair(generated.privateKey, generated.publicKey);
  return generated;
}

function tryEnvKeys() {
  if (!process.env.LICENSE_PRIVATE_KEY || !process.env.LICENSE_PUBLIC_KEY) return false;
  const privRaw = process.env.LICENSE_PRIVATE_KEY;
  const pubRaw = process.env.LICENSE_PUBLIC_KEY.replace(/\\n/g, "\n");
  const candidates = [
    privRaw.replace(/\\n/g, "\n"),
    privRaw.replace(/\r\n/g, "\n").replace(/\\n/g, "\n"),
    privRaw,
  ];
  for (const priv of candidates) {
    if (setKeyPair(priv, pubRaw)) return true;
  }
  console.error(
    "[license] LICENSE_PRIVATE_KEY/PUBLIC_KEY inválidas no env — usando MongoDB/disco. " +
      "Atualize as env vars com um par PKCS#8/SPKI PEM válido."
  );
  return false;
}

/**
 * Carrega chaves RSA.
 * Prioridade:
 *   1. Env vars LICENSE_PRIVATE_KEY / LICENSE_PUBLIC_KEY
 *   2. MongoDB kv license_key_pair (padrão persistente)
 *   3. Arquivos em server/data/keys/ (fallback local)
 *   4. Gera novas chaves no primeiro boot (fallback local)
 */
function ensureKeys() {
  if (privateKey && publicKey) return;

  // 1. Tenta env vars (ideal para Vercel/serverless)
  if (tryEnvKeys()) return;

  // 2. Tenta arquivos locais (Render, VPS, desenvolvimento)
  const KEYS_DIR = path.join(__dirname, "..", "data", "keys");
  const PRIVATE_KEY_PATH = path.join(KEYS_DIR, "license_private.pem");
  const PUBLIC_KEY_PATH = path.join(KEYS_DIR, "license_public.pem");

  try {
    if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
      if (setKeyPair(fs.readFileSync(PRIVATE_KEY_PATH, "utf8"), fs.readFileSync(PUBLIC_KEY_PATH, "utf8"))) return;
    }
  } catch { /* filesystem read-only (Vercel) */ }

  // 3. Gera novas chaves em memória (fallback local)
  console.log("[license] Gerando par de chaves RS256 para assinatura de licenças...");
  const { privateKey: priv, publicKey: pub } = generateKeyPair();

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

export async function initializeLicenseKeys() {
  if (privateKey && publicKey) return;
  if (tryEnvKeys()) return;

  // MongoDB é a fonte persistente também para o par de chaves. Isso mantém
  // assinaturas válidas após cold start/deploy em Vercel/Render, onde o disco
  // é efêmero.
  try {
    const kv = await col("kv");
    const generated = generateKeyPair();
    const result = await kv.findOneAndUpdate(
      { key: "license_key_pair" },
      {
        $setOnInsert: {
          key: "license_key_pair",
          private_key: generated.privateKey,
          public_key: generated.publicKey,
          created_at: new Date().toISOString(),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    const document = result?.value || result;
    if (!setKeyPair(document?.private_key, document?.public_key)) {
      throw new Error("license_key_pair inválido no MongoDB");
    }
    return;
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      // Não deixa um par gerado apenas em memória parecer persistido após uma
      // falha transitória; a próxima tentativa deve reler/gravar no MongoDB.
      privateKey = null;
      publicKey = null;
      throw error;
    }
    console.warn(`[license] MongoDB não disponível para persistir chaves: ${error.message}`);
  }

  // Fallback local para desenvolvimento; em produção o bootstrap deve ter
  // MongoDB e, portanto, usar o ramo persistente acima.
  ensureKeys();
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
