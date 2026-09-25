import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Field, TextInput } from "../components/ui";
import { PlanGate } from "../components/PlanGate";
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

const SEV_LABEL: Record<string, string> = {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
};

export default function Clima() {
  return (
    <PlanGate
      feature="climaAlertas"
      permission="weather.read"
      blockedTitle="Clima & Alertas"
      blockedDescription="Faça upgrade para o plano Básico ou superior para acompanhar o clima e receber alertas na sua propriedade."
    >
      <ClimaContent />
    </PlanGate>
  );
}

function ClimaContent() {
  const [loc, setLoc] = useState<Loc | null>(null);
  const [weather, setWeather] = useState<WeatherResponse["weather"] | null>(null);
  const [history, setHistory] = useState<WeatherAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [geoQuery, setGeoQuery] = useState("");
  const [geoResults, setGeoResults] = useState<GeoResult[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMessage, setGeoMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [pushSupported] = useState(isPushSupported());
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // O cache local primeiro permite abrir o clima mesmo sem rede.
        const cached = await getCachedWeather();
        if (cached) {
          setWeather(cached.weather);
          setLoc(cached.location as Loc);
        }

        if (navigator.onLine) {
          const l = await getLocation();
          if (l) {
            setLoc(l);
            await loadWeather();
            await loadHistory();
          } else if (!cached) {
            setError("Localização não configurada. Busque a cidade da propriedade abaixo.");
          }
        } else if (!cached) {
          setError("Sem conexão e sem dados climáticos salvos neste aparelho.");
        } else {
          setError("Você está offline. Exibindo o último clima salvo; conecte para atualizar.");
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
  }, []);

  async function loadWeather() {
    setRefreshing(true);
    try {
      const resp = await fetchWeather();
      setWeather(resp.weather);
      setLoc(resp.location as Loc);
      await cacheWeather(resp);
      setError(null);
    } catch (e: any) {
      const cached = await getCachedWeather();
      if (cached && !loc) {
        setWeather(cached.weather);
        setLoc(cached.location as Loc);
      }
      setError(navigator.onLine ? (e.message || "Erro ao buscar clima.") : "Você está offline. Exibindo o último clima salvo.");
    } finally {
      setRefreshing(false);
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
    const query = geoQuery.trim();
    if (query.length < 2) {
      setGeoMessage("Digite pelo menos 2 letras.");
      return;
    }
    setGeoBusy(true);
    setGeoMessage(null);
    try {
      const res = await (await import("../db/weather")).geocode(query);
      setGeoResults(res);
      setGeoMessage(res.length === 0 ? "Nenhuma cidade encontrada. Tente incluir o estado, por exemplo: Cascavel, PR." : null);
    } catch (e: any) {
      setGeoResults([]);
      setGeoMessage(e.message || "Não foi possível buscar a cidade.");
    } finally {
      setGeoBusy(false);
    }
  }

  async function selectGeo(g: GeoResult) {
    setGeoResults([]);
    setGeoMessage(null);
    setGeoQuery("");
    await applyLocation({ lat: g.latitude, lon: g.longitude, city: g.label, tz: g.timezone });
  }

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setError("Geolocalização não disponível neste dispositivo.");
      return;
    }
    if (!window.isSecureContext) {
      setError("A localização do navegador exige HTTPS. Use a busca por cidade.");
      return;
    }
    setGeoMessage("Solicitando sua localização...");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "auto";
        await applyLocation({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          city: "Minha localização",
          tz,
        });
      },
      (geoError) => {
        const message = geoError.code === 1
          ? "Permissão de localização negada. Use a busca por cidade."
          : geoError.code === 3
            ? "A localização demorou. Tente novamente ou use a busca por cidade."
            : "Não foi possível obter sua localização. Use a busca por cidade.";
        setGeoMessage(message);
      },
      { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 }
    );
  }

  async function applyLocation(l: Loc) {
    setGeoMessage(null);
    try {
      await saveLocation(l);
      setLoc(l);
      setLoading(true);
      await loadWeather();
      await loadHistory();
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
      <div className="w-full min-w-0 max-w-full space-y-5 overflow-x-hidden pb-8">
        <section className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-sky-900 via-sky-800 to-emerald-900 p-6 text-white shadow-xl shadow-sky-950/10 sm:p-8">
          <div className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-amber-300/20 blur-3xl" aria-hidden="true" />
          <div className="relative max-w-xl">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-sky-200">Clima & Alertas</p>
            <h1 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">Comece pela sua propriedade.</h1>
            <p className="mt-3 text-sm leading-6 text-sky-100">Escolha a localização da fazenda para acompanhar temperatura, chuva, UV e alertas em tempo real.</p>
          </div>
        </section>
        <Card className="w-full min-w-0 max-w-full !overflow-hidden !rounded-[2rem] !p-0">
          <div className="border-b border-stone-100 px-5 py-4 sm:px-6">
            <h2 className="text-lg font-black text-stone-900">Onde fica sua propriedade?</h2>
            <p className="mt-1 text-sm text-stone-500">Busque uma cidade ou use sua localização atual.</p>
          </div>
          <div className="p-5 sm:p-6">
            <Field label="Buscar cidade" hint="Digite o nome da cidade/localidade da propriedade.">
              <div className="flex flex-col gap-2 sm:flex-row">
                <TextInput
                  value={geoQuery}
                  onChange={(e) => setGeoQuery(e.target.value)}
                  placeholder="Ex.: Cascavel, PR"
                  onKeyDown={(e) => e.key === "Enter" && doGeocode()}
                  className="w-full min-w-0 flex-1"
                />
                <Button onClick={doGeocode} disabled={geoBusy} className="w-full sm:w-auto">
                  {geoBusy ? "Buscando…" : "Buscar cidade"}
                </Button>
              </div>
            </Field>
            {geoMessage && <p className="mt-2 text-sm text-amber-700" role="status">{geoMessage}</p>}
            {geoResults.length > 0 && (
              <ul className="mt-3 divide-y divide-stone-100" aria-label="Cidades encontradas">
                {geoResults.map((g) => (
                  <li key={`${g.latitude},${g.longitude}`}>
                    <button type="button" onClick={() => selectGeo(g)} className="flex min-h-12 w-full items-center justify-between gap-3 py-3 text-left hover:text-green-700">
                      <span className="min-w-0 break-words font-bold text-stone-800">{g.label}</span>
                      <span className="shrink-0 text-xs text-stone-400">{g.timezone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-5 border-t border-stone-100 pt-4">
              <Button variant="subtle" onClick={useMyLocation} className="w-full">Usar minha localização atual</Button>
            </div>
          </div>
        </Card>
        {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
      </div>
    );
  }

  const cur = weather?.current;
  const today = weather?.daily?.[0];
  const code = cur ? describeWeatherCode(cur.weather_code) : null;
  const tzOffset = weather?.location.utc_offset_seconds ?? 0;
  const upcomingHours = weather?.hourly
    ? weather.hourly.filter((hour) => !cur?.time || hour.time >= cur.time).slice(0, 24)
    : [];

  return (
    <div className="w-full min-w-0 max-w-full space-y-4 overflow-x-hidden pb-8 sm:space-y-6">
      <div className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-sky-900 via-sky-800 to-emerald-900 p-4 text-white shadow-xl shadow-sky-950/10 sm:p-7">
        <div className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-amber-300/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex w-full min-w-0 flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="w-full min-w-0">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-sky-200">Clima da propriedade</p>
            <h1 className="mt-2 break-words text-2xl font-black tracking-tight sm:text-3xl">{loc.city || "Sua propriedade"}</h1>
            <p className="mt-2 max-w-full break-words text-sm leading-6 text-sky-100">Previsão, índice UV e alertas para decidir o melhor momento para cuidar do campo.</p>
          </div>
          <Button onClick={() => void loadWeather()} disabled={refreshing} className="w-full !border-white/20 !bg-white/10 !text-white hover:!bg-white/20 sm:w-auto">
            {refreshing ? "Atualizando…" : "Atualizar previsão"}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-amber-600" role="alert">{error}</p>}

      {/* Atual */}
      {cur && code && (
        <Card className="w-full min-w-0 max-w-full !overflow-hidden !rounded-[2rem] !border-0 !p-0 bg-gradient-to-br from-emerald-50 via-white to-sky-50 shadow-lg shadow-emerald-900/5">
          <div className="flex items-center justify-between gap-3 p-4 sm:p-7">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><span className="text-2xl" aria-hidden="true">{code.icon}</span><p className="text-sm font-bold text-stone-500">{code.label}</p></div>
              <p className="mt-2 text-5xl font-black tracking-[-0.05em] text-stone-950 sm:text-7xl">{formatNumber(cur.temperature_2m)}°</p>
              <p className="mt-1 text-sm font-semibold text-stone-500">Sensação térmica de {formatNumber(cur.apparent_temperature)}°C</p>
            </div>
            <div className="hidden shrink-0 rounded-3xl bg-white/80 p-4 text-7xl shadow-sm sm:block" aria-hidden="true">{code.icon}</div>
          </div>
          <div className="grid grid-cols-3 divide-x divide-emerald-100 border-t border-emerald-100/80 bg-white/60 text-center">
            <div className="px-2 py-3"><p className="text-[10px] font-bold uppercase tracking-wider text-stone-400">UV</p><p className="mt-1 font-black text-stone-800">{formatNumber(cur.uv_index, 1)}</p></div>
            <div className="px-2 py-3"><p className="text-[10px] font-bold uppercase tracking-wider text-stone-400">Vento</p><p className="mt-1 font-black text-stone-800">{formatNumber(cur.wind_speed_10m)} <span className="text-xs font-semibold">km/h</span></p></div>
            <div className="px-2 py-3"><p className="text-[10px] font-bold uppercase tracking-wider text-stone-400">Chuva</p><p className="mt-1 font-black text-stone-800">{formatNumber(cur.precipitation, 1)} <span className="text-xs font-semibold">mm</span></p></div>
          </div>
        </Card>
      )}
      {weather?.retrieved_at && (
        <p className="-mt-3 text-xs text-stone-400">
          Fonte: Open-Meteo · consulta em {new Date(weather.retrieved_at).toLocaleString("pt-BR")}
        </p>
      )}

      {/* Detalhes */}
      {cur && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
          <Detail label="Umidade" value={`${formatNumber(cur.relative_humidity_2m)}%`} />
          <Detail label="Vento agora" value={`${formatNumber(cur.wind_speed_10m)} km/h ${windDir(cur.wind_direction_10m)}`} />
          <Detail label="Rajada da hora" value={`${formatNumber(cur.wind_gusts_10m)} km/h`} />
          <Detail label="Pressão" value={`${formatNumber(cur.pressure_msl)} hPa`} />
          <Detail label="Nebulosidade" value={`${formatNumber(cur.cloud_cover)}%`} />
          <Detail label="UV agora" value={formatNumber(cur.uv_index, 1)} />
          <Detail label="UV máximo hoje" value={formatNumber(today?.uv_index_max, 1)} />
          <Detail label="Chuva agora" value={`${formatNumber(cur.precipitation, 1)} mm`} />
          <Detail label="Sol" value={`↑${fmtHour(today?.sunrise || "", tzOffset)} ↓${fmtHour(today?.sunset || "", tzOffset)}`} />
        </div>
      )}

      {/* Gráfico de temperatura/UV (24h) */}
      {upcomingHours.length > 0 && (
        <Card className="w-full min-w-0 max-w-full !p-4 sm:!p-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold text-stone-800">Temperatura e UV — próximas 24h</h2>
            <div className="flex items-center gap-3 text-xs text-stone-500">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 rounded-full bg-green-600" /> Temp
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 rounded-full bg-amber-500" /> UV
              </span>
            </div>
          </div>
          <WeatherChart hourly={upcomingHours} offset={tzOffset} />
        </Card>
      )}

      {/* Alertas atuais */}
      {weather && weather.alerts.length > 0 && (
        <Card className="w-full min-w-0 max-w-full">
          <h2 className="mb-3 font-bold text-stone-800">Alertas agora</h2>
          <ul className="space-y-2">
            {weather.alerts.map((a, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl bg-stone-50 p-3">
                <span className="text-xl">{ALERT_ICON[a.type] || "⚠️"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                     <span className="min-w-0 break-words font-semibold text-stone-800">{a.title}</span>
                    <Badge tone={SEV_TONE[a.severity] || "gray"}>{SEV_LABEL[a.severity] || a.severity}</Badge>
                  </div>
                  <p className="break-words text-sm text-stone-600">{a.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Notificações */}
      <Card className="w-full min-w-0 max-w-full">
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
                <Button onClick={enablePush} disabled={pushBusy} className="w-full sm:w-auto">
                  {pushBusy ? "Ativando…" : "Ativar notificações"}
                </Button>
              ) : (
                <>
                  <Button variant="subtle" onClick={testPush} disabled={pushBusy} className="w-full sm:w-auto">
                    Enviar teste
                  </Button>
                  <Button variant="danger" onClick={disablePush} disabled={pushBusy} className="w-full sm:w-auto">
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
      {upcomingHours.length > 0 && (
        <Card className="w-full min-w-0 max-w-full !p-4 sm:!p-5">
          <h2 className="mb-3 font-bold text-stone-800">Próximas horas</h2>
          <div className="flex w-full min-w-0 max-w-full snap-x gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
            {upcomingHours.map((h) => {
              const c = describeWeatherCode(h.weather_code);
              return (
                 <div key={h.time} className="min-w-[76px] snap-start rounded-2xl border border-stone-100 bg-stone-50/70 p-2.5 text-center">
                  <p className="text-xs text-stone-400">{fmtHour(h.time, tzOffset)}</p>
                  <p className="text-2xl">{c.icon}</p>
                   <p className="text-sm font-semibold text-stone-800">{formatNumber(h.temperature_2m)}°</p>
                   {h.precipitation_probability != null && h.precipitation_probability > 0 && (
                     <p className="text-[10px] text-blue-600">Chuva {h.precipitation_probability}%</p>
                   )}
                   <p className="text-[10px] text-stone-500">{formatNumber(h.wind_speed_10m)} km/h {windDir(h.wind_direction_10m)}</p>
                   {h.uv_index != null && <p className="text-[10px] text-amber-700">UV {formatNumber(h.uv_index, 1)}</p>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Previsão diária */}
      {weather && weather.daily.length > 0 && (
        <Card className="w-full min-w-0 max-w-full">
          <h2 className="mb-3 font-bold text-stone-800">Próximos dias</h2>
          <ul className="divide-y divide-stone-100">
            {weather.daily.map((d) => {
              const c = describeWeatherCode(d.weather_code);
              return (
                 <li key={d.date} className="grid min-w-0 grid-cols-1 gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                   <div className="flex min-w-0 items-center gap-3">
                     <span className="text-2xl">{c.icon}</span>
                     <div className="min-w-0">
                        <p className="break-words font-medium text-stone-800">{fmtDay(d.date, tzOffset)}</p>
                        <p className="break-words text-xs text-stone-400">{c.label}</p>
                     </div>
                   </div>
                    <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-stone-50 p-2 text-xs sm:flex sm:flex-wrap sm:items-center sm:justify-end sm:gap-3 sm:bg-transparent sm:p-0 sm:text-sm">
                      <span className="text-stone-400">Mín. {formatNumber(d.temperature_2m_min)}°</span>
                      <span className="font-semibold text-stone-800">Máx. {formatNumber(d.temperature_2m_max)}°</span>
                      <span className="text-blue-600">Chuva {formatNumber(d.precipitation_sum, 1)} mm</span>
                      <span className="text-amber-700">UV {formatNumber(d.uv_index_max, 1)}</span>
                   </div>
                 </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Histórico de alertas */}
      {history.length > 0 && (
        <Card className="w-full min-w-0 max-w-full">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold text-stone-800">Alertas enviados</h2>
            <Link to="/historico" className="text-xs font-medium text-green-700 underline-offset-2 hover:underline">
              Ver histórico completo →
            </Link>
          </div>
          <ul className="space-y-2 text-sm">
            {history.slice(0, 5).map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span>{ALERT_ICON[a.type] || "⚠️"}</span>
                 <span className="min-w-0 flex-1 break-words font-medium text-stone-700">{a.title}</span>
                <span className="text-xs text-stone-400">{a.sent_at?.slice(0, 16)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function formatNumber(value: unknown, digits = 0): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-stone-200/80 bg-white p-3 shadow-sm shadow-stone-900/[0.03] sm:p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-stone-400">{label}</p>
      <p className="mt-1 break-words text-sm font-black tabular-nums text-stone-800">{value}</p>
    </div>
  );
}

function WeatherChart({ hourly, offset }: { hourly: WeatherResponse["weather"]["hourly"]; offset: number }) {
  const data = hourly.filter((h) => Number.isFinite(Number(h.temperature_2m))).slice(0, 24);
  if (data.length < 2) return null;
  const W = 360;
  const H = 180;
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
    <svg viewBox={`0 0 ${W} ${H}`} className="h-40 min-w-0 w-full sm:h-44" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gráfico de temperatura e índice UV nas próximas 24 horas">
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
