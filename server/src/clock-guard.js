/**
 * Proteção contra manipulação de relógio (servidor).
 *
 * O servidor mantém um "heartbeat" do tempo conhecido para cada usuário.
 * A cada sync, compara o device time enviado com o server time.
 * Se houver drift significativo, registra e pode invalidar a licença.
 */

import { col } from "./db.js";

export const CLOCK_GUARD_MIGRATION = "";

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

  const heartbeatCol = await col("clock_heartbeat");
  const prev = await heartbeatCol.findOne({ user_id: userId });

  // Se já está marcado como comprometido, bloqueia
  if (prev?.compromised) {
    return { ok: false, serverTime: now.toISOString(), driftMs, compromised: true, reason: "clock_compromised" };
  }

  // Detectou relógio voltou (drift negativo grande)
  if (driftMs < HARD_BLOCK_DRIFT_MS) {
    await heartbeatCol.updateOne(
      { user_id: userId },
      {
        $set: {
          last_server_time: now.toISOString(),
          last_device_time: deviceTime,
          compromised: true,
          updated_at: new Date().toISOString(),
        },
        $inc: { drift_warnings: 1 },
      },
      { upsert: true }
    );
    return { ok: false, serverTime: now.toISOString(), driftMs, compromised: true, reason: "clock_rolled_back" };
  }

  // Drift acima do tolerável (relógio adiantado demais)
  let warnings = prev?.drift_warnings || 0;
  if (Math.abs(driftMs) > MAX_DRIFT_MS) {
    warnings += 1;
    if (warnings >= 3) {
      await heartbeatCol.updateOne(
        { user_id: userId },
        {
          $set: {
            last_server_time: now.toISOString(),
            last_device_time: deviceTime,
            drift_warnings: warnings,
            compromised: true,
            updated_at: new Date().toISOString(),
          },
        },
        { upsert: true }
      );
      return { ok: false, serverTime: now.toISOString(), driftMs, compromised: true, reason: "excessive_drift" };
    }
  }

  // Atualiza heartbeat normal
  await heartbeatCol.updateOne(
    { user_id: userId },
    {
      $set: {
        last_server_time: now.toISOString(),
        last_device_time: deviceTime,
        drift_warnings: warnings,
        compromised: false,
        updated_at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );

  return { ok: true, serverTime: now.toISOString(), driftMs, compromised: false };
}

/**
 * Reseta o status de comprometimento (usar apenas com ação administrativa).
 */
export async function resetClockGuard(userId) {
  const heartbeatCol = await col("clock_heartbeat");
  await heartbeatCol.deleteOne({ user_id: userId });
}
