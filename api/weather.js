// GET /api/weather?lat=..&lon=..   -> current weather (+ today's high/low) for a place
// GET /api/weather?q=Liverpool      -> places matching a suburb name or postcode (Australia)
//
// Uses Open-Meteo (https://open-meteo.com): no API key needed. The free API is for
// non-commercial use, under 10,000 calls a day, and data is CC BY 4.0, so the app shows
// "Weather data by Open-Meteo.com". Results are cached here for 10 minutes per place.
import { route, sendJson } from '../lib/http.js';
import { requireSession } from '../lib/auth.js';

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();                   // key -> {at, data}

// WMO weather codes used by Open-Meteo -> short description
const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw Object.assign(new Error('Open-Meteo: ' + (data.reason || res.status)), { status: 502 });
  return data;
}

export default route('GET', async (req, res) => {
  if (!requireSession(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim();

  // ---- Search for a place (suburb name or postcode) ----
  if (q) {
    if (q.length < 2 || q.length > 60) return sendJson(res, 400, { error: 'Type at least 2 letters' });
    const g = new URL('https://geocoding-api.open-meteo.com/v1/search');
    g.search = new URLSearchParams({ name: q, count: '8', language: 'en', format: 'json', countryCode: 'AU' }).toString();
    const data = await getJson(g);
    const places = (data.results || []).map((p) => ({
      name: p.name,
      state: [p.admin1, (p.postcodes || [])[0]].filter(Boolean).join(' '),
      lat: p.latitude,
      lon: p.longitude,
    }));
    return sendJson(res, 200, { places });
  }

  // ---- Current weather ----
  const latText = url.searchParams.get('lat') || '';
  const lonText = url.searchParams.get('lon') || '';
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!latText.trim() || !lonText.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return sendJson(res, 400, { error: 'lat and lon are required' });
  }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return sendJson(res, 200, hit.data);

  const f = new URL('https://api.open-meteo.com/v1/forecast');
  f.search = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '1',
  }).toString();
  const w = await getJson(f);
  const c = w.current || {};
  const data = {
    temp: Math.round(c.temperature_2m),
    feels: Math.round(c.apparent_temperature),
    humidity: c.relative_humidity_2m,
    code: c.weather_code,
    isDay: c.is_day === 1,
    description: WMO[c.weather_code] || '',
    hi: Math.round(w.daily?.temperature_2m_max?.[0]),
    lo: Math.round(w.daily?.temperature_2m_min?.[0]),
    at: Date.now(),
  };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) cache.clear();
  sendJson(res, 200, data);
});
