/**
 * Proteção contra manipulação de relógio no cliente.
 *
 * Estratégia:
 * 1. Mantém "âncora de tempo" no IndexedDB (last_known_time)
 * 2. A cada app start, compara device time vs âncora
 * 3. Se device time < âncora → relógio voltou → BLOQUEIO
 * 4. Se device time > âncora + 24h → possível adiantamento → WARNING
 * 5. A cada sync online, valida com server time via heartbeat
 */

const ANCHOR_KEY = "agrolote_clock_anchor";
const CLOCK_VIOLATIONS_KEY = "agrolote_clock_violations";

export interface ClockCheckResult {
  ok: boolean;
  reason?: "clock_rolled_back" | "clock_ahead" | "server_compromised";
  driftMs?: number;
  serverTime?: string;
}

/**
 * Retorna a âncora de tempo salva.
 */
export function getAnchor(): number | null {
  try {
    const raw = localStorage.getItem(ANCHOR_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Atualiza a âncora de tempo.
 */
export function setAnchor(time: number) {
  localStorage.setItem(ANCHOR_KEY, String(time));
}

/**
 * Retorna violações de relógio acumuladas.
 */
function getViolations(): number {
  try {
    return Number(localStorage.getItem(CLOCK_VIOLATIONS_KEY) || "0");
  } catch {
    return 0;
  }
}

function addViolation(): number {
  const count = getViolations() + 1;
  localStorage.setItem(CLOCK_VIOLATIONS_KEY, String(count));
  return count;
}

function clearViolations() {
  localStorage.removeItem(CLOCK_VIOLATIONS_KEY);
}

/**
 * Verificação local do relógio (chamar no app start).
 */
export function checkClockLocal(): ClockCheckResult {
  const now = Date.now();
  const anchor = getAnchor();

  if (!anchor) {
    // Primeira vez — establece âncora
    setAnchor(now);
    return { ok: true };
  }

  const driftMs = now - anchor;

  // Relógio voltou mais de 5 minutos
  if (driftMs < -(5 * 60 * 1000)) {
    const violations = addViolation();
    if (violations >= 3) {
      return { ok: false, reason: "clock_rolled_back", driftMs };
    }
    // Permite poucas violações (pode ser ajuste de timezone)
    return { ok: true, driftMs };
  }

  // Relógio adiantado mais de 24 horas
  if (driftMs > 24 * 60 * 60 * 1000) {
    return { ok: true, reason: "clock_ahead", driftMs };
  }

  // Tudo OK — atualiza âncora para o maior valor (monotônico)
  if (now > anchor) {
    setAnchor(now);
  }
  clearViolations();
  return { ok: true, driftMs };
}

/**
 * Envia heartbeat para o servidor e processa resposta.
 * Chamar periodicamente quando online.
 */
export async function sendHeartbeat(): Promise<ClockCheckResult> {
  try {
    const deviceTime = new Date().toISOString();
    const res = await fetch("/api/upgrade/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ deviceTime }),
    });

    if (!res.ok) return { ok: true };

    const data = await res.json();

    if (data.compromised) {
      return { ok: false, reason: "server_compromised", serverTime: data.serverTime, driftMs: data.driftMs };
    }

    // Atualiza âncora com server time
    if (data.serverTime) {
      const serverTs = new Date(data.serverTime).getTime();
      setAnchor(serverTs);
    }

    return { ok: true, driftMs: data.driftMs };
  } catch {
    return { ok: true }; // Offline — não bloqueia
  }
}

/**
 * Verifica integridade do relógio no startup.
 * Retorna resultado E agenda próxima verificação.
 */
export function initClockGuard(): ClockCheckResult {
  const result = checkClockLocal();

  let intervalId: ReturnType<typeof setInterval> | null = null;
  if (typeof window !== "undefined") {
    intervalId = setInterval(() => {
      if (navigator.onLine) {
        sendHeartbeat();
      }
    }, 5 * 60 * 1000);
  }

  return { ...result, _cleanup: () => { if (intervalId != null) clearInterval(intervalId); } };
}
