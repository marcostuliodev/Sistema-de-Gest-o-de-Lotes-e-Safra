import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { verifyEmail, resendVerification } from "../db/api";
import { Button, Field, TextInput, Form } from "../components/ui";
import { Leaf } from "../components/icons";

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"loading" | "success" | "error" | "idle">(
    token ? "loading" : "idle"
  );
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  useEffect(() => {
    if (!token) return;
    verifyEmail(token)
      .then((data) => {
        setStatus("success");
        setMessage(data.message);
      })
      .catch((err) => {
        setStatus("error");
        setMessage(err.message);
      });
  }, [token]);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    setResendBusy(true);
    setResendMsg("");
    try {
      const data = await resendVerification(email);
      setResendMsg(data.message);
    } catch {
      setResendMsg("Erro ao reenviar. Tente novamente.");
    } finally {
      setResendBusy(false);
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
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-2xl">
          {status === "loading" && (
            <div className="text-center">
              <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-green-600 border-t-transparent" />
              <p className="text-sm text-stone-500">Confirmando seu e-mail...</p>
            </div>
          )}

          {status === "success" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl text-green-600">✓</div>
              <h2 className="text-lg font-bold text-stone-800">Email confirmado!</h2>
              <p className="mt-2 text-sm text-stone-500">{message}</p>
              <Link to="/login">
                <Button className="mt-6 w-full">Fazer login</Button>
              </Link>
            </div>
          )}

          {status === "error" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-3xl text-red-600">✕</div>
              <h2 className="text-lg font-bold text-stone-800">Erro na confirmação</h2>
              <p className="mt-2 text-sm text-stone-500">{message}</p>
              <div className="mt-6 space-y-3">
                <Link to="/login">
                  <Button className="w-full">Voltar ao login</Button>
                </Link>
              </div>
            </div>
          )}

          {status === "idle" && (
            <div>
              <h2 className="text-center text-lg font-bold text-stone-800">Confirme seu e-mail</h2>
              <p className="mt-2 text-center text-sm text-stone-500">
                Insira seu e-mail para receber um novo link de confirmação.
              </p>
              <Form onSubmit={(e) => void handleResend(e)}>
                <Field label="E-mail" required>
                  <TextInput
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@email.com"
                    required
                  />
                </Field>
                {resendMsg && (
                  <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{resendMsg}</p>
                )}
                <Button type="submit" disabled={resendBusy} className="w-full mt-4">
                  {resendBusy ? "Enviando..." : "Enviar link de confirmação"}
                </Button>
              </Form>
              <div className="mt-4 text-center">
                <Link to="/login" className="text-xs font-medium text-green-700 hover:underline">
                  Voltar ao login
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
