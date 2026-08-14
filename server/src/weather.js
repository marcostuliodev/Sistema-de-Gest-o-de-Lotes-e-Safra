// Integração com a Open-Meteo (gratuita, sem chave de API, suporta CORS).
// Documentação: https://open-meteo.com/en/docs
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const CURRENT_VARS = [
  "temperature_2m",
  "relative_humidity_2m",
  "apparent_temperature",
  "is_day",
  "precipitation",
  "rain",
  "weather_code",
  "cloud_cover",
  "pressure_msl",
  "surface_pressure",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
];

const HOURLY_VARS = [
  "temperature_2m",
  "relative_humidity_2m",
  "apparent_temperature",
  "precipitation_probability",
  "precipitation",
  "rain",
  "weather_code",
  "wind_speed_10m",
  "wind_gusts_10m",
  "uv_index",
  "is_day",
];

const DAILY_VARS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "precipitation_sum",
  "rain_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "uv_index_max",
  "wind_direction_10m_dominant",
  "sunrise",
  "sunset",
];

// Cache simples em memória para não martelar a Open-Meteo a cada requisição.
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return res.json();
}

export async function geocode(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=8&language=pt&format=json`;
  const data = await getJson(url);
  return (data.results || []).map((r) => ({
    name: r.name,
    admin1: r.admin1 || "",
    country: r.country || "",
    countryCode: r.country_code || "",
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone || "auto",
    label: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
  }));
}

export async function fetchWeather(lat, lon, tz = "auto") {
  const key = `${lat},${lon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: CURRENT_VARS.join(","),
    hourly: HOURLY_VARS.join(","),
    daily: DAILY_VARS.join(","),
    timezone: tz && tz !== "auto" ? tz : "auto",
    forecast_days: "7",
    past_days: "0",
  });
  const data = await getJson(`${FORECAST_URL}?${params.toString()}`);

  const current = { ...data.current };
  const hourly = data.hourly.time.map((time, i) => {
    const o = { time };
    for (const k of HOURLY_VARS) o[k] = data.hourly[k][i];
    return o;
  });
  const daily = data.daily.time.map((date, i) => {
    const o = { date };
    for (const k of DAILY_VARS) o[k] = data.daily[k][i];
    return o;
  });

  // UV "agora" a partir da hora correspondente.
  const idx = hourly.findIndex((h) => h.time === current.time);
  current.uv_index = idx >= 0 ? hourly[idx].uv_index : (hourly[0]?.uv_index ?? null);

  const result = {
    location: {
      latitude: lat,
      longitude: lon,
      timezone: data.timezone,
      timezone_abbreviation: data.timezone_abbreviation,
    },
    current,
    hourly,
    daily,
    alerts: evaluateAlerts({ current, hourly, daily }),
  };
  cache.set(key, { t: Date.now(), v: result });
  return result;
}

const WMO = {
  0: { label: "Céu limpo", icon: "☀️" },
  1: { label: "Maiormente limpo", icon: "🌤️" },
  2: { label: "Parcialmente nublado", icon: "⛅" },
  3: { label: "Nublado", icon: "☁️" },
  45: { label: "Neblina", icon: "🌫️" },
  48: { label: "Neblina gelada", icon: "🌫️" },
  51: { label: "Garoa leve", icon: "🌦️" },
  53: { label: "Garoa moderada", icon: "🌦️" },
  55: { label: "Garoa intensa", icon: "🌧️" },
  56: { label: "Garoa congelante", icon: "🌧️" },
  57: { label: "Garoa congelante", icon: "🌧️" },
  61: { label: "Chuva fraca", icon: "🌧️" },
  63: { label: "Chuva moderada", icon: "🌧️" },
  65: { label: "Chuva forte", icon: "🌧️" },
  66: { label: "Chuva congelante", icon: "🌧️" },
  67: { label: "Chuva congelante", icon: "🌧️" },
  71: { label: "Neve fraca", icon: "🌨️" },
  73: { label: "Neve moderada", icon: "❄️" },
  75: { label: "Neve intensa", icon: "❄️" },
  77: { label: "Grãos de neve", icon: "🌨️" },
  80: { label: "Pancadas de chuva", icon: "🌦️" },
  81: { label: "Pancadas de chuva", icon: "🌦️" },
  82: { label: "Pancadas fortes", icon: "⛈️" },
  85: { label: "Pancadas de neve", icon: "🌨️" },
  86: { label: "Pancadas de neve", icon: "🌨️" },
  95: { label: "Tempestade", icon: "⛈️" },
  96: { label: "Tempestade com granizo", icon: "⛈️" },
  99: { label: "Tempestade com granizo", icon: "⛈️" },
};

export function describeWeatherCode(code, isDay = 1) {
  const info = WMO[code] || { label: "Desconhecido", icon: "🌡️" };
  return { label: info.label, icon: info.icon };
}

const STORM_CODES = [95, 96, 99];

// Gera alertas acionáveis para o produtor a partir do clima normalizado.

// Só alerta de chuva acima deste acumulado (mm). Ajuste conforme a necessidade.
const RAIN_MM_THRESHOLD = 1.0;

export function evaluateAlerts(weather) {
  const alerts = [];
  const today = weather.daily?.[0];
  if (!today) return alerts;

  const nowIdx = weather.hourly.findIndex((h) => h.time === weather.current.time);
  const start = nowIdx >= 0 ? nowIdx : 0;
  const next = weather.hourly.slice(start, start + 12); // próximas ~12h

  const willRain =
    (today.precipitation_sum || 0) >= RAIN_MM_THRESHOLD ||
    next.some((h) => (h.precipitation || 0) >= RAIN_MM_THRESHOLD);

  // Chuva
  if (willRain) {
    const mm = today.precipitation_sum || 0;
    const sev = mm >= 10 ? "high" : mm >= 3 ? "medium" : "low";
    alerts.push({
      type: "chuva",
      severity: sev,
      title: "Chuva prevista",
      body: `Chance de chuva hoje ${today.precipitation_probability_max || 0}% (${mm.toFixed(1)} mm). Proteja insumos e evite pulverizações.`,
    });
  }

  // Calor extremo
  if (today.temperature_2m_max >= 35) {
    alerts.push({
      type: "calor",
      severity: "high",
      title: "Calor extremo",
      body: `Máxima de ${today.temperature_2m_max.toFixed(0)}°C. Irrigue e proteja plantas sensíveis; evite exposição ao meio-dia.`,
    });
  } else if (today.temperature_2m_max >= 32) {
    alerts.push({
      type: "calor",
      severity: "medium",
      title: "Calor intenso",
      body: `Máxima de ${today.temperature_2m_max.toFixed(0)}°C. Atenção com irrigação.`,
    });
  }

  // Frio / geada
  if (today.temperature_2m_min <= 2) {
    alerts.push({
      type: "frio",
      severity: "high",
      title: "Risco de geada/frio",
      body: `Mínima de ${today.temperature_2m_min.toFixed(0)}°C. Proteja mudas e plantas sensíveis.`,
    });
  } else if (today.temperature_2m_min <= 8) {
    alerts.push({
      type: "frio",
      severity: "low",
      title: "Frio à noite",
      body: `Mínima de ${today.temperature_2m_min.toFixed(0)}°C.`,
    });
  }

  // Sol extremo (UV)
  if (today.uv_index_max >= 11) {
    alerts.push({
      type: "uv",
      severity: "high",
      title: `Sol extremo (UV ${today.uv_index_max})`,
      body: "Índice UV extremo. Use sombreamento para mudas e proteção adequada.",
    });
  } else if (today.uv_index_max >= 8) {
    alerts.push({
      type: "uv",
      severity: "medium",
      title: `UV muito alto (${today.uv_index_max})`,
      body: "Sol forte. Sombreamento recomendado para cultivos sensíveis.",
    });
  }

  // Vento forte
  if (today.wind_gusts_10m_max >= 60) {
    alerts.push({
      type: "vento",
      severity: "high",
      title: "Vento muito forte",
      body: `Rajadas de até ${today.wind_gusts_10m_max.toFixed(0)} km/h. Adiar pulverização.`,
    });
  } else if (today.wind_gusts_10m_max >= 40) {
    alerts.push({
      type: "vento",
      severity: "medium",
      title: "Vento forte",
      body: `Rajadas de até ${today.wind_gusts_10m_max.toFixed(0)} km/h.`,
    });
  }

  // Tempestade nas próximas horas
  if (next.some((h) => STORM_CODES.includes(h.weather_code))) {
    alerts.push({
      type: "tempestade",
      severity: "high",
      title: "Risco de tempestade",
      body: "Tempestade/raios nas próximas horas. Proteja equipamentos e evite áreas abertas.",
    });
  }

  // Nublado (informativo, só se bem carregado e sem chuva)
  const cloud = weather.current.cloud_cover;
  if (cloud >= 85 && !willRain) {
    alerts.push({
      type: "nublado",
      severity: "low",
      title: "Céu nublado",
      body: `Nebulosidade de ${cloud}%. Menor incidência de luz para as plantas.`,
    });
  }

  return alerts;
}

// Janela de debounce por severidade (ms) para não spammar o produtor.
export const ALERT_DEBOUNCE = {
  low: 12 * 60 * 60 * 1000,
  medium: 6 * 60 * 60 * 1000,
  high: 3 * 60 * 60 * 1000,
};

// Alertas de severidade baixa só aparecem no app; não viram push.
export const PUSHABLE_SEVERITY = ["medium", "high"];

// Tipos/severidades que realmente viram push. "nublado" é informativo, mas o
// produtor pediu para também recebê-lo (usa o debounce de severidade baixa).
export function isPushable(alert) {
  return PUSHABLE_SEVERITY.includes(alert.severity) || alert.type === "nublado";
}
