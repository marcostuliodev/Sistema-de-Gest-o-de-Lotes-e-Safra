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

export interface LicensePayload {
  v: number;
  uid: number;
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
    { name: "RSA-PSS", hash: "SHA-256" },
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
 */
async function getPublicKey(): Promise<string | null> {
  // Tenta cache local primeiro
  const cached = localStorage.getItem(PUBLIC_KEY_CACHE_KEY);
  if (cached) return cached;

  try {
    const res = await fetch("/api/upgrade/public-key", { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.publicKey) {
      localStorage.setItem(PUBLIC_KEY_CACHE_KEY, data.publicKey);
      return data.publicKey;
    }
  } catch {
    // Offline — usa cache
  }
  return cached;
}

/**
 * Valida uma licença assinada localmente.
 */
export async function validateLicense(signedLicense: string, userId: number): Promise<LicenseValidation> {
  const fallback: LicenseValidation = { valid: false, plan: "free", features: FREE_FEATURES, reason: "fallback" };

  try {
    const license: LicensePayload = JSON.parse(signedLicense);
    const publicKeyPem = await getPublicKey();
    if (!publicKeyPem) return fallback;

    // Prepara payload para verificação (tudo exceto sig)
    const { sig, ...payloadPart } = license;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadPart));
    const signatureBytes = base64ToUint8Array(sig);

    const cryptoKey = await importPublicKey(publicKeyPem);

    const valid = await crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      cryptoKey,
      signatureBytes,
      payloadBytes
    );

    if (!valid) return { ...fallback, reason: "assinatura_invalida" };
    if (license.uid !== userId) return { ...fallback, reason: "user_mismatch" };
    if (new Date(license.exp) < new Date()) return { ...fallback, reason: "expirado" };

    return { valid: true, plan: license.plan, features: license.features };
  } catch {
    return fallback;
  }
}

// ── Persistência local ──────────────────────────────────────────────

export function getStoredLicense(): string | null {
  return localStorage.getItem(LICENSE_KEY);
}

export function setStoredLicense(license: string | null) {
  if (license) {
    localStorage.setItem(LICENSE_KEY, license);
  } else {
    localStorage.removeItem(LICENSE_KEY);
  }
}

/**
 * Valida licença armazenada localmente.
 * Retorna features do plano ou free se inválida/expirada.
 */
export async function validateStoredLicense(userId: number): Promise<LicenseValidation> {
  const stored = getStoredLicense();
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
      localStorage.setItem(PUBLIC_KEY_CACHE_KEY, data.publicKey);
      return true;
    }
  } catch { /* offline */ }
  return false;
}
