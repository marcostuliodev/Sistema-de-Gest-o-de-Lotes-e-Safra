export type ScopedStorageArea = "local" | "session";

export interface ScopedStorageContext {
  userId: string | number;
  projectId?: string | null;
}

const STORAGE_PREFIX = "agrolote:scope:v2";

function normalizeScopePart(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  return normalized && normalized.trim() ? normalized : null;
}

function storageFor(area: ScopedStorageArea): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return area === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function prefixFor(context: ScopedStorageContext): string | null {
  const userId = normalizeScopePart(context.userId);
  if (!userId) return null;
  const projectId = normalizeScopePart(context.projectId) || "global";
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}:`;
}

export function getScopedStorageKey(
  context: ScopedStorageContext,
  key: string,
): string | null {
  const prefix = prefixFor(context);
  return prefix ? `${prefix}${key}` : null;
}

export function getScopedStorageItem(
  context: ScopedStorageContext,
  key: string,
  area: ScopedStorageArea = "local",
  useLegacyFallback = true,
): string | null {
  const storage = storageFor(area);
  const scopedKey = getScopedStorageKey(context, key);
  if (!storage || !scopedKey) return null;

  const scopedValue = storage.getItem(scopedKey);
  if (scopedValue !== null) return scopedValue;
  if (!useLegacyFallback) return null;

  const legacyValue = storage.getItem(key);
  if (legacyValue !== null) storage.setItem(scopedKey, legacyValue);
  return legacyValue;
}

export function setScopedStorageItem(
  context: ScopedStorageContext,
  key: string,
  value: string,
  area: ScopedStorageArea = "local",
): boolean {
  const storage = storageFor(area);
  const scopedKey = getScopedStorageKey(context, key);
  if (!storage || !scopedKey) return false;
  storage.setItem(scopedKey, value);
  return true;
}

export function removeScopedStorageItem(
  context: ScopedStorageContext,
  key: string,
  area: ScopedStorageArea = "local",
  removeLegacyFallback = false,
): void {
  const storage = storageFor(area);
  if (!storage) return;
  const scopedKey = getScopedStorageKey(context, key);
  if (scopedKey) storage.removeItem(scopedKey);
  if (removeLegacyFallback) storage.removeItem(key);
}

export function migrateLegacyStorageItem(
  context: ScopedStorageContext,
  key: string,
  area: ScopedStorageArea = "local",
): string | null {
  return getScopedStorageItem(context, key, area, true);
}

export function clearScopedStorage(
  context: ScopedStorageContext,
  area: ScopedStorageArea = "local",
): void {
  const storage = storageFor(area);
  const prefix = prefixFor(context);
  if (!storage || !prefix) return;

  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
