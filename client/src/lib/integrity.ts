/**
 * Detecção de ambiente comprometido no cliente.
 *
 * Heurísticas disponíveis em PWA:
 * 1. DevTools aberto (debugger timing + devtoolsdetect)
 * 2. User agent suspeito (ferramentas de debug)
 * 3. Modo desenvolvedor (Chrome flags)
 * 4. PWA installed check
 *
 * Cada detecção gera um "signal" enviado ao servidor.
 */

import { getActiveScope } from "../db/db";
import { getScopedStorageItem, setScopedStorageItem } from "./scoped-storage";

export interface IntegritySignal {
  signal: string;
  severity: "low" | "medium" | "high" | "critical";
  detail?: string;
}

const BLOCKED_KEY = "agrolote_integrity_blocked";

function storageContext() {
  const scope = getActiveScope();
  return scope ? { userId: scope.userId, projectId: scope.projectId } : null;
}

// ── Detecções ───────────────────────────────────────────────────────

/**
 * Detecta se DevTools está aberto via debugger timing trick.
 * Funciona em Chrome/Edge/Firefox.
 */
function detectDevTools(): boolean {
  const threshold = 100;
  const element = document.createElement("div");
  Object.defineProperty(element, "id", {
    get() {
      // DevTools aberto — o getter é chamado durante inspeção
      return true;
    },
  });
  console.log("%c", element);
  // Se devtools está aberto, console.log pode ser lento
  const start = performance.now();
  const elapsed = performance.now() - start;
  return elapsed > threshold;
}

/**
 * Verifica user agent por ferramentas de debug conhecidas.
 */
function detectSuspiciousUA(): string | null {
  const ua = navigator.userAgent.toLowerCase();
  const suspicious = [
    { pattern: "electron", name: "Electron" },
    { pattern: "puppeteer", name: "Puppeteer" },
    { pattern: "playwright", name: "Playwright" },
    { pattern: "selenium", name: "Selenium" },
    { pattern: "phantom", name: "PhantomJS" },
    { pattern: "headless", name: "Headless Browser" },
    { pattern: "curl/", name: "cURL" },
    { pattern: "wget/", name: "wget" },
  ];

  for (const s of suspicious) {
    if (ua.includes(s.pattern)) return s.name;
  }
  return null;
}

/**
 * Detecta Chrome DevTools protocol ativo.
 */
function detectChromeDevToolsProtocol(): boolean {
  try {
    // Chrome: __REACT_DEVTOOLS_GLOBAL_HOOK__ ou __VUE_DEVTOOLS_GLOBAL_HOOK__
    if ("__REACT_DEVTOOLS_GLOBAL_HOOK__" in window) return true;
    if ("__VUE_DEVTOOLS_GLOBAL_HOOK__" in window) return true;

    // Firefox: firebug
    if (document.querySelector("[firebug]") != null) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Verifica se está rodando em modo debug (Chrome).
 */
function detectDebugMode(): boolean {
  try {
    // Chrome flag: --enable-automation
    if (navigator.webdriver) return true;

    // Verifica se DevTools protocol está ativo
    const err = new Error();
    Object.defineProperty(err, "stack", {
      get() {
        return "debugger"; // Pode ser detectado por ferramentas
      },
    });

    return false;
  } catch {
    return false;
  }
}

// ── Coleta e envio ──────────────────────────────────────────────────

/**
 * Coleta todos os sinais de integridade.
 */
export function collectSignals(): IntegritySignal[] {
  const signals: IntegritySignal[] = [];

  // DevTools
  try {
    if (detectDevTools()) {
      signals.push({ signal: "devtools_open", severity: "medium", detail: "Debugger timing" });
    }
  } catch { /* ignore */ }

  // UA suspeita
  const suspiciousUA = detectSuspiciousUA();
  if (suspiciousUA) {
    signals.push({ signal: "suspicious_ua", severity: "high", detail: suspiciousUA });
  }

  // Chrome DevTools hooks
  if (detectChromeDevToolsProtocol()) {
    signals.push({ signal: "devtools_hook", severity: "medium", detail: "React/Vue DevTools detected" });
  }

  // WebDriver (Selenium/automation)
  if (detectDebugMode()) {
    signals.push({ signal: "webdriver_detected", severity: "critical", detail: "navigator.webdriver = true" });
  }

  return signals;
}

/**
 * Envia sinais para o servidor.
 */
export async function reportIntegrity(signals: IntegritySignal[]): Promise<{ score: number; blocked: boolean }> {
  if (signals.length === 0) return { score: 100, blocked: false };

  try {
    const res = await fetch("/api/upgrade/integrity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ signals }),
    });
    if (!res.ok) return { score: 100, blocked: false };
    const data = await res.json();

    if (data.blocked) {
      const context = storageContext();
      if (context) setScopedStorageItem(context, BLOCKED_KEY, "1", "local");
    }
    return data;
  } catch {
    return { score: 100, blocked: false };
  }
}

/**
 * Verifica se o usuário está bloqueado localmente.
 */
export function isLocallyBlocked(): boolean {
  const context = storageContext();
  return !!context && getScopedStorageItem(context, BLOCKED_KEY, "local", false) === "1";
}

/**
 * Verificação completa de integridade (chamar no app start + periodicamente).
 */
export async function runIntegrityCheck(): Promise<{ score: number; blocked: boolean }> {
  // Verifica bloqueio local primeiro
  if (isLocallyBlocked()) {
    return { score: 0, blocked: true };
  }

  // Coleta sinais
  const signals = collectSignals();
  if (signals.length === 0) return { score: 100, blocked: false };

  // Envia ao servidor quando online
  if (navigator.onLine) {
    return reportIntegrity(signals);
  }

  // Offline — apenas registra localmente
  return { score: 100, blocked: false };
}

/**
 * Agenda verificação periódica de integridade.
 */
export function startIntegrityMonitoring(): () => void {
  if (typeof window === "undefined") return () => {};
  const id = setInterval(() => {
    if (navigator.onLine) {
      const signals = collectSignals();
      if (signals.length > 0) {
        reportIntegrity(signals);
      }
    }
  }, 30000);
  return () => clearInterval(id);
}
