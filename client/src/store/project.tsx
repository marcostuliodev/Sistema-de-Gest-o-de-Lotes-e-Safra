import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchProjects, type Project } from "../db/api";
import {
  confirmLegacyMigration,
  dismissLegacyMigration,
  getActiveScope,
  getLegacyMigrationStatus,
  setActiveScope,
} from "../db/db";
import { pullServer, runSync, startSyncWatcher } from "../db/sync";
import { getScopedStorageItem, setScopedStorageItem } from "../lib/scoped-storage";
import { unsubscribePush } from "../lib/push";
import { useAuth } from "./auth";

const ACTIVE_PROJECT_KEY = "agrolote_active_project";

interface ProjectCtx {
  projects: Project[];
  activeProject: Project | null;
  permissions: string[];
  can: (permission: string) => boolean;
  isOwner: boolean;
  switchProject: (projectId: string) => Promise<void>;
  loading: boolean;
  switching: boolean;
  error: string | null;
}

export const ProjectContext = createContext<ProjectCtx>(null as unknown as ProjectCtx);

function projectStorageScope(userId: string) {
  return { userId, projectId: null };
}

function isCurrentProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<Project>;
  return typeof project.id === "string"
    && typeof project.name === "string"
    && typeof project.nome === "string"
    && Array.isArray(project.permissions);
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
   const [legacyMigration, setLegacyMigration] = useState<Record<string, unknown> | null>(null);
   const [legacyMigrationLoaded, setLegacyMigrationLoaded] = useState(false);
   const [migratingLegacy, setMigratingLegacy] = useState(false);
  const loadId = useRef(0);

  const userId = session ? String(session.user.id) : null;

  useEffect(() => {
    const currentLoad = ++loadId.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && loadId.current === currentLoad;

    if (!session || !userId) {
      setProjects([]);
       setActiveProject(null);
        setLegacyMigration(null);
        setLegacyMigrationLoaded(false);
        setError(null);
        setLoading(false);
      void setActiveScope(null);
      return () => {
        cancelled = true;
      };
    }

     setLoading(true);
     setError(null);
     setLegacyMigrationLoaded(false);

    const load = async () => {
      try {
        const current = getActiveScope();
        if (current && current.userId !== userId) await setActiveScope(null);
        const loadedProjects = await fetchProjects();
        if (!isCurrent()) return;

        const validProjects = loadedProjects.filter(isCurrentProject);
         const storedId = getScopedStorageItem(
           projectStorageScope(userId),
           ACTIVE_PROJECT_KEY,
           "local",
           true,
         );
         const requestedProjectId = typeof window !== "undefined"
           ? new URLSearchParams(window.location.search).get("project_id")
           : null;
         const selected = validProjects.find((project) => project.id === requestedProjectId)
           || validProjects.find((project) => project.id === storedId)
           || validProjects.find((project) => project.is_default)
          || validProjects[0];
         if (!selected) throw new Error("Nenhum projeto disponível para esta conta");
         if (typeof window !== "undefined" && requestedProjectId) {
           const cleanParams = new URLSearchParams(window.location.search);
           cleanParams.delete("project_id");
           const query = cleanParams.toString();
           window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
         }

         await setActiveScope({
          userId,
          projectId: selected.id,
          accountId: session.user.user_key || userId,
        });
        if (!isCurrent()) return;
         setScopedStorageItem(projectStorageScope(userId), ACTIVE_PROJECT_KEY, selected.id, "local");
          const migration = await getLegacyMigrationStatus().catch(() => null);
          if (isCurrent()) {
            setLegacyMigration(migration?.status === "requires_confirmation" ? migration : null);
            setLegacyMigrationLoaded(true);
          }
         setProjects(validProjects);
        setActiveProject(selected);
        setLoading(false);
      } catch (loadError) {
        if (!isCurrent()) return;
        await setActiveScope(null).catch(() => undefined);
         setProjects([]);
         setActiveProject(null);
         setLegacyMigration(null);
         setLegacyMigrationLoaded(true);
         setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar o projeto");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("agrolote:project-load-error", { detail: { userId } }));
        setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [session, userId]);

  useEffect(() => {
    const onAccessRevoked = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string } | undefined>).detail;
      if (detail?.projectId && detail.projectId !== getActiveScope()?.projectId) return;
       setError("Seu acesso a este projeto foi removido. Os dados locais não serão mais exibidos.");
       void unsubscribePush().catch(() => undefined).finally(() => {
         void setActiveScope(null).finally(() => window.location.reload());
       });
    };
    window.addEventListener("agrolote:project-access-revoked", onAccessRevoked);
    return () => window.removeEventListener("agrolote:project-access-revoked", onAccessRevoked);
  }, []);

  useEffect(() => {
    if (!session || !activeProject || switching || !legacyMigrationLoaded || legacyMigration) return;
    const stopWatcher = startSyncWatcher(false);
    void pullServer().then(() => runSync());
    return stopWatcher;
  }, [session, activeProject?.id, switching, legacyMigrationLoaded, legacyMigration]);

  const switchProject = useCallback(async (projectId: string) => {
    if (!session || !userId) throw new Error("Sessão ausente");
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Projeto não encontrado");
    if (project.id === activeProject?.id) return;

    setSwitching(true);
     setError(null);
     try {
       await unsubscribePush().catch(() => undefined);
       await setActiveScope({
        userId,
        projectId: project.id,
        accountId: session.user.user_key || userId,
      });
      setScopedStorageItem(projectStorageScope(userId), ACTIVE_PROJECT_KEY, project.id, "local");
      window.location.reload();
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "Não foi possível trocar de projeto");
      setSwitching(false);
      throw switchError;
    }
  }, [activeProject?.id, projects, session, userId]);

  const can = useCallback((permission: string) => {
    return !!activeProject && (activeProject.isOwner || activeProject.permissions.includes(permission));
  }, [activeProject]);

  async function handleLegacyMigration(confirm: boolean) {
    if (!confirm) {
      await dismissLegacyMigration().catch(() => undefined);
      setLegacyMigration(null);
      return;
    }
    if (!window.confirm("Os dados locais antigos serão copiados para este projeto. Confirme que eles pertencem a esta conta.")) return;
    setMigratingLegacy(true);
    try {
      await confirmLegacyMigration();
      setLegacyMigration(null);
    } catch (migrationError) {
      setError(migrationError instanceof Error ? migrationError.message : "Não foi possível migrar os dados locais");
    } finally {
      setMigratingLegacy(false);
    }
  }

  const value = useMemo<ProjectCtx>(() => ({
    projects,
    activeProject,
    permissions: activeProject?.permissions || [],
    can,
    isOwner: activeProject?.isOwner === true,
    switchProject,
    loading,
    switching,
    error,
  }), [activeProject, can, error, loading, projects, switchProject, switching]);

  if (!session || loading || switching || !activeProject) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-stone-50 p-4">
        <div className="max-w-sm text-center">
           <p className="text-sm text-stone-500">
             {error || "Carregando projeto..."}
           </p>
           {error && (
             <button
               type="button"
               onClick={() => window.location.reload()}
               className="mt-4 rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white"
             >
               Tentar novamente
             </button>
           )}
        </div>
      </div>
    );
  }

  return (
    <ProjectContext.Provider value={value}>
      {legacyMigration && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>Dados locais antigos foram detectados, mas não foram importados por segurança.</span>
            <span className="flex shrink-0 gap-2">
              <button type="button" className="rounded-lg bg-green-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-50" disabled={migratingLegacy} onClick={() => void handleLegacyMigration(true)}>
                {migratingLegacy ? "Importando..." : "Confirmar importação"}
              </button>
              <button type="button" className="rounded-lg border border-amber-300 px-3 py-2 text-xs" disabled={migratingLegacy} onClick={() => void handleLegacyMigration(false)}>
                Agora não
              </button>
            </span>
          </div>
        </div>
      )}
      {children}
    </ProjectContext.Provider>
  );
}

export const useProject = () => useContext(ProjectContext);
