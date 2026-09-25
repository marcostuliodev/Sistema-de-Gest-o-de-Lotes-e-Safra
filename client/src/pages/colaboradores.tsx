import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useProject } from "../store/project";
import { Badge, Button, Card, EmptyState, Field, Form, Modal, Select, TextInput } from "../components/ui";
import { Check, Clock, Mail, Plus, Trash, Users, X } from "../components/icons";
import {
  PROJECT_PERMISSION_CATALOG,
  createProjectRole,
  deleteProjectMember,
  deleteProjectRole,
  fetchProjectMembers,
  fetchProjectRoles,
  inviteProjectMember,
  updateProjectMember,
  type ProjectMember,
  type ProjectRole,
} from "../db/projects";
import {
  acceptInvite,
  declineInvite,
  getPendingInvites,
  type CollaboratorAccess,
} from "../db/collaborators";

const EDIT_PERMISSIONS = new Set([
  "entities.create",
  "entities.update",
  "entities.delete",
  "entities.delete_cascade",
  "project.update",
  "members.manage",
  "roles.manage",
  "photos.write",
]);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function roleName(roleId: string | null | undefined, fallback?: string | null): string {
  const normalized = String(roleId || "").toLowerCase();
  if (normalized === "owner") return "Proprietário";
  if (normalized === "editor") return "Editor";
  if (normalized === "viewer") return "Visualizador";
  return fallback || roleId || "Sem papel";
}

function permissionName(permission: string): string {
  return PROJECT_PERMISSION_CATALOG.find((item) => item.key === permission)?.label || permission;
}

function hasEditPermission(permissions: string[]): boolean {
  return permissions.some((permission) => EDIT_PERMISSIONS.has(permission));
}

function isOwnerRole(roleId: string | null | undefined): boolean {
  return String(roleId || "").toLowerCase() === "owner";
}

function EffectivePermissions({ permissions }: { permissions: string[] }) {
  const unique = Array.from(new Set(permissions));
  return (
    <div className="mt-3 rounded-xl border border-stone-100 bg-stone-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Permissões efetivas</p>
      {unique.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500">Nenhuma permissão concedida.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {unique.map((permission) => (
            <span key={permission} className="inline-flex max-w-full items-center gap-1 rounded-md bg-white px-2 py-1 text-xs text-stone-600 ring-1 ring-stone-200">
              <Check className="shrink-0 text-green-600" />
              <span className="truncate">{permissionName(permission)}</span>
              <span className="text-[10px] text-stone-400">{permission}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionCheckboxes({ selected, onToggle }: {
  selected: string[];
  onToggle: (permission: string) => void;
}) {
  const groups = Array.from(new Set(PROJECT_PERMISSION_CATALOG.map((item) => item.group)));
  return (
    <fieldset className="rounded-xl border border-stone-200 p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Permissões do papel</legend>
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="mb-2 text-xs font-semibold text-stone-700">{group}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {PROJECT_PERMISSION_CATALOG.filter((item) => item.group === group).map((item) => (
                <label key={item.key} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-stone-100 px-2.5 py-2 text-sm text-stone-700 hover:bg-stone-50">
                  <input
                    type="checkbox"
                    checked={selected.includes(item.key)}
                    onChange={() => onToggle(item.key)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-green-700"
                  />
                  <span className="min-w-0">
                    <span className="block">{item.label}</span>
                    <span className="block text-[10px] text-stone-400">{item.key}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function LegacyInvitesCard({ invites, showActions, busyId, onAccept, onDecline }: {
  invites: CollaboratorAccess[];
  showActions: boolean;
  busyId: string | null;
  onAccept: (invite: CollaboratorAccess) => void;
  onDecline: (invite: CollaboratorAccess) => void;
}) {
  if (invites.length === 0) return null;
  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <div className="mb-3 flex items-center gap-2">
        <Clock className="text-amber-600" />
        <h2 className="text-sm font-semibold text-stone-700">Convites legados pendentes</h2>
      </div>
      <p className="mb-3 text-xs text-amber-800">
        Convites antigos continuam sendo compatíveis. Novos acessos usam os membros do projeto ativo.
      </p>
      <div className="space-y-2">
        {invites.map((invite) => (
          <div key={invite.id} className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Mail className="shrink-0 text-amber-600" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-stone-800">{invite.owner_name || "Convite"}</p>
                <p className="truncate text-xs text-stone-500">
                  {invite.owner_email || "Conta proprietária"} · {roleName(invite.role)}
                </p>
              </div>
            </div>
            {showActions && (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" className="text-xs" disabled={busyId === invite.id} onClick={() => onAccept(invite)}>
                  <Check /> Aceitar
                </Button>
                <Button variant="subtle" className="text-xs" disabled={busyId === invite.id} onClick={() => onDecline(invite)}>
                  <X /> Recusar
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Colaboradores() {
  const { activeProject, projects, isOwner, switchProject, switching } = useProject();
  const canManage = isOwner;
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [legacyInvites, setLegacyInvites] = useState<CollaboratorAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [roleNameValue, setRoleNameValue] = useState("");
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const projectId = activeProject?.id;
  const assignableRoles = useMemo(() => roles.filter((role) => !isOwnerRole(role.id)), [roles]);

  async function loadData() {
    if (!projectId) return;
    setLoading(true);
    setDataError("");
    setRoles([]);
    setMembers([]);
    if (canManage) {
      try {
        const [loadedRoles, loadedMembers] = await Promise.all([
          fetchProjectRoles(projectId),
          fetchProjectMembers(projectId),
        ]);
        setRoles(loadedRoles);
        setMembers(loadedMembers);
      } catch (error) {
        setDataError(errorMessage(error, "Não foi possível carregar membros e papéis."));
      }
    }
    setLoading(false);
    try {
      const pending = await getPendingInvites();
      setLegacyInvites(Array.isArray(pending) ? pending : []);
    } catch {
      setLegacyInvites([]);
    }
  }

  useEffect(() => {
    void loadData();
  }, [projectId, isOwner]);

  function openInviteModal() {
    setActionError("");
    setNotice("");
    setInviteEmail("");
    setInvitePassword("");
    setInviteRoleId(assignableRoles.find((role) => role.id === "viewer")?.id || assignableRoles[0]?.id || "");
    setShowInviteModal(true);
  }

  function openRoleModal() {
    setActionError("");
    setNotice("");
    setRoleNameValue("");
    setRolePermissions([]);
    setShowRoleModal(true);
  }

  async function handleMemberRoleChange(member: ProjectMember, roleId: string) {
    if (!projectId || isOwnerRole(member.role_id) || !assignableRoles.some((role) => role.id === roleId)) return;
    setBusyMemberId(member.id);
    setActionError("");
    setNotice("");
    try {
      await updateProjectMember(projectId, member.id, roleId);
      setNotice("Papel atualizado.");
      await loadData();
    } catch (error) {
      setActionError(errorMessage(error, "Não foi possível atualizar o papel."));
    } finally {
      setBusyMemberId(null);
    }
  }

  async function handleRemoveMember(member: ProjectMember) {
    if (!projectId || isOwnerRole(member.role_id)) return;
    if (!window.confirm(`Remover ${member.name || member.email || "este membro"} do projeto?`)) return;
    setBusyMemberId(member.id);
    setActionError("");
    setNotice("");
    try {
      await deleteProjectMember(projectId, member.id);
      setNotice("Membro removido do projeto.");
      await loadData();
    } catch (error) {
      setActionError(errorMessage(error, "Não foi possível remover o membro."));
    } finally {
      setBusyMemberId(null);
    }
  }

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !inviteRoleId || !assignableRoles.some((role) => role.id === inviteRoleId)) {
      setActionError("Selecione um papel válido.");
      return;
    }
    setSaving(true);
    setActionError("");
    setNotice("");
    try {
      await inviteProjectMember(projectId, {
        email: inviteEmail.trim(),
        role_id: inviteRoleId,
        ...(invitePassword ? { password: invitePassword } : {}),
      });
      setShowInviteModal(false);
      setInviteEmail("");
      setInvitePassword("");
      setNotice("Membro adicionado ao projeto.");
      await loadData();
    } catch (error) {
      setActionError(errorMessage(error, "Não foi possível adicionar o membro."));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateRole(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !roleNameValue.trim() || rolePermissions.length === 0) {
      setActionError("Informe o nome e escolha ao menos uma permissão.");
      return;
    }
    setSaving(true);
    setActionError("");
    setNotice("");
    try {
      const permissions = rolePermissions.filter((permission) => PROJECT_PERMISSION_CATALOG.some((item) => item.key === permission));
      await createProjectRole(projectId, { name: roleNameValue.trim(), permissions });
      setShowRoleModal(false);
      setRoleNameValue("");
      setRolePermissions([]);
      setNotice("Papel customizado criado.");
      await loadData();
    } catch (error) {
      setActionError(errorMessage(error, "Não foi possível criar o papel."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRole(role: ProjectRole) {
    if (!projectId || role.system) return;
    if (!window.confirm(`Excluir o papel ${role.label || role.name}?`)) return;
    setBusyRoleId(role.id);
    setActionError("");
    setNotice("");
    try {
      await deleteProjectRole(projectId, role.id);
      setNotice("Papel excluído.");
      await loadData();
    } catch (error) {
      setActionError(errorMessage(error, "Não foi possível excluir o papel."));
    } finally {
      setBusyRoleId(null);
    }
  }

  async function handleAcceptLegacy(invite: CollaboratorAccess) {
    setBusyInviteId(invite.id);
    setActionError("");
    setNotice("");
    try {
      await acceptInvite(invite.id, invite.token);
      setNotice("Convite legado aceito.");
      await loadData();
    } catch (error) {
      setActionError(errorMessage(error, "Não foi possível aceitar o convite."));
    } finally {
      setBusyInviteId(null);
    }
  }

  async function handleDeclineLegacy(invite: CollaboratorAccess) {
    setBusyInviteId(invite.id);
    setActionError("");
    setNotice("");
    try {
      await declineInvite(invite.id, invite.token);
      setNotice("Convite legado recusado.");
      await loadData();
    } catch (error) {
      setActionError(errorMessage(error, "Não foi possível recusar o convite."));
    } finally {
      setBusyInviteId(null);
    }
  }

  if (!activeProject) {
    return <p className="text-sm text-stone-500">Selecione um projeto para visualizar as colaborações.</p>;
  }

  const activeRoleName = roleName(activeProject.role_id, activeProject.role);
  const activeCanEdit = hasEditPermission(activeProject.permissions);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-stone-800">Colaboradores e membros</h1>
          <p className="mt-1 text-sm text-stone-500">
            {isOwner ? "Gerencie quem pode acessar o projeto ativo." : "Veja seu papel e as permissões efetivas no projeto ativo."}
          </p>
          <p className="mt-1 truncate text-xs text-stone-400">Projeto: {activeProject.name || activeProject.nome}</p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="subtle" onClick={openRoleModal} disabled={loading}>
              <Plus /> Criar papel
            </Button>
            <Button onClick={openInviteModal} disabled={loading || assignableRoles.length === 0}>
              <Mail /> Convidar
            </Button>
          </div>
        )}
      </div>

      {notice && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</div>}
      {(actionError || dataError) && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {actionError || dataError}
        </div>
      )}

      <LegacyInvitesCard
        invites={legacyInvites}
        showActions
        busyId={busyInviteId}
        onAccept={(invite) => void handleAcceptLegacy(invite)}
        onDecline={(invite) => void handleDeclineLegacy(invite)}
      />

      {canManage ? (
        <>
          <Card className="border-blue-200 bg-blue-50/50">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Projeto ativo</p>
                <p className="mt-1 font-semibold text-stone-800">{activeProject.name || activeProject.nome}</p>
                <p className="mt-1 text-xs text-stone-500">Você é o owner deste projeto. As alterações abaixo são validadas pelo servidor.</p>
              </div>
              <Badge tone="blue">Owner</Badge>
            </div>
          </Card>

          {loading ? (
            <p className="text-sm text-stone-400">Carregando membros...</p>
          ) : members.length === 0 ? (
            <EmptyState
              title="Nenhum membro"
              subtitle="Crie um papel ou convide uma pessoa para o projeto ativo."
              action={<Button onClick={openInviteModal} disabled={assignableRoles.length === 0}><Mail /> Convidar membro</Button>}
            />
          ) : (
            <Card className="overflow-hidden p-0">
              <div className="divide-y divide-stone-100">
                {members.map((member) => {
                  const memberOwner = isOwnerRole(member.role_id);
                  const currentRole = roles.find((role) => role.id === member.role_id);
                  return (
                    <div key={member.id} className="p-4 sm:p-5">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
                          <Users />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-stone-800">{member.name || "Membro do projeto"}</p>
                          <p className="truncate text-sm text-stone-500">{member.email || "E-mail não informado"}</p>
                        </div>
                        <Badge tone={member.status === "active" ? "green" : "amber"}>
                          {member.status === "active" ? "Ativo" : member.status || "Pendente"}
                        </Badge>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <Field label="Papel efetivo" required>
                          <Select
                            value={member.role_id || ""}
                            disabled={memberOwner || busyMemberId === member.id || assignableRoles.length === 0}
                            onChange={(event) => void handleMemberRoleChange(member, event.target.value)}
                          >
                            {memberOwner && <option value={member.role_id || ""}>Proprietário (fixo)</option>}
                            {!memberOwner && !currentRole && <option value={member.role_id || ""}>Papel não encontrado</option>}
                            {assignableRoles.map((role) => (
                              <option key={role.id} value={role.id}>{role.label || role.name}</option>
                            ))}
                          </Select>
                        </Field>
                        {!memberOwner && (
                          <Button variant="danger" onClick={() => void handleRemoveMember(member)} disabled={busyMemberId === member.id}>
                            <Trash /> Remover
                          </Button>
                        )}
                      </div>
                      <EffectivePermissions permissions={member.permissions} />
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-stone-800">Papéis do projeto</h2>
                <p className="mt-1 text-sm text-stone-500">Os papéis e IDs abaixo vieram do servidor.</p>
              </div>
              <Badge tone="gray">{roles.length} papéis</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {roles.map((role) => (
                <div key={role.id} className="rounded-xl border border-stone-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-stone-800">{role.label || role.name}</p>
                      <p className="mt-0.5 text-xs text-stone-400">{role.permissions.length} permissões</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {role.system ? <Badge tone="gray">Sistema</Badge> : (
                        <Button variant="danger" className="px-2" title="Excluir papel" disabled={busyRoleId === role.id} onClick={() => void handleDeleteRole(role)}>
                          <Trash />
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {role.permissions.slice(0, 6).map((permission) => (
                      <span key={permission} className="rounded-md bg-stone-100 px-2 py-1 text-[11px] text-stone-600">{permissionName(permission)}</span>
                    ))}
                    {role.permissions.length > 6 && <span className="rounded-md bg-stone-100 px-2 py-1 text-[11px] text-stone-500">+{role.permissions.length - 6}</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : (
        <>
          <Card className={activeCanEdit ? "border-blue-200 bg-blue-50/40" : "border-stone-200 bg-stone-50"}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Seu papel neste projeto</p>
                <h2 className="mt-1 text-lg font-bold text-stone-800">{activeRoleName}</h2>
                <p className="mt-1 text-xs text-stone-500">ID do papel: {activeProject.role_id || "não informado"}</p>
              </div>
              <Badge tone={activeCanEdit ? "blue" : "gray"}>{activeCanEdit ? "Edição permitida" : "Somente leitura"}</Badge>
            </div>
            <EffectivePermissions permissions={activeProject.permissions} />
            <p className="mt-3 text-sm text-stone-600">
              {activeCanEdit
                ? "As permissões acima são as permissões efetivas neste projeto. O servidor também valida cada alteração."
                : "Viewers e papéis somente leitura não editam dados. Alterações, exclusões e convites permanecem indisponíveis."}
            </p>
            <p className="mt-2 text-xs text-stone-500">Você não pode gerenciar membros, papéis ou convites enquanto for colaborador.</p>
          </Card>

          <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <Mail className="mt-0.5 shrink-0" />
            <p>
              Se você já tinha conta no Agrolote, entre com seu e-mail e a senha atual. Esta etapa não redefine senha, não gera token e não exige aceite de convite.
            </p>
          </div>

          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-stone-800">Projetos com acesso</h2>
                <p className="mt-1 text-sm text-stone-500">Selecione um projeto para trocar o contexto ativo.</p>
              </div>
              <Badge tone="green">{projects.length} projetos</Badge>
            </div>
            <div className="space-y-2">
              {projects.map((project) => {
                const active = project.id === activeProject.id;
                return (
                  <button
                    key={project.id}
                    type="button"
                    disabled={switching}
                    onClick={() => void switchProject(project.id)}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors ${active ? "border-green-300 bg-green-50" : "border-stone-200 bg-white hover:bg-stone-50"}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-stone-800">{project.name || project.nome}</span>
                      <span className="mt-1 block text-xs text-stone-500">{roleName(project.role_id, project.role)}</span>
                    </span>
                    {active ? <Badge tone="green">Ativo</Badge> : <span className="shrink-0 text-xs text-stone-400">Abrir</span>}
                  </button>
                );
              })}
            </div>
          </Card>
        </>
      )}

      <Modal open={showInviteModal} onClose={() => setShowInviteModal(false)} title="Convidar membro">
        <Form onSubmit={(event) => void handleInvite(event)}>
          <Field label="E-mail" required>
            <TextInput type="email" autoComplete="email" placeholder="email@exemplo.com" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required />
          </Field>
          <Field label="Papel efetivo" required>
            <Select value={inviteRoleId} onChange={(event) => setInviteRoleId(event.target.value)} required>
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.id}>{role.label || role.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Senha inicial" hint="Obrigatória para uma conta nova, com no mínimo 8 caracteres.">
            <TextInput type="password" autoComplete="new-password" minLength={8} value={invitePassword} onChange={(event) => setInvitePassword(event.target.value)} />
          </Field>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
            Se a conta já estiver cadastrada, a senha atual continua valendo. Esta etapa não altera senha, não gera token e não envia link de convite. Para uma conta nova, a senha informada será a senha inicial de login.
          </div>
          {actionError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="subtle" onClick={() => setShowInviteModal(false)}>Cancelar</Button>
            <Button type="submit" disabled={saving || assignableRoles.length === 0}>{saving ? "Adicionando..." : "Adicionar membro"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={showRoleModal} onClose={() => setShowRoleModal(false)} title="Criar papel customizado" wide>
        <Form onSubmit={(event) => void handleCreateRole(event)}>
          <Field label="Nome do papel" required>
            <TextInput value={roleNameValue} onChange={(event) => setRoleNameValue(event.target.value)} placeholder="Ex.: Operacional de campo" maxLength={120} required />
          </Field>
          <PermissionCheckboxes
            selected={rolePermissions}
            onToggle={(permission) => setRolePermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission])}
          />
          {actionError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="subtle" onClick={() => setShowRoleModal(false)}>Cancelar</Button>
            <Button type="submit" disabled={saving}>{saving ? "Criando..." : "Criar papel"}</Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
