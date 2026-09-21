import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Field, TextInput, Form } from "../components/ui";
import { Leaf } from "../components/icons";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Erro ao enviar e-mail");
      } else {
        setDone(true);
      }
    } catch {
      setError("Erro de conexão");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-green-900 via-green-800 to-green-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-green-50">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">
            <Leaf />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight">Agrolote</h1>
          <p className="mt-1 text-sm text-green-200">Recuperação de senha</p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-2xl">
          {done ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
                Se o e-mail existir em nossa base, você receberá um link para redefinir sua senha. Verifique sua caixa de entrada e pasta de spam.
              </div>
              <Link
                to="/login"
                className="block text-center text-sm font-medium text-green-700 hover:underline"
              >
                Voltar ao login
              </Link>
            </div>
          ) : (
            <>
              <p className="mb-4 text-sm text-stone-600">
                Informe o e-mail da sua conta e enviaremos um link para redefinir sua senha.
              </p>
              <Form onSubmit={(e) => void submit(e)}>
                <Field label="E-mail" required>
                  <TextInput
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@email.com"
                    required
                  />
                </Field>
                {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
                <Button type="submit" disabled={busy} className="w-full py-2.5 text-base">
                  {busy ? "Aguarde..." : "Enviar link de recuperação"}
                </Button>
              </Form>
              <p className="mt-4 text-center text-sm text-stone-500">
                Lembrou a senha?{" "}
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
