import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card } from "../components/ui";
import { fetchAlerts, fmtDay, fmtHour, type WeatherAlert } from "../db/weather";

const ALERT_ICON: Record<string, string> = {
  chuva: "🌧️",
  calor: "🔥",
  frio: "❄️",
  uv: "☀️",
  vento: "💨",
  tempestade: "⛈️",
  nublado: "☁️",
};

const SEV_TONE: Record<string, "blue" | "amber" | "red" | "gray"> = {
  low: "blue",
  medium: "amber",
  high: "red",
};

const SEV_LABEL: Record<string, string> = {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
};

export default function Historico() {
  const [items, setItems] = useState<WeatherAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setItems(await fetchAlerts());
      setError(null);
    } catch (e: any) {
      setError(e.message || "Erro ao carregar histórico");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const counts = items.reduce<Record<string, number>>((acc, a) => {
    acc[a.type] = (acc[a.type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Histórico de alertas</h1>
          <p className="text-sm text-stone-500">Todos os alertas climáticos enviados para o seu celular.</p>
        </div>
        <div className="flex gap-2">
          <Link to="/clima" className="rounded-lg px-3 py-2 text-sm font-medium text-green-700 hover:bg-stone-100">
            ← Clima
          </Link>
          <Button variant="ghost" onClick={load}>
            ↻ Atualizar
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-stone-400">Carregando…</p>
      ) : items.length === 0 ? (
        <Card>
          <p className="text-sm text-stone-500">
            Nenhum alerta enviado ainda. Ative as notificações na aba Clima e aguarde o próximo ciclo (a cada 15 min,
            ou via agendador externo).
          </p>
        </Card>
      ) : (
        <>
          {Object.keys(counts).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(counts).map(([type, n]) => (
                <span key={type} className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                  {ALERT_ICON[type] || "⚠️"} {n}
                </span>
              ))}
            </div>
          )}

          <Card>
            <ul className="divide-y divide-stone-100">
              {items.map((a, i) => (
                <li key={i} className="flex items-start gap-3 py-3">
                  <span className="text-xl">{ALERT_ICON[a.type] || "⚠️"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-stone-800">{a.title}</span>
                      <Badge tone={SEV_TONE[a.severity] || "gray"}>{SEV_LABEL[a.severity] || a.severity}</Badge>
                    </div>
                    <p className="text-sm text-stone-600">{a.body}</p>
                    {a.sent_at && (
                      <p className="mt-0.5 text-xs text-stone-400">
                        {fmtDay(a.sent_at.slice(0, 10))} às {fmtHour(a.sent_at.slice(0, 16))}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
