import { useEffect, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { Button, Field, TextInput, Form } from "../components/ui";
import { Leaf } from "../components/icons";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);

  useEffect(() => {
    if (!token) {
      setTokenValid(false);
      return;
    }
    fetch(`/api/auth/verify-reset-token/${token}`)
      .then((r) => r.json())
      .then((data) => setTokenValid(data.valid))
      .catch(() => setTokenValid(false));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("As senhas não coincidem");
      return;
    }
    if (password.length < 8) {
      setError("A senha deve ter pelo menos 8 caracteres");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Erro ao redefinir senha");
      } else {
        setDone(true);
        setTimeout(() => navigate("/login"), 3000);
      }
    } catch {
      setError("Erro de conexão");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-green-900 via-green-800 to-green-900 p-4">
        <div className="w-full max-w-sm text-center">
          <div className="mb-6 text-green-50">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">
              <Leaf />
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight">Agrolote</h1>
          </div>
          <div className="rounded-2xl bg-white p-6 shadow-2xl">
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              Link inválido. Solicite uma nova recuperação de senha.
            </div>
            <Link to="/forgot-password" className="mt-4 block text-sm font-medium text-green-700 hover:underline">
              Solicitar nova recuperação
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (tokenValid === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-green-900 via-green-800 to-green-900 p-4">
        <div className="w-full max-w-sm text-center">
          <div className="mb-6 text-green-50">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">
              <Leaf />
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight">Agrolote</h1>
          </div>
          <div className="rounded-2xl bg-white p-6 shadow-2xl">
            <p className="text-sm text-stone-500">Verificando token...</p>
          </div>
        </div>
      </div>
    );
  }

  if (tokenValid === false) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-green-900 via-green-800 to-green-900 p-4">
        <div className="w-full max-w-sm text-center">
          <div className="mb-6 text-green-50">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">
              <Leaf />
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight">Agrolote</h1>
          </div>
          <div className="rounded-2xl bg-white p-6 shadow-2xl">
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              Token inválido ou expirado. Solicite uma nova recuperação de senha.
            </div>
            <Link to="/forgot-password" className="mt-4 block text-sm font-medium text-green-700 hover:underline">
              Solicitar nova recuperação
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-green-900 via-green-800 to-green-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-green-50">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">
            <Leaf />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight">Agrolote</h1>
          <p className="mt-1 text-sm text-green-200">Redefinir senha</p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-2xl">
          {done ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
                Senha redefinida com sucesso! Você será redirecionado para o login em alguns segundos.
              </div>
              <Link
                to="/login"
                className="block text-center text-sm font-medium text-green-700 hover:underline"
              >
                Ir para o login agora
              </Link>
            </div>
          ) : (
            <>
              <p className="mb-4 text-sm text-stone-600">
                Crie uma nova senha para sua conta.
              </p>
              <Form onSubmit={(e) => void submit(e)}>
                <Field label="Nova senha" required hint="Mínimo 8 caracteres">
                  <TextInput
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••"
                    required
                    minLength={8}
                  />
                </Field>
                <Field label="Confirmar senha" required>
                  <TextInput
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="••••••"
                    required
                    minLength={8}
                  />
                </Field>
                {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
                <Button type="submit" disabled={busy} className="w-full py-2.5 text-base">
                  {busy ? "Aguarde..." : "Redefinir senha"}
                </Button>
              </Form>
              <p className="mt-4 text-center text-sm text-stone-500">
                <Link to="/login" className="font-medium text-green-700 hover:underline">
                  Voltar ao login
                </Link>
              </p>
            </>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-green-200">
          Funciona offline — seus dados são salvos no aparelho e sincronizados quando houver conexão.
        </p>
      </div>
    </div>
  );
}
