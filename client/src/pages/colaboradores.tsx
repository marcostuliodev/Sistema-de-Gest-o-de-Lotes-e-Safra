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
  type Collaborator,
  type CollaboratorAccess,
} from "../db/collaborators";

export default function Colaboradores() {
  const { features } = usePlan();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [pendingInvites, setPendingInvites] = useState<CollaboratorAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "viewer">("viewer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const maxColab = features.maxColaboradores;
  const currentCount = collaborators.length;
  const canInvite = maxColab > 0 && currentCount < maxColab;

  async function loadData() {
    setLoading(true);
    try {
      const [collabs, pending] = await Promise.all([
        listCollaborators(),
        getPendingInvites(),
      ]);
      setCollaborators(collabs);
      setPendingInvites(pending);
    } catch (err) {
      console.error("Erro ao carregar colaboradores:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      await inviteCollaborator(inviteEmail, inviteRole);
      setInviteEmail("");
      setInviteRole("viewer");
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

  async function handleAccept(id: string) {
    try {
      await acceptInvite(id);
      await loadData();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDecline(id: string) {
    try {
      await declineInvite(id);
      await loadData();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  if (maxColab === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Colaboradores</h1>
          <p className="text-sm text-stone-500">Gerencie quem tem acesso aos seus dados.</p>
        </div>
        <EmptyState
          title="Colaboradores indisponivel"
          subtitle="Seu plano atual nao permite colaboradores. Faca upgrade para usar esta funcionalidade."
          action={
            <Button onClick={() => window.location.href = "/upgrade"}>
              Fazer Upgrade
            </Button>
          }
        />
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
        <div className="flex items-center gap-3">
          <span className="text-sm text-stone-500">
            {currentCount}/{maxColab} colaboradores
          </span>
          <Button onClick={() => setShowInviteModal(true)} disabled={!canInvite}>
            <Plus /> Convidar
          </Button>
        </div>
      </div>

      {/* Pending Invites */}
      {pendingInvites.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-stone-600">Convites Pendentes</h2>
          <div className="space-y-2">
            {pendingInvites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3"
              >
                <div className="flex items-center gap-3">
                  <Clock className="text-amber-600" />
                  <div>
                    <p className="text-sm font-medium text-stone-800">
                      Convite de {invite.owner_name}
                    </p>
                    <p className="text-xs text-stone-500">
                      {invite.role === "admin" ? "Acesso total" : "Somente leitura"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => handleAccept(invite.id)}
                    className="text-xs"
                  >
                    <Check /> Aceitar
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleDecline(invite.id)}
                    className="text-xs"
                  >
                    <X /> Recusar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Collaborators List */}
      {loading ? (
        <p className="text-sm text-stone-400">Carregando...</p>
      ) : collaborators.length === 0 ? (
        <EmptyState
          title="Nenhum colaborador"
          subtitle="Convide pessoas para colaborar nos seus projetos agricolas."
          action={
            <Button onClick={() => setShowInviteModal(true)} disabled={!canInvite}>
              <Plus /> Convidar Colaborador
            </Button>
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
                        <span className="font-medium text-stone-800">{collab.email}</span>
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
          <p className="text-xs text-stone-400">
            O colaborador recebera um convite e podera acessar seus dados conforme a funcao definida.
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