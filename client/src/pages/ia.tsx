/**
 * AgroIA — assistente de IA (Groq) para orquídeas e plantações.
 *
 * Abas:
 *  1. Analisar foto — upload → diagnóstico estruturado (visão computacional)
 *  2. Perguntar     — chat de texto com histórico
 *
 * Limite diário por plano (maxIaDia), exibido no topo.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Badge, TextInput, EmptyState } from "../components/ui";
import { Camera, Leaf } from "../components/icons";
import { usePlan } from "../store/plan";
import {
  analyzePhoto,
  fetchAiUsage,
  sendAiChat,
  type AiAnalysis,
  type AiChatMessage,
  type AiUsage,
} from "../db/ai";

type Tab = "foto" | "chat";

const SEVERITY_TONE: Record<string, "green" | "amber" | "red" | "gray"> = {
  baixa: "green",
  media: "amber",
  alta: "red",
};

const HEALTH_TONE: Record<string, "green" | "amber" | "red"> = {
  saudavel: "green",
  atencao: "amber",
  doente: "red",
};

const HEALTH_LABEL: Record<string, string> = {
  saudavel: "Saudável",
  atencao: "Atenção",
  doente: "Doente",
};

const SUGGESTIONS = [
  "Como regar uma Phalaenopsis corretamente?",
  "Minha orquídea não floresce, o que fazer?",
  "Quanto adubo usar em mudas de tomate?",
  "Como identificar cochonilha em orquídeas?",
  "Qual substrato usar para Cattleya?",
  "Sinais de fungo em folhas de orquídea",
];

function UsageBar({ usage }: { usage: AiUsage | null }) {
  if (!usage) return null;
  const unlimited = usage.limit >= 10000;
  const pct = unlimited ? 5 : Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100));
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-stone-200">
        <div
          className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-green-600"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-stone-500">
        {usage.used}/{unlimited ? "∞" : usage.limit} hoje
      </span>
    </div>
  );
}

function UpgradeCTA({ message }: { message: string }) {
  const navigate = useNavigate();
  const { isCollaborator } = usePlan();
  if (isCollaborator) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-stone-50 px-6 py-12 text-center">
        <div className="mb-3 text-4xl">🤖</div>
        <p className="font-semibold text-stone-700">Recurso definido pelo proprietário da conta</p>
        <p className="mt-1 max-w-sm text-sm text-stone-500">{message}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-amber-300 bg-amber-50/50 px-6 py-12 text-center">
      <div className="mb-3 text-4xl">🤖</div>
      <p className="font-semibold text-stone-700">Limite de IA atingido</p>
      <p className="mt-1 max-w-sm text-sm text-stone-500">{message}</p>
      <Button onClick={() => navigate("/upgrade")} className="mt-4">
        Ver planos
      </Button>
    </div>
  );
}

// ── Aba: analisar foto ────────────────────────────────────────────────

function AnalysisResult({ a }: { a: AiAnalysis }) {
  return (
    <div className="space-y-4">
      {a.resumo && (
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone="green">Resumo</Badge>
            {a.saude && (
              <Badge tone={HEALTH_TONE[a.saude] || "gray"}>{HEALTH_LABEL[a.saude] || a.saude}</Badge>
            )}
          </div>
          <p className="text-sm leading-relaxed text-stone-700">{a.resumo}</p>
        </Card>
      )}

      {a.identificacao?.especie && (
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone="blue">Identificação</Badge>
            {a.identificacao.confianca && (
              <Badge tone="gray">Confiança: {a.identificacao.confianca}</Badge>
            )}
          </div>
          <p className="text-sm font-medium text-stone-800">{a.identificacao.especie}</p>
        </Card>
      )}

      {(a.problemas?.length ?? 0) > 0 && (
        <Card>
          <Badge tone="amber">Problemas detectados</Badge>
          <ul className="mt-3 space-y-3">
            {a.problemas!.map((p, i) => (
              <li key={i} className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-stone-800">{p.nome}</span>
                  <Badge tone={SEVERITY_TONE[p.severidade] || "gray"}>{p.severidade}</Badge>
                </div>
                {p.descricao && (
                  <p className="mt-1 text-xs leading-relaxed text-stone-500">{p.descricao}</p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(a.cuidados?.length ?? 0) > 0 && (
        <Card>
          <Badge tone="green">Cuidados recomendados</Badge>
          <ul className="mt-3 space-y-2">
            {a.cuidados!.map((c, i) => (
              <li key={i} className="flex gap-2 text-sm text-stone-700">
                <span className="mt-0.5 text-green-600">✓</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(a.rega || a.adubacao || a.luminosidade || a.substrato) && (
        <Card>
          <Badge tone="blue">Manejo</Badge>
          <dl className="mt-3 space-y-3">
            {a.rega && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Rega</dt>
                <dd className="mt-0.5 text-sm text-stone-700">{a.rega}</dd>
              </div>
            )}
            {a.adubacao && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Adubação</dt>
                <dd className="mt-0.5 text-sm text-stone-700">{a.adubacao}</dd>
              </div>
            )}
            {a.luminosidade && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Luz</dt>
                <dd className="mt-0.5 text-sm text-stone-700">{a.luminosidade}</dd>
              </div>
            )}
            {a.substrato && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Substrato</dt>
                <dd className="mt-0.5 text-sm text-stone-700">{a.substrato}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}
    </div>
  );
}

function FotoTab({ onUsage }: { onUsage: (u: AiUsage) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  function pickFile(f: File | null | undefined) {
    setError("");
    setAnalysis(null);
    if (!f) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) {
      setError("Use JPEG, PNG ou WebP.");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setError("Imagem excede 5MB.");
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  async function handleAnalyze() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const result = await analyzePhoto(file, question);
      setAnalysis(result.analysis);
      onUsage(result.usage);
    } catch (err) {
      const e = err as Error & { upgrade?: boolean };
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-sm font-semibold text-stone-700">Foto da planta</p>

        {/* Área de preview / zona de toque */}
        <button
          type="button"
          onClick={() => (preview ? galleryRef.current?.click() : cameraRef.current?.click())}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-10 transition-colors ${
            preview
              ? "border-green-300 bg-green-50/40"
              : "border-stone-300 bg-stone-50 hover:border-green-400 hover:bg-green-50/40"
          }`}
        >
          {preview ? (
            <img src={preview} alt="Pré-visualização" className="max-h-56 rounded-xl object-contain" />
          ) : (
            <>
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-700">
                <Camera />
              </span>
              <span className="text-sm font-medium text-stone-600">Toque para tirar uma foto agora</span>
              <span className="text-xs text-stone-400">JPEG, PNG ou WebP · máx. 5MB</span>
            </>
          )}
        </button>

        {/* Ações: câmera + galeria */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="subtle" onClick={() => cameraRef.current?.click()}>
            📷 Tirar foto
          </Button>
          <Button variant="subtle" onClick={() => galleryRef.current?.click()}>
            🖼️ Galeria
          </Button>
        </div>

        {/* Input câmera — capture abre a câmera traseira direto no celular */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {/* Input galeria */}
        <input
          ref={galleryRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">
            Pergunta (opcional)
          </label>
          <TextInput
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ex.: Essa mancha é fungo? O que devo aplicar?"
            maxLength={500}
          />
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        )}

        <Button onClick={() => void handleAnalyze()} disabled={!file || busy} className="mt-4 w-full">
          {busy ? "Analisando…" : "🔍 Analisar com IA"}
        </Button>
      </Card>

      {busy && !analysis && (
        <Card>
          <div className="flex items-center gap-3 text-sm text-stone-500">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-green-600 border-t-transparent" />
            A IA está examinando a foto…
          </div>
        </Card>
      )}

      {analysis && <AnalysisResult a={analysis} />}
    </div>
  );
}

// ── Aba: chat ─────────────────────────────────────────────────────────

function ChatTab({ onUsage }: { onUsage: (u: AiUsage) => void }) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [limitReached, setLimitReached] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setError("");
    setInput("");

    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setBusy(true);
    try {
      const result = await sendAiChat(next.slice(-20));
      setMessages([...next, { role: "assistant" as const, content: result.reply }]);
      onUsage(result.usage);
    } catch (err) {
      const e = err as Error & { upgrade?: boolean };
      setError(e.message);
      if (e.upgrade) setLimitReached(e.message);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  if (limitReached) return <UpgradeCTA message={limitReached} />;

  return (
    <div className="flex h-full min-h-[50vh] sm:min-h-[420px] flex-col">
      <Card className="flex min-h-0 flex-1 flex-col !p-0">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="py-6">
              <EmptyState
                title="Pergunte ao AgroIA"
                subtitle="Orquídeas, pragas, adubação, rega, identificação de espécies e muito mais. Ou escolha uma sugestão abaixo."
              />
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600 transition-colors hover:border-green-400 hover:bg-green-50 hover:text-green-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-green-700 text-white"
                    : "bg-stone-100 text-stone-700"
                }`}
              >
                {m.role === "assistant" && (
                  <span className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-green-700">
                    <Leaf /> AgroIA
                  </span>
                )}
                {m.content}
              </div>
            </div>
          ))}

          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-stone-100 px-4 py-3 text-sm text-stone-500">
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-green-600 border-t-transparent align-middle" />
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}
          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex gap-2 border-t border-stone-200 p-3"
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Pergunte sobre orquídeas ou plantações…"
            disabled={busy}
            className="w-full flex-1 min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-stone-400 focus:border-green-600 focus:ring-2 focus:ring-green-500/30 disabled:bg-stone-50"
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            Enviar
          </Button>
        </form>
      </Card>
    </div>
  );
}

// ── Página ────────────────────────────────────────────────────────────

export default function AgroIA() {
  const [tab, setTab] = useState<Tab>("foto");
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loadError, setLoadError] = useState("");
  const navigate = useNavigate();
  const { isCollaborator } = usePlan();

  useEffect(() => {
    fetchAiUsage()
      .then(setUsage)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const atLimit =
    usage && usage.limit !== Infinity && usage.limit < 10000 && usage.used >= usage.limit;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold text-stone-800">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-green-600 to-emerald-500 text-white">
              <Leaf />
            </span>
            AgroIA
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            Assistente inteligente especialista em orquídeas e plantações — análise de fotos e dúvidas.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <UsageBar usage={usage} />
        </div>
      </div>

      {loadError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{loadError}</p>
      )}

      {/* Abas */}
      <div className="flex gap-1 rounded-xl bg-stone-100 p-1">
        {(
          [
            { id: "foto", label: "📷 Analisar foto" },
            { id: "chat", label: "💬 Perguntar" },
          ] as { id: Tab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-white text-stone-800 shadow-sm"
                : "text-stone-500 hover:text-stone-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {atLimit ? (
        <UpgradeCTA
          message={`Você usou todas as ${usage!.limit} análises de hoje. Volte amanhã ou faça upgrade para mais.`}
        />
      ) : tab === "foto" ? (
        <FotoTab onUsage={setUsage} />
      ) : (
        <ChatTab onUsage={setUsage} />
      )}

      {usage && usage.limit === 0 && !isCollaborator && (
        <Button variant="subtle" onClick={() => navigate("/upgrade")}>
          Ver planos com IA
        </Button>
      )}
    </div>
  );
}
