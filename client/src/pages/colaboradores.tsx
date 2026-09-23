import { useState, useEffect } from "react";
import { usePlan } from "../store/plan";
import { Button, Card, EmptyState, Field, Form, Modal, Select, TextInput, Badge } from "../components/ui";
import { Plus, Trash, X, Check, Clock, Mail } from "../components/icons";
import {
  inviteCollaborator,
  listCollaborators,
  removeCollaborator,
  acceptInvite,
  declineInvite,
  getPendingInvites,
  getMyAccess,
  type Collaborator,
  type CollaboratorAccess,
} from "../db/collaborators";

export default function Colaboradores() {
  const { features, isCollaborator, loading: planLoading, refresh } = usePlan();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [pendingInvites, setPendingInvites] = useState<CollaboratorAccess[]>([]);
  const [myAccess, setMyAccess] = useState<CollaboratorAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "viewer">("viewer");
  const [invitePassword, setInvitePassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const maxColab = features.maxColaboradores;
  const currentCount = collaborators.length;
  const canInvite = maxColab > 0 && currentCount < maxColab;

  async function loadData() {
    setLoading(true);
    try {
      if (isCollaborator) {
        // Colaborador: vê apenas convites pendentes e seus acessos
        const [pending, access] = await Promise.all([
          getPendingInvites(),
          getMyAccess(),
        ]);
        setPendingInvites(pending);
        setMyAccess(access);
        setCollaborators([]);
      } else {
        const [collabs, pending] = await Promise.all([
          listCollaborators(),
          getPendingInvites(),
        ]);
        setCollaborators(collabs);
        setPendingInvites(pending);
      }
    } catch (err) {
      console.error("Erro ao carregar colaboradores:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCollaborator]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      await inviteCollaborator(inviteEmail, inviteRole, invitePassword || undefined);
      setInviteEmail("");
      setInviteRole("viewer");
      setInvitePassword("");
      setShowInviteModal(false);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: string) {
    if (!confirm("Remover este colaborador?")) return;
    try {
      await removeCollaborator(id);
      await loadData();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleAccept(invite: CollaboratorAccess) {
    try {
      await acceptInvite(invite.id, invite.token);
      // Reavalia plano/isCollaborator no contexto (senão a UI continua obsoleta
      // até um reload completo da página).
      await refresh();
      await loadData();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDecline(invite: CollaboratorAccess) {
    try {
      await declineInvite(invite.id, invite.token);
      await loadData();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // Convites pendentes SEMPRE visíveis — inclusive para quem ainda não é
  // colaborador (plano free ⇒ maxColab === 0). Sem isto, o convidado nunca
  // consegue aceitar o convite e vira colaborador de fato.
  const pendingCard = pendingInvites.length > 0 ? (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-stone-600">Convites Pendentes</h2>
      <div className="space-y-2">
        {pendingInvites.map((invite) => (
          <div
            key={invite.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Clock className="shrink-0 text-amber-600" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-stone-800">
                  Convite de {invite.owner_name}
                </p>
                <p className="truncate text-xs text-stone-500">
                  {invite.role === "admin" ? "Acesso total" : "Somente leitura"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => handleAccept(invite)}
                className="text-xs"
              >
                <Check /> Aceitar
              </Button>
              <Button
                variant="ghost"
                onClick={() => handleDecline(invite)}
                className="text-xs"
              >
                <X /> Recusar
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  ) : null;

  // Espera o plano carregar — sem isto, features ainda em FREE (maxColab=0)
  // mostravam o EmptyState de "plano free" para dono de plano pago.
  if (planLoading) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Colaboradores</h1>
          <p className="text-sm text-stone-500">Gerencie quem tem acesso aos seus dados.</p>
        </div>
        <p className="text-sm text-stone-400">Carregando...</p>
      </div>
    );
  }

  // ── Visão do colaborador: convites pendentes + acessos ativos ──
  if (isCollaborator) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Colaboradores</h1>
          <p className="text-sm text-stone-500">Convites e acessos de colaboração.</p>
        </div>

        {pendingCard}

        {/* Acessos ativos */}
        {loading ? (
          <p className="text-sm text-stone-400">Carregando...</p>
        ) : myAccess.length === 0 && pendingInvites.length === 0 ? (
          <EmptyState
            title="Nenhum acesso"
            subtitle="Você ainda não foi convidado para colaborar em nenhuma conta."
          />
        ) : myAccess.length > 0 ? (
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-stone-600">Acessos Ativos</h2>
            <div className="space-y-2">
              {myAccess.map((access) => (
                <div
                  key={access.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 p-3"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Mail className="shrink-0 text-green-600" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">
                        {access.owner_name}
                      </p>
                      <p className="truncate text-xs text-stone-500">{access.owner_email}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone={access.role === "admin" ? "blue" : "gray"}>
                      {access.role === "admin" ? "Admin" : "Visualizador"}
                    </Badge>
                    <Badge tone="green">Ativo</Badge>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    );
  }

  // ── Plano free (não-colaborador): gestão de colaboradores indisponível,
  // mas os convites PENDENTES recebidos continuam visíveis/aceitáveis. ──
  if (maxColab === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Colaboradores</h1>
          <p className="text-sm text-stone-500">Gerencie quem tem acesso aos seus dados.</p>
        </div>
        {loading ? (
          <p className="text-sm text-stone-400">Carregando...</p>
        ) : (
          <>
            {pendingCard}
            {pendingInvites.length === 0 && (
              <EmptyState
                title="Colaboradores indisponivel"
                subtitle="Seu plano atual nao permite colaboradores. Faca upgrade para usar esta funcionalidade."
                action={
                  <Button onClick={() => window.location.href = "/upgrade"}>
                    Fazer Upgrade
                  </Button>
                }
              />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Colaboradores</h1>
          <p className="text-sm text-stone-500">Gerencie quem tem acesso aos seus dados.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!isCollaborator && (
            <span className="text-sm text-stone-500">
              {currentCount}/{maxColab} colaboradores
            </span>
          )}
          {!isCollaborator && (
            <Button onClick={() => setShowInviteModal(true)} disabled={!canInvite}>
              <Plus /> Convidar
            </Button>
          )}
        </div>
      </div>

      {pendingCard}

      {/* Collaborators List */}
      {loading ? (
        <p className="text-sm text-stone-400">Carregando...</p>
      ) : collaborators.length === 0 ? (
        <EmptyState
          title="Nenhum colaborador"
          subtitle="Convide pessoas para colaborar nos seus projetos agricolas."
          action={
            !isCollaborator && (
              <Button onClick={() => setShowInviteModal(true)} disabled={!canInvite}>
                <Plus /> Convidar Colaborador
              </Button>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  <th className="px-4 py-3 font-semibold">Email</th>
                  <th className="px-4 py-3 font-semibold">Funcao</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Convidado em</th>
                  <th className="px-4 py-3 text-right font-semibold">Acoes</th>
                </tr>
              </thead>
              <tbody>
                {collaborators.map((collab) => (
                  <tr key={collab.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/70">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Mail className="text-stone-400" />
                        <span className="max-w-[140px] truncate font-medium text-stone-800">{collab.email}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={collab.role === "admin" ? "blue" : "gray"}>
                        {collab.role === "admin" ? "Admin" : "Visualizador"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={collab.status === "active" ? "green" : "amber"}>
                        {collab.status === "active" ? "Ativo" : "Pendente"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-stone-500">
                      {new Date(collab.created_at).toLocaleDateString("pt-BR")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="danger"
                          onClick={() => handleRemove(collab.id)}
                          title="Remover"
                        >
                          <Trash />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Invite Modal */}
      <Modal open={showInviteModal} onClose={() => setShowInviteModal(false)} title="Convidar Colaborador">
        <Form onSubmit={(e) => void handleInvite(e)}>
          <Field label="Email do colaborador" required>
            <TextInput
              type="email"
              placeholder="email@exemplo.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
            />
          </Field>
          <Field label="Funcao" required>
            <Select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "admin" | "viewer")}
            >
              <option value="viewer">Visualizador (somente leitura)</option>
              <option value="admin">Admin (leitura e escrita)</option>
            </Select>
          </Field>
          <Field label="Senha do colaborador (opcional)" hint="Minimo 8 caracteres. Se vazio, o colaborador define a propria senha pelo link do email.">
            <TextInput
              type="password"
              placeholder="Deixe vazio para o colaborador definir"
              value={invitePassword}
              onChange={(e) => setInvitePassword(e.target.value)}
              minLength={invitePassword ? 8 : undefined}
            />
          </Field>
          <p className="text-xs text-stone-400">
            O colaborador recebera um email com o link do convite (e, para contas novas, o link para definir a propria senha).
          </p>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="subtle" onClick={() => setShowInviteModal(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Enviando..." : "Enviar Convite"}
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}