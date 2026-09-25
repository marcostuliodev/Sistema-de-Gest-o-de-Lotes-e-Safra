import { useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * Aviso de atualização do PWA.
 * O Service Worker verifica periodicamente o deploy atual. Quando encontra
 * uma nova versão, a tela fica estável e o produtor escolhe quando atualizar.
 */
export function UpdatePrompt() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      registrationRef.current = registration ?? null;
    },
  });

  useEffect(() => {
    let disposed = false;

    // O hook do Workbox normalmente registra o SW, mas o registro explícito
    // mantém a atualização confiável em builds e evita deixar a tela presa em
    // uma versão antiga quando o hook não inicializa.
    const registerServiceWorker = async () => {
      if (!("serviceWorker" in navigator)) return;
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        if (disposed) return;
        registrationRef.current = registration;
        if (registration.waiting) setNeedRefresh(true);
        await registration.update();
        if (!disposed && registration.waiting) setNeedRefresh(true);
      } catch {
        // O hook ainda tenta registrar; em dev/server sem /sw.js isso é esperado.
      }
    };

    void registerServiceWorker();

    const checkForUpdate = () => {
      if (navigator.onLine) {
        const registration = registrationRef.current;
        if (registration) {
          void registration.update().then(() => {
            if (registration.waiting) setNeedRefresh(true);
          }).catch(() => undefined);
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };

    const intervalId = window.setInterval(checkForUpdate, 30_000);
    window.addEventListener("online", checkForUpdate);
    window.addEventListener("pageshow", checkForUpdate);
    document.addEventListener("visibilitychange", onVisibilityChange);
    checkForUpdate();

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener("online", checkForUpdate);
      window.removeEventListener("pageshow", checkForUpdate);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [setNeedRefresh]);

  if (!needRefresh) return null;

  async function applyUpdate() {
    if (applying) return;
    setApplying(true);
    setError("");

    let timeoutId: number | undefined;
    const controllerChanged = new Promise<boolean>((resolve) => {
      if (!("serviceWorker" in navigator)) {
        resolve(true);
        return;
      }
      const onControllerChange = () => {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        resolve(true);
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange, { once: true });
      timeoutId = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        resolve(false);
      }, 8_000);
    });

    try {
      // Envia o protocolo correto do Workbox e cobre registros que ainda não
      // recebem a referência do hook.
      registrationRef.current?.waiting?.postMessage({ type: "SKIP_WAITING" });
      const updateAttempt = updateServiceWorker(true).catch(() => undefined);
      await Promise.race([
        updateAttempt,
        new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
      ]);
      const changed = await controllerChanged;
      if (!changed) {
        setError("A atualização demorou. Toque em Atualizar novamente.");
        setApplying(false);
      } else {
        // Garante que a página execute o bundle novo, mesmo quando o
        // controllerchange ocorre antes de o Workbox resolver a promise.
        window.location.reload();
      }
    } catch {
      setError("Não foi possível atualizar. Tente novamente.");
      setApplying(false);
    }
  }

  return (
    <div
      className="fixed inset-x-3 top-3 z-[100] mx-auto max-w-lg rounded-2xl border border-green-200 bg-white p-4 shadow-2xl sm:left-auto sm:right-4 sm:top-4 sm:w-[390px]"
      role="alert"
      aria-live="assertive"
      aria-label="Atualização do aplicativo disponível"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-100 text-xl text-green-700" aria-hidden="true">
          !
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-stone-800">Nova versão disponível</p>
          <p className="mt-1 text-sm leading-5 text-stone-600">
            Atualize o Agrolote para usar a versão mais recente.
          </p>
          {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}
          <button
            type="button"
            onClick={() => void applyUpdate()}
            disabled={applying}
            className="mt-3 min-h-11 w-full rounded-xl bg-green-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-800 disabled:cursor-wait disabled:opacity-60"
          >
            {applying ? "Atualizando..." : "Atualizar agora"}
          </button>
        </div>
      </div>
    </div>
  );
}
