import { getSession } from "./api";
import { db } from "./db";

export interface GeoResult {
  name: string;
  admin1: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
  label: string;
}

export interface WeatherHour {
  time: string;
  temperature_2m: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
  precipitation_probability: number | null;
  precipitation: number;
  rain: number;
  weather_code: number;
  wind_speed_10m: number;
  wind_gusts_10m: number;
  uv_index: number;
  is_day: number;
}

export interface WeatherDay {
  date: string;
  weather_code: number;
  temperature_2m_max: number;
  temperature_2m_min: number;
  apparent_temperature_max: number;
  apparent_temperature_min: number;
  precipitation_sum: number;
  rain_sum: number;
  precipitation_probability_max: number | null;
  wind_speed_10m_max: number;
  wind_gusts_10m_max: number;
  uv_index_max: number;
  wind_direction_10m_dominant: number;
  sunrise: string;
  sunset: string;
}

export interface WeatherCurrent {
  time: string;
  temperature_2m: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
  is_day: number;
  precipitation: number;
  rain: number;
  weather_code: number;
  cloud_cover: number;
  pressure_msl: number;
  surface_pressure: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  wind_gusts_10m: number;
  uv_index: number | null;
}

export interface WeatherAlert {
  type: string;
  severity: "low" | "medium" | "high";
  title: string;
  body: string;
  sent_at?: string;
}

export interface WeatherResponse {
  location: { city: string | null; lat: number; lon: number; tz: string | null };
  weather: {
    location: { latitude: number; longitude: number; timezone: string; timezone_abbreviation: string };
    current: WeatherCurrent;
    hourly: WeatherHour[];
    daily: WeatherDay[];
    alerts: WeatherAlert[];
  };
}

async function authed(path: string, options: RequestInit = {}) {
  const session = getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers as Record<string, string>) };
  if (session) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || "Erro na requisição");
  }
  return res.json();
}

export async function geocode(q: string): Promise<GeoResult[]> {
  const data = await authed(`/api/weather/geocode?q=${encodeURIComponent(q)}`);
  return data.results || [];
}

export async function getLocation(): Promise<{ lat: number; lon: number; city: string; tz: string } | null> {
  const data = await authed("/api/weather/location");
  return data.location || null;
}

export async function saveLocation(loc: { lat: number; lon: number; city: string; tz: string }) {
  return authed("/api/weather/location", { method: "POST", body: JSON.stringify(loc) });
}

export async function fetchWeather(): Promise<WeatherResponse> {
  return authed("/api/weather");
}

export async function fetchAlerts(): Promise<WeatherAlert[]> {
  const data = await authed("/api/weather/alerts");
  return data.alerts || [];
}

export async function cacheWeather(resp: WeatherResponse) {
  await db.meta.put({ key: "last_weather", value: resp });
}

export async function getCachedWeather(): Promise<WeatherResponse | null> {
  const r = await db.meta.get("last_weather");
  return (r?.value as WeatherResponse) || null;
}

const WMO: Record<number, { label: string; icon: string }> = {
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

export function describeWeatherCode(code: number): { label: string; icon: string } {
  return WMO[code] || { label: "Desconhecido", icon: "🌡️" };
}

const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];

export function windDir(deg?: number): string {
  if (deg == null || Number.isNaN(deg)) return "—";
  return DIRS[Math.round(deg / 22.5) % 16];
}

export function fmtHour(time: string): string {
  return time.slice(11, 16);
}

export function fmtDay(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
}
