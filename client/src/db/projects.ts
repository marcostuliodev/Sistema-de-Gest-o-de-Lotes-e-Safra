import { getActiveScope } from "./db";

export interface ProjectRole {
  id: string;
  name: string;
  label: string;
  system: boolean;
  permissions: string[];
  created_at?: string;
  updated_at?: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  user_key: string;
  name: string;
  email: string;
  role: string;
  role_id: string | null;
  permissions: string[];
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectRoleInput {
  name: string;
  permissions: string[];
}

export interface InviteProjectMemberInput {
  email: string;
  role_id: string;
  password?: string;
}

export const PROJECT_PERMISSION_CATALOG = [
  { key: "project.read", label: "Consultar projeto", group: "Projeto" },
  { key: "project.update", label: "Editar projeto", group: "Projeto" },
  { key: "members.read", label: "Consultar membros", group: "Membros" },
  { key: "members.manage", label: "Gerenciar membros", group: "Membros" },
  { key: "roles.read", label: "Consultar papéis", group: "Papéis" },
  { key: "roles.manage", label: "Gerenciar papéis", group: "Papéis" },
  { key: "entities.read", label: "Consultar dados", group: "Dados" },
  { key: "entities.create", label: "Criar dados", group: "Dados" },
  { key: "entities.update", label: "Editar dados", group: "Dados" },
  { key: "entities.delete", label: "Excluir dados", group: "Dados" },
  { key: "entities.delete_cascade", label: "Excluir em cascata", group: "Dados" },
  { key: "reports.read", label: "Consultar relatórios", group: "Relatórios" },
  { key: "photos.read", label: "Consultar fotos", group: "Fotos" },
  { key: "photos.write", label: "Enviar fotos", group: "Fotos" },
  { key: "ai.use", label: "Usar AgroIA", group: "IA" },
  { key: "weather.read", label: "Consultar clima", group: "Clima" },
] as const;

export const PERMISSION_CATALOG = PROJECT_PERMISSION_CATALOG;

function resolveProjectId(projectId?: string): string {
  const value = projectId || getActiveScope()?.projectId;
  if (!value) throw new Error("Projeto não selecionado");
  return value;
}

function projectPath(projectId?: string): string {
  return `/api/projects/${encodeURIComponent(resolveProjectId(projectId))}`;
}

async function request<T>(path: string, options: RequestInit, projectId?: string): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Project-Id", resolveProjectId(projectId));
  if (options.body && !(typeof FormData !== "undefined" && options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers, credentials: "include" });
  if (response.status === 401) {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("agrolote:logout"));
    throw new Error("Sessão expirada");
  }
  const data = response.status === 204
    ? undefined
    : await response.json().catch(() => undefined);
  if (!response.ok) {
    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const error = new Error(typeof payload.error === "string" ? payload.error : `Erro ${response.status}`) as Error & { code?: string; status?: number };
    error.code = typeof payload.code === "string" ? payload.code : undefined;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export async function fetchProjectRoles(projectId?: string): Promise<ProjectRole[]> {
  return request<ProjectRole[]>(`${projectPath(projectId)}/roles`, {}, projectId);
}

export async function fetchProjectMembers(projectId?: string): Promise<ProjectMember[]> {
  return request<ProjectMember[]>(`${projectPath(projectId)}/members`, {}, projectId);
}

export async function createProjectRole(projectId: string | undefined, input: ProjectRoleInput): Promise<ProjectRole> {
  return request<ProjectRole>(`${projectPath(projectId)}/roles`, {
    method: "POST",
    body: JSON.stringify(input),
  }, projectId);
}

export async function updateProjectRole(projectId: string | undefined, roleId: string, input: Partial<ProjectRoleInput>): Promise<ProjectRole> {
  return request<ProjectRole>(`${projectPath(projectId)}/roles/${encodeURIComponent(roleId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }, projectId);
}

export async function deleteProjectRole(projectId: string | undefined, roleId: string): Promise<void> {
  await request<void>(`${projectPath(projectId)}/roles/${encodeURIComponent(roleId)}`, { method: "DELETE" }, projectId);
}

export async function updateProjectMember(projectId: string | undefined, memberId: string, roleId: string): Promise<ProjectMember> {
  return request<ProjectMember>(`${projectPath(projectId)}/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role_id: roleId }),
  }, projectId);
}

export async function deleteProjectMember(projectId: string | undefined, memberId: string): Promise<void> {
  await request<void>(`${projectPath(projectId)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" }, projectId);
}

export async function inviteProjectMember(projectId: string | undefined, input: InviteProjectMemberInput): Promise<ProjectMember> {
  const body: InviteProjectMemberInput = {
    email: input.email,
    role_id: input.role_id,
    ...(input.password ? { password: input.password } : {}),
  };
  return request<ProjectMember>(`${projectPath(projectId)}/invites`, {
    method: "POST",
    body: JSON.stringify(body),
  }, projectId);
}

export const fetchRoles = fetchProjectRoles;
export const fetchMembers = fetchProjectMembers;
export const createRole = createProjectRole;
export const updateRole = updateProjectRole;
export const deleteRole = deleteProjectRole;
export const updateMember = updateProjectMember;
export const deleteMember = deleteProjectMember;
export const inviteMember = inviteProjectMember;
