/**
 * API functions for collaborators management.
 */

export interface Collaborator {
  id: string;
  owner_id: string;
  user_id: string | null;
  email: string;
  role: "admin" | "viewer";
  status: "pending" | "active";
  created_at: string;
  /** Token do convite — exigido pelo servidor no accept/decline. */
  token?: string;
}

export interface CollaboratorAccess extends Collaborator {
  owner_name: string;
  owner_email: string;
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  return fetch(path, { ...options, headers, credentials: "include" });
}

export async function inviteCollaborator(email: string, role: string, password?: string): Promise<Collaborator> {
  const res = await request("/api/collaborators/invite", {
    method: "POST",
    // Senha é opcional: sem ela o servidor gera uma e envia link para o
    // colaborador definir a própria senha (a senha nunca vai por e-mail).
    body: JSON.stringify(password ? { email, role, password } : { email, role }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao convidar colaborador");
  return data;
}

export async function listCollaborators(): Promise<Collaborator[]> {
  const res = await request("/api/collaborators");
  if (!res.ok) throw new Error("Erro ao listar colaboradores");
  return res.json();
}

export async function removeCollaborator(id: string): Promise<void> {
  const res = await request(`/api/collaborators/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Erro ao remover colaborador");
  }
}

export async function acceptInvite(id: string, token?: string): Promise<void> {
  const res = await request("/api/collaborators/accept", {
    method: "POST",
    body: JSON.stringify(token ? { id, token } : { id }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao aceitar convite");
}

export async function declineInvite(id: string, token?: string): Promise<void> {
  const res = await request("/api/collaborators/decline", {
    method: "POST",
    body: JSON.stringify(token ? { id, token } : { id }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao recusar convite");
}

export async function getMyAccess(): Promise<CollaboratorAccess[]> {
  const res = await request("/api/collaborators/my-access");
  if (!res.ok) throw new Error("Erro ao carregar acessos");
  return res.json();
}

export async function getPendingInvites(): Promise<CollaboratorAccess[]> {
  const res = await request("/api/collaborators/pending");
  if (!res.ok) throw new Error("Erro ao carregar convites pendentes");
  return res.json();
}