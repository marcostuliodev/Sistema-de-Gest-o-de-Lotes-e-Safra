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

import { db } from "./db.js";

export const INTEGRITY_MIGRATION = `
CREATE TABLE IF NOT EXISTS integrity_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'low',
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT now()::text
);

CREATE TABLE IF NOT EXISTS integrity_score (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 100,
  blocked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT now()::text
);
`;

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
  // Pontuação por severidade
  const DEDUCTIONS = { low: 5, medium: 15, high: 30, critical: 50 };
  const deduction = DEDUCTIONS[severity] || 5;

  // Log do evento
  await db.prepare(
    "INSERT INTO integrity_log (user_id, signal, severity, detail) VALUES (?, ?, ?, ?)"
  ).run(userId, signal, severity, detail);

  // Atualiza score
  const current = await db.prepare("SELECT score, blocked FROM integrity_score WHERE user_id = ?").get(userId);
  if (current?.blocked) {
    return { score: current.score, blocked: true };
  }

  const newScore = Math.max(0, (current?.score || 100) - deduction);
  const blocked = newScore <= 20; // Bloqueia abaixo de 20

  await db.prepare(
    `INSERT INTO integrity_score (user_id, score, blocked, updated_at)
     VALUES (?, ?, ?, now()::text)
     ON CONFLICT (user_id) DO UPDATE SET
       score = LEAST(integrity_score.score, ${newScore}),
       blocked = ${blocked ? 1 : 0},
       updated_at = now()::text`
  ).run(userId, newScore, blocked ? 1 : 0);

  if (blocked) {
    console.warn(`[integrity] USUÁRIO ${userId} BLOQUEADO — score ${newScore} (signal: ${signal})`);
  }

  return { score: newScore, blocked };
}

/**
 * Verifica se o usuário está bloqueado.
 */
export async function isUserBlocked(userId) {
  const row = await db.prepare("SELECT blocked FROM integrity_score WHERE user_id = ?").get(userId);
  return !!row?.blocked;
}

/**
 * Reseta score de integridade (ação administrativa).
 */
export async function resetIntegrityScore(userId) {
  await db.prepare("DELETE FROM integrity_score WHERE user_id = ?").run(userId);
  await db.prepare("DELETE FROM integrity_log WHERE user_id = ?").run(userId);
}
