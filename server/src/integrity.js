/**
 * Detecção de ambiente comprometido (root/jailbreak/developer mode).
 *
 * No contexto de PWA, a detecção é limitada. Este módulo:
 * 1. Recebe relatórios de integridade do cliente (heurísticas)
 * 2. Mantém score de confiança por usuário
 * 3. Pode bloquear acesso se score cair abaixo do threshold
 *
 * O cliente envia señales como: DevTools aberto, userAgent suspeito, etc.
 */

import { col } from "./db.js";

export const INTEGRITY_MIGRATION = "";

/**
 * Processa um relatório de integridade do cliente.
 *
 * @param {number} userId
 * @param {string} signal - 'devtools_open' | 'suspicious_ua' | 'debugger_detected' | 'root_indicator'
 * @param {string} severity - 'low' | 'medium' | 'high' | 'critical'
 * @param {string|null} detail
 * @returns {{ score: number, blocked: boolean }}
 */
export async function reportIntegrity(userId, signal, severity = "low", detail = null) {
  const DEDUCTIONS = { low: 5, medium: 15, high: 30, critical: 50 };
  const deduction = DEDUCTIONS[severity] || 5;

  // Log do evento
  const logCol = await col("integrity_log");
  await logCol.insertOne({
    user_id: userId,
    signal,
    severity,
    detail,
    created_at: new Date().toISOString(),
  });

  // Atualiza score
  const scoreCol = await col("integrity_score");
  const current = await scoreCol.findOne({ user_id: userId });
  if (current?.blocked) {
    return { score: current.score, blocked: true };
  }

  const newScore = Math.max(0, (current?.score || 100) - deduction);
  const blocked = newScore <= 20;

  await scoreCol.updateOne(
    { user_id: userId },
    {
      $set: {
        score: current ? Math.min(current.score, newScore) : newScore,
        blocked: blocked,
        updated_at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );

  if (blocked) {
    console.warn(`[integrity] USUÁRIO ${userId} BLOQUEADO — score ${newScore} (signal: ${signal})`);
  }

  return { score: newScore, blocked };
}

/**
 * Verifica se o usuário está bloqueado.
 */
export async function isUserBlocked(userId) {
  const scoreCol = await col("integrity_score");
  const row = await scoreCol.findOne({ user_id: userId });
  return !!row?.blocked;
}

/**
 * Reseta score de integridade (ação administrativa).
 */
export async function resetIntegrityScore(userId) {
  const scoreCol = await col("integrity_score");
  await scoreCol.deleteOne({ user_id: userId });
  const logCol = await col("integrity_log");
  await logCol.deleteMany({ user_id: userId });
}
