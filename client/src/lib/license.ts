/**
 * Validação de licença no cliente.
 *
 * A chave pública é obtida do servidor no primeiro boot e cacheada.
 * A validação é feita localmente usando WebCrypto API (SubtleCrypto).
 *
 * NOTA: A chave pública NÃO é segredo — ela está no bundle.
 * A segurança está no fato de que forjar a assinatura requer a chave privada
 * que só existe no servidor.
 */

import { getActiveScope } from "../db/db";
import { getScopedStorageItem, removeScopedStorageItem, setScopedStorageItem, type ScopedStorageContext } from "./scoped-storage";

export interface LicensePayload {
  v: number;
  uid: number | string;
  plan: string;
  features: {
    maxLotes: number;
    maxPlantios: number;
    relatoriosAvancados: boolean;
    climaAlertas: boolean;
    label: string;
  };
  iat: string;
  exp: string;
  sub: string | null;
  sig: string;
}

export interface LicenseValidation {
  valid: boolean;
  plan: string;
  features: LicensePayload["features"];
  reason?: string;
}

const PUBLIC_KEY_CACHE_KEY = "agrolote_license_pubkey";
const LICENSE_KEY = "agrolote_license";

function storageContext(userId?: number | string): ScopedStorageContext | null {
  const scope = getActiveScope();
  if (scope && (userId === undefined || String(scope.userId) === String(userId) || String(scope.accountId) === String(userId))) {
    return { userId: scope.userId, projectId: scope.projectId };
  }
  return userId === undefined ? null : { userId, projectId: null };
}

// Default free plan features
const FREE_FEATURES = {
  maxLotes: 1,
  maxPlantios: 5,
  relatoriosAvancados: false,
  climaAlertas: false,
  label: "Gratuito",
};

/** Importa a chave pública PEM e a converte para CryptoKey. */
async function importPublicKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "spki",
    binaryDer.buffer,
    // O servidor assina com RSA PKCS#1 v1.5 (crypto.sign "sha256" default).
    // RSA-PSS fazia a verificação offline FALHAR sempre.
    { name: "RSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/** Converte base64 para Uint8Array. */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Obtém a chave pública do servidor (ou cache local).
 * SEMPRE tenta o servidor primeiro — se a chave do server mudou (redeploy
 * com env nova), o cache local antigo invalidaria a verificação offline.
 */
async function getPublicKey(userId?: number | string): Promise<string | null> {
  const context = storageContext(userId);
  try {
    const res = await fetch("/api/upgrade/public-key", { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      if (data.publicKey) {
        if (context) {
          const cached = getScopedStorageItem(context, PUBLIC_KEY_CACHE_KEY, "local", true);
          if (cached !== data.publicKey) setScopedStorageItem(context, PUBLIC_KEY_CACHE_KEY, data.publicKey, "local");
        }
        return data.publicKey;
      }
    }
  } catch {
    return context ? getScopedStorageItem(context, PUBLIC_KEY_CACHE_KEY, "local", true) : null;
  }
  return context ? getScopedStorageItem(context, PUBLIC_KEY_CACHE_KEY, "local", true) : null;
}

/**
 * Valida uma licença assinada localmente.
 */
export async function validateLicense(signedLicense: string, userId: number | string): Promise<LicenseValidation> {
  const fallback: LicenseValidation = { valid: false, plan: "free", features: FREE_FEATURES, reason: "fallback" };

  try {
    const license: LicensePayload = JSON.parse(signedLicense);
    const publicKeyPem = await getPublicKey(userId);
    if (!publicKeyPem) return fallback;

    // Prepara payload para verificação (tudo exceto sig)
    const { sig, ...payloadPart } = license;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadPart));
    const signatureBytes = base64ToUint8Array(sig);

    const cryptoKey = await importPublicKey(publicKeyPem);

    const valid = await crypto.subtle.verify(
      // Mesmo algoritmo do servidor: PKCS#1 v1.5, não PSS.
      { name: "RSA-PKCS1-v1_5" },
      cryptoKey,
      signatureBytes,
      payloadBytes
    );

    if (!valid) return { ...fallback, reason: "assinatura_invalida" };
    if (String(license.uid) !== String(userId)) return { ...fallback, reason: "user_mismatch" };
    // Expiração checada contra o relógio do dispositivo (Date.now) — mantém
    // funcionamento offline; o clock-guard do servidor cobre rollback.
    if (new Date(license.exp).getTime() < Date.now()) return { ...fallback, reason: "expirado" };

    return { valid: true, plan: license.plan, features: license.features };
  } catch {
    return fallback;
  }
}

// ── Persistência local ──────────────────────────────────────────────

export function getStoredLicense(userId?: number | string): string | null {
  const context = storageContext(userId);
  return context ? getScopedStorageItem(context, LICENSE_KEY, "local", true) : null;
}

export function setStoredLicense(license: string | null, userId?: number | string) {
  const context = storageContext(userId);
  if (!context) return;
  if (license) {
    setScopedStorageItem(context, LICENSE_KEY, license, "local");
  } else {
    removeScopedStorageItem(context, LICENSE_KEY, "local");
  }
}

/**
 * Valida licença armazenada localmente.
 * Retorna features do plano ou free se inválida/expirada.
 */
export async function validateStoredLicense(userId: number | string): Promise<LicenseValidation> {
  const stored = getStoredLicense(userId);
  if (!stored) return { valid: false, plan: "free", features: FREE_FEATURES };
  return validateLicense(stored, userId);
}

/**
 * Atualiza chave pública do servidor (chamar quando online).
 */
export async function refreshPublicKey(): Promise<boolean> {
  try {
    const res = await fetch("/api/upgrade/public-key", { credentials: "include" });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.publicKey) {
      const context = storageContext();
      if (context) setScopedStorageItem(context, PUBLIC_KEY_CACHE_KEY, data.publicKey, "local");
      return true;
    }
  } catch { /* offline */ }
  return false;
}
