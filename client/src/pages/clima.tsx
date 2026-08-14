import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Field, TextInput } from "../components/ui";
import {
  describeWeatherCode,
  windDir,
  fmtHour,
  fmtDay,
  getLocation,
  saveLocation,
  fetchWeather,
  fetchAlerts,
  cacheWeather,
  getCachedWeather,
  type GeoResult,
  type WeatherAlert,
  type WeatherResponse,
} from "../db/weather";
import {
  isPushSupported,
  subscribePush,
  unsubscribePush,
  getExistingSubscription,
  sendTestPush,
} from "../lib/push";

type Loc = { lat: number; lon: number; city: string; tz: string };

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

export default function Clima() {
  const [loc, setLoc] = useState<Loc | null>(null);
  const [weather, setWeather] = useState<WeatherResponse["weather"] | null>(null);
  const [history, setHistory] = useState<WeatherAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [geoQuery, setGeoQuery] = useState("");
  const [geoResults, setGeoResults] = useState<GeoResult[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);

  const [pushSupported] = useState(isPushSupported());
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const l = await getLocation();
        if (l) {
          setLoc(l);
          loadWeather();
          loadHistory();
        } else {
          const cached = await getCachedWeather();
          if (cached) {
            setLoc(cached.location as Loc);
            setWeather(cached.weather);
          }
        }
      } catch (e: any) {
        setError(e.message || "Erro ao carregar clima");
      } finally {
        setLoading(false);
      }
      if (isPushSupported()) {
        setPushPermission(Notification.permission);
        const sub = await getExistingSubscription();
        setPushSubscribed(!!sub);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadWeather() {
    try {
      const resp = await fetchWeather();
      setWeather(resp.weather);
      setLoc(resp.location as Loc);
      await cacheWeather(resp);
      setError(null);
    } catch (e: any) {
      const cached = await getCachedWeather();
      if (cached) setWeather(cached.weather);
      setError(e.message || "Erro ao buscar clima");
    }
  }

  async function loadHistory() {
    try {
      setHistory(await fetchAlerts());
    } catch {
      /* ignora */
    }
  }

  async function doGeocode() {
    if (geoQuery.trim().length < 2) return;
    setGeoBusy(true);
    try {
      const res = await (await import("../db/weather")).geocode(geoQuery.trim());
      setGeoResults(res);
    } catch {
      setGeoResults([]);
    } finally {
      setGeoBusy(false);
    }
  }

  async function selectGeo(g: GeoResult) {
    setGeoResults([]);
    setGeoQuery("");
    await applyLocation({ lat: g.latitude, lon: g.longitude, city: g.label, tz: g.timezone });
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError("Geolocalização não disponível neste dispositivo");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "auto";
        await applyLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, city: "Minha localização", tz });
      },
      () => setError("Não foi possível obter sua localização")
    );
  }

  async function applyLocation(l: Loc) {
    try {
      await saveLocation(l);
      setLoc(l);
      setLoading(true);
      await loadWeather();
      loadHistory();
    } catch (e: any) {
      setError(e.message || "Erro ao salvar localização");
    } finally {
      setLoading(false);
    }
  }

  async function enablePush() {
    setPushBusy(true);
    setPushMsg(null);
    try {
      await subscribePush();
      setPushSubscribed(true);
      setPushPermission("granted");
      setPushMsg("Notificações ativadas!");
    } catch (e: any) {
      setPushMsg(e.message || "Falha ao ativar");
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePush() {
    setPushBusy(true);
    setPushMsg(null);
    try {
      await unsubscribePush();
      setPushSubscribed(false);
      setPushMsg("Notificações desativadas.");
    } catch (e: any) {
      setPushMsg(e.message || "Falha ao desativar");
    } finally {
      setPushBusy(false);
    }
  }

  async function testPush() {
    setPushBusy(true);
    setPushMsg(null);
    try {
      await sendTestPush();
      setPushMsg("Notificação de teste enviada — confira seu celular.");
    } catch (e: any) {
      setPushMsg(e.message || "Falha ao enviar teste");
    } finally {
      setPushBusy(false);
    }
  }

  if (loading && !loc) {
    return <p className="text-sm text-stone-400">Carregando clima…</p>;
  }

  if (!loc) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Clima & Alertas</h1>
          <p className="text-sm text-stone-500">Defina a localização da propriedade para acompanhar o clima e receber alertas.</p>
        </div>
        <Card>
          <Field label="Buscar cidade" hint="Digite o nome da cidade/localidade da propriedade.">
            <div className="flex gap-2">
              <TextInput
                value={geoQuery}
                onChange={(e) => setGeoQuery(e.target.value)}
                placeholder="Ex.: Cascavel, GO"
                onKeyDown={(e) => e.key === "Enter" && doGeocode()}
              />
              <Button onClick={doGeocode} disabled={geoBusy}>
                {geoBusy ? "Buscando…" : "Buscar"}
              </Button>
            </div>
          </Field>
          {geoResults.length > 0 && (
            <ul className="mt-3 divide-y divide-stone-100">
              {geoResults.map((g) => (
                <li key={`${g.latitude},${g.longitude}`}>
                  <button
                    onClick={() => selectGeo(g)}
                    className="flex w-full items-center justify-between py-2.5 text-left hover:text-green-700"
                  >
                    <span className="font-medium text-stone-800">{g.label}</span>
                    <span className="text-xs text-stone-400">{g.timezone}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t border-stone-100 pt-4">
            <Button variant="subtle" onClick={useMyLocation}>
              📍 Usar minha localização atual
            </Button>
          </div>
        </Card>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  const cur = weather?.current;
  const today = weather?.daily?.[0];
  const code = cur ? describeWeatherCode(cur.weather_code) : null;
  const tzOffset = weather?.location.utc_offset_seconds ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800">Clima & Alertas</h1>
          <p className="text-sm text-stone-500">{loc.city || "Sua propriedade"}</p>
        </div>
        <Button variant="ghost" onClick={loadWeather}>
          ↻ Atualizar
        </Button>
      </div>

      {error && <p className="text-sm text-amber-600">{error}</p>}

      {/* Atual */}
      {cur && code && (
        <Card className="bg-gradient-to-br from-green-50 to-emerald-50">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-stone-500">{code.label}</p>
              <p className="text-5xl font-extrabold text-stone-800">
                {cur.temperature_2m.toFixed(0)}°C
              </p>
              <p className="text-sm text-stone-500">Sensação {cur.apparent_temperature.toFixed(0)}°C</p>
            </div>
            <div className="text-7xl">{code.icon}</div>
          </div>
        </Card>
      )}

      {/* Detalhes */}
      {cur && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Detail label="Umidade" value={`${cur.relative_humidity_2m}%`} />
          <Detail label="Vento" value={`${cur.wind_speed_10m.toFixed(0)} km/h ${windDir(cur.wind_direction_10m)}`} />
          <Detail label="Rajadas" value={`${cur.wind_gusts_10m.toFixed(0)} km/h`} />
          <Detail label="Pressão" value={`${cur.pressure_msl.toFixed(0)} hPa`} />
          <Detail label="Nebulosidade" value={`${cur.cloud_cover}%`} />
          <Detail label="UV" value={`${cur.uv_index ?? "—"}`} />
          <Detail label="Chuva agora" value={`${cur.precipitation.toFixed(1)} mm`} />
          <Detail label="Sol" value={`↑${fmtHour(today?.sunrise || "", tzOffset)} ↓${fmtHour(today?.sunset || "", tzOffset)}`} />
        </div>
      )}

      {/* Gráfico de temperatura/UV (24h) */}
      {weather && weather.hourly.length > 0 && (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-bold text-stone-800">Temperatura e UV — 24h</h2>
            <div className="flex items-center gap-3 text-xs text-stone-500">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 rounded-full bg-green-600" /> Temp
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 rounded-full bg-amber-500" /> UV
              </span>
            </div>
          </div>
          <WeatherChart hourly={weather.hourly} offset={tzOffset} />
        </Card>
      )}

      {/* Alertas atuais */}
      {weather && weather.alerts.length > 0 && (
        <Card>
          <h2 className="mb-3 font-bold text-stone-800">Alertas agora</h2>
          <ul className="space-y-2">
            {weather.alerts.map((a, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl bg-stone-50 p-3">
                <span className="text-xl">{ALERT_ICON[a.type] || "⚠️"}</span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-stone-800">{a.title}</span>
                    <Badge tone={SEV_TONE[a.severity]}>{a.severity}</Badge>
                  </div>
                  <p className="text-sm text-stone-600">{a.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Notificações */}
      <Card>
        <h2 className="mb-2 font-bold text-stone-800">Notificações no celular</h2>
        {!pushSupported ? (
          <p className="text-sm text-stone-500">
            Este navegador não suporta notificações push. Instale o app (ícone de instalação) em um celular com Chrome/Edge ou
            iOS 16.4+ para receber alertas.
          </p>
        ) : pushPermission === "denied" ? (
          <p className="text-sm text-red-600">
            Notificações bloqueadas no navegador. Habilite nas configurações do site e recarregue.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-stone-600">
              {pushSubscribed
                ? "Ativas! Você receberá alertas de chuva, calor, frio, UV, vento e tempestade mesmo com o app fechado."
                : "Ative para receber alertas climáticos no seu celular."}
            </p>
            <div className="flex flex-wrap gap-2">
              {!pushSubscribed ? (
                <Button onClick={enablePush} disabled={pushBusy}>
                  {pushBusy ? "Ativando…" : "Ativar notificações"}
                </Button>
              ) : (
                <>
                  <Button variant="subtle" onClick={testPush} disabled={pushBusy}>
                    Enviar teste
                  </Button>
                  <Button variant="danger" onClick={disablePush} disabled={pushBusy}>
                    Desativar
                  </Button>
                </>
              )}
            </div>
            {pushMsg && <p className="text-sm text-green-700">{pushMsg}</p>}
          </div>
        )}
      </Card>

      {/* Previsão por hora */}
      {weather && weather.hourly.length > 0 && (
        <Card>
          <h2 className="mb-3 font-bold text-stone-800">Próximas horas</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {weather.hourly.slice(0, 24).map((h) => {
              const c = describeWeatherCode(h.weather_code);
              return (
                <div key={h.time} className="min-w-[64px] rounded-xl border border-stone-100 p-2 text-center">
                  <p className="text-xs text-stone-400">{fmtHour(h.time, tzOffset)}</p>
                  <p className="text-2xl">{c.icon}</p>
                  <p className="text-sm font-semibold text-stone-800">{h.temperature_2m.toFixed(0)}°</p>
                  {h.precipitation_probability != null && h.precipitation_probability > 0 && (
                    <p className="text-[10px] text-blue-600">{h.precipitation_probability}%</p>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Previsão diária */}
      {weather && weather.daily.length > 0 && (
        <Card>
          <h2 className="mb-3 font-bold text-stone-800">Próximos dias</h2>
          <ul className="divide-y divide-stone-100">
            {weather.daily.map((d) => {
              const c = describeWeatherCode(d.weather_code);
              return (
                <li key={d.date} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{c.icon}</span>
                    <div>
                      <p className="font-medium text-stone-800">{fmtDay(d.date, tzOffset)}</p>
                      <p className="text-xs text-stone-400">{c.label}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-stone-400">{d.temperature_2m_min.toFixed(0)}°</span>
                    <span className="font-semibold text-stone-800">{d.temperature_2m_max.toFixed(0)}°</span>
                    <span className="text-blue-600">{d.precipitation_sum.toFixed(0)}mm</span>
                    <span className="text-amber-600">UV {d.uv_index_max}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Histórico de alertas */}
      {history.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold text-stone-800">Alertas enviados</h2>
            <Link to="/historico" className="text-xs font-medium text-green-700 underline-offset-2 hover:underline">
              Ver histórico completo →
            </Link>
          </div>
          <ul className="space-y-2 text-sm">
            {history.slice(0, 5).map((a, i) => (
              <li key={i} className="flex items-center gap-2">
                <span>{ALERT_ICON[a.type] || "⚠️"}</span>
                <span className="font-medium text-stone-700">{a.title}</span>
                <span className="text-stone-400">{a.sent_at?.slice(0, 16)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-stone-800 tabular-nums">{value}</p>
    </div>
  );
}

function WeatherChart({ hourly, offset }: { hourly: WeatherResponse["weather"]["hourly"]; offset: number }) {
  const data = hourly.slice(0, 24);
  if (data.length < 2) return null;
  const W = 320;
  const H = 150;
  const padX = 10;
  const padY = 16;
  const temps = data.map((h) => h.temperature_2m);
  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const span = Math.max(1, tMax - tMin);
  const x = (i: number) => padX + (i * (W - padX * 2)) / (data.length - 1);
  const yT = (t: number) => padY + (1 - (t - tMin) / span) * (H - padY * 2);
  const uvMax = Math.max(1, ...data.map((h) => h.uv_index ?? 0));
  const yU = (u: number) => padY + (1 - u / uvMax) * (H - padY * 2);

  const tempLine = data.map((h, i) => `${x(i).toFixed(1)},${yT(h.temperature_2m).toFixed(1)}`).join(" ");
  const tempArea = `10,${H - padY} ${tempLine} ${(W - padX).toFixed(1)},${H - padY}`;
  const uvLine = data.map((h, i) => `${x(i).toFixed(1)},${yU(h.uv_index ?? 0).toFixed(1)}`).join(" ");

  const labelIdx = [0, 6, 12, 18].filter((i) => i < data.length);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Gráfico de temperatura e UV">
      <defs>
        <linearGradient id="tempFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#16a34a" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#16a34a" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={tempArea} fill="url(#tempFill)" stroke="none" />
      <polyline points={uvLine} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeOpacity="0.8" />
      <polyline points={tempLine} fill="none" stroke="#16a34a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {labelIdx.map((i) => (
        <text key={i} x={x(i)} y={H - 4} textAnchor="middle" className="fill-stone-400" fontSize="9">
          {fmtHour(data[i].time, offset)}
        </text>
      ))}
    </svg>
  );
}
