/**
 * Proteção contra manipulação de relógio (servidor).
 *
 * O servidor mantém um "heartbeat" do tempo conhecido para cada usuário.
 * A cada sync, compara o device time enviado com o server time.
 * Se houver drift significativo, registra e pode invalidar a licença.
 */

import { db } from "./db.js";

/**
 * Cria a tabela de heartbeat se não existir (chamar no migrate).
 */
export const CLOCK_GUARD_MIGRATION = `
CREATE TABLE IF NOT EXISTS clock_heartbeat (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_server_time TEXT NOT NULL,
  last_device_time TEXT NOT NULL,
  drift_warnings INTEGER NOT NULL DEFAULT 0,
  compromised INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT now()::text
);
`;

/** Tolerância máxima de drift em milissegundos (1 hora). */
const MAX_DRIFT_MS = 60 * 60 * 1000;

/** Drift que gera bloqueio imediato (relogio voltou mais de 5 minutos). */
const HARD_BLOCK_DRIFT_MS = -(5 * 60 * 1000);

/**
 * Registra heartbeat e retorna status da integridade do relógio.
 *
 * @param {number} userId
 * @param {string} deviceTime - ISO timestamp enviado pelo cliente
 * @returns {{ ok: boolean, serverTime: string, driftMs: number, compromised: boolean }}
 */
export async function checkClock(userId, deviceTime) {
  const now = new Date();
  const deviceDate = new Date(deviceTime);

  if (isNaN(deviceDate.getTime())) {
    return { ok: false, serverTime: now.toISOString(), driftMs: 0, compromised: false, reason: "invalid_time" };
  }

  const driftMs = deviceDate.getTime() - now.getTime();

  // Verifica heartbeat anterior
  const prev = await db.prepare(
    "SELECT last_server_time, drift_warnings, compromised FROM clock_heartbeat WHERE user_id = ?"
  ).get(userId);

  // Se já está marcado como comprometido, bloqueia
  if (prev?.compromised) {
    return { ok: false, serverTime: now.toISOString(), driftMs, compromised: true, reason: "clock_compromised" };
  }

  // Detectou relógio voltou (drift negativo grande)
  if (driftMs < HARD_BLOCK_DRIFT_MS) {
    await db.prepare(
      `INSERT INTO clock_heartbeat (user_id, last_server_time, last_device_time, drift_warnings, compromised, updated_at)
       VALUES (?, ?, ?, 1, 1, now()::text)
       ON CONFLICT (user_id) DO UPDATE SET
         last_server_time = EXCLUDED.last_server_time,
         last_device_time = EXCLUDED.last_device_time,
         drift_warnings = clock_heartbeat.drift_warnings + 1,
         compromised = 1,
         updated_at = now()::text`
    ).run(userId, now.toISOString(), deviceTime);
    return { ok: false, serverTime: now.toISOString(), driftMs, compromised: true, reason: "clock_rolled_back" };
  }

  // Drift acima do tolerável (relógio adiantado demais)
  let warnings = prev?.drift_warnings || 0;
  if (Math.abs(driftMs) > MAX_DRIFT_MS) {
    warnings += 1;
    // 3 avisos = compromete
    if (warnings >= 3) {
      await db.prepare(
        `INSERT INTO clock_heartbeat (user_id, last_server_time, last_device_time, drift_warnings, compromised, updated_at)
         VALUES (?, ?, ?, ?, 1, now()::text)
         ON CONFLICT (user_id) DO UPDATE SET
           last_server_time = EXCLUDED.last_server_time,
           last_device_time = EXCLUDED.last_device_time,
           drift_warnings = EXCLUDED.drift_warnings,
           compromised = 1,
           updated_at = now()::text`
      ).run(userId, now.toISOString(), deviceTime, warnings);
      return { ok: false, serverTime: now.toISOString(), driftMs, compromised: true, reason: "excessive_drift" };
    }
  }

  // Atualiza heartbeat normal
  await db.prepare(
    `INSERT INTO clock_heartbeat (user_id, last_server_time, last_device_time, drift_warnings, compromised, updated_at)
     VALUES (?, ?, ?, ?, 0, now()::text)
     ON CONFLICT (user_id) DO UPDATE SET
       last_server_time = EXCLUDED.last_server_time,
       last_device_time = EXCLUDED.last_device_time,
       drift_warnings = EXCLUDED.drift_warnings,
       compromised = 0,
       updated_at = now()::text`
  ).run(userId, now.toISOString(), deviceTime, warnings);

  return { ok: true, serverTime: now.toISOString(), driftMs, compromised: false };
}

/**
 * Reseta o status de comprometimento (usar apenas com ação administrativa).
 */
export async function resetClockGuard(userId) {
  await db.prepare("DELETE FROM clock_heartbeat WHERE user_id = ?").run(userId);
}
