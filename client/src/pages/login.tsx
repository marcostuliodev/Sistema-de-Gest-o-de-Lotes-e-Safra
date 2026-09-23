import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../store/auth";
import { Button, Field, TextInput, Form } from "../components/ui";
import { Leaf, WifiOff } from "../components/icons";

export default function Login() {
  const { login, register, resendVerification } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        const result = await register(name, email, password);
        if (result && result.user && result.user.email_verified === false) {
          setRegisteredEmail(email);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResendVerification() {
    if (!registeredEmail) return;
    setResendBusy(true);
    setResendMsg("");
    try {
      const data = await resendVerification(registeredEmail);
      setResendMsg(data.message);
    } catch {
      setResendMsg("Erro ao reenviar. Tente novamente.");
    } finally {
      setResendBusy(false);
    }
  }

  // Show verification sent state after registration
  if (registeredEmail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-green-900 via-green-800 to-green-900 p-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center text-green-50">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-3xl">
              <Leaf />
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight">Agrolote</h1>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-2xl">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl text-green-600">✉</div>
              <h2 className="text-lg font-bold text-stone-800">Confirme seu e-mail</h2>
              <p className="mt-2 text-sm text-stone-500">
                Enviamos um link de confirmação para:
              </p>
              <p className="mt-1 break-all text-sm font-medium text-stone-700">{registeredEmail}</p>

              {resendMsg && (
                <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{resendMsg}</p>
              )}

              <div className="mt-6 space-y-3">
                <Button
                  onClick={() => void handleResendVerification()}
                  disabled={resendBusy}
                  className="w-full"
                  variant="subtle"
                >
                  {resendBusy ? "Reenviando..." : "Reenviar confirmação"}
                </Button>
                <button
                  type="button"
                  onClick={() => { setRegisteredEmail(null); setMode("login"); }}
                  className="w-full text-center text-xs font-medium text-green-700 hover:underline"
                >
                  Voltar ao login
                </button>
              </div>
            </div>
          </div>

          <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-green-200">
            <WifiOff /> Funciona offline — seus dados são salvos no aparelho e sincronizados quando houver conexão.
          </p>
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
          <p className="mt-1 text-sm text-green-200">Planeje safras e controle custos mesmo sem internet.</p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-2xl">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 text-sm font-medium">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(""); }}
                className={`rounded-lg px-3 py-1.5 transition-colors ${mode === m ? "bg-white text-green-800 shadow-sm" : "text-stone-500"}`}
              >
                {m === "login" ? "Entrar" : "Criar conta"}
              </button>
            ))}
          </div>

          <Form onSubmit={(e) => void submit(e)}>
            {mode === "register" && (
              <Field label="Seu nome" required>
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: João Produtor" required />
              </Field>
            )}
            <Field label="E-mail" required>
              <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com" required />
            </Field>
            <Field label="Senha" required hint={mode === "register" ? "Mínimo 6 caracteres" : undefined}>
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" required />
            </Field>
            {mode === "login" && (
              <div className="flex justify-end">
                <Link to="/forgot-password" className="text-xs font-medium text-green-700 hover:underline">
                  Esqueceu a senha?
                </Link>
              </div>
            )}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full py-2.5 text-base">
              {busy ? "Aguarde..." : mode === "login" ? "Entrar" : "Criar conta"}
            </Button>
          </Form>

          {mode === "login" && (
            <button
              type="button"
              onClick={async () => {
                setEmail("demo@agrolote.app");
                setPassword("demo123");
                setBusy(true);
                setError("");
                try {
                  await login("demo@agrolote.app", "demo123");
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="mt-4 w-full rounded-lg border border-dashed border-green-300 bg-green-50 py-2 text-xs font-medium text-green-700 hover:bg-green-100"
            >
              {busy ? "Aguarde..." : "Usar conta demo (demo@agrolote.app)"}
            </button>
          )}
        </div>

        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-green-200">
          <WifiOff /> Funciona offline — seus dados são salvos no aparelho e sincronizados quando houver conexão.
        </p>
      </div>
    </div>
  );
}