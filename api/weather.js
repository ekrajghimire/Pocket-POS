// GET /api/weather?lat=..&lon=..   -> current weather for a place
// GET /api/weather?q=Liverpool      -> places matching a suburb name or 4-digit postcode (Australia)
//
// Uses OpenWeather's free plan (commercial use allowed, with the credit "Weather data ©
// OpenWeather"). The API key stays on the server in the OPENWEATHER_API_KEY env var.
import { route, sendJson } from '../lib/http.js';
import { requireSession } from '../lib/auth.js';

const BASE = 'https://api.openweathermap.org';
const CACHE_MS = 10 * 60 * 1000;          // reuse a result for 10 minutes (saves API calls)
const cache = new Map();                   // key -> {at, data}

async function owm(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('appid', process.env.OPENWEATHER_API_KEY);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error('OpenWeather rejected the API key (new keys can take up to 2 hours to start working)'), { status: 502 });
  if (!res.ok) throw Object.assign(new Error('OpenWeather error: ' + (data.message || res.status)), { status: 502 });
  return data;
}

function demoWeather() {
  return { demo: true, temp: 24, feels: 25, humidity: 55, id: 801, icon: '02d', description: 'few clouds', name: 'Demo suburb', at: Date.now() };
}

export default route('GET', async (req, res) => {
  if (!requireSession(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim();
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));

  if (!process.env.OPENWEATHER_API_KEY) {
    if (process.env.POS_DEV === '1') {         // local demo: pretend data so the screen can be tried
      if (q) return sendJson(res, 200, { places: [{ name: q, state: 'NSW', lat: -33.92, lon: 150.92 }] });
      return sendJson(res, 200, demoWeather());
    }
    return sendJson(res, 501, { setup: true, error: 'Weather is not set up: add OPENWEATHER_API_KEY in Vercel (see SETUP.md)' });
  }

  // ---- Search for a place ----
  if (q) {
    if (q.length < 2 || q.length > 60) return sendJson(res, 400, { error: 'Type at least 2 letters' });
    let places = [];
    if (/^\d{4}$/.test(q)) {                    // Australian postcode
      const z = await owm('/geo/1.0/zip', { zip: `${q},AU` }).catch(() => null);
      if (z && z.lat != null) places = [{ name: z.name, state: q, lat: z.lat, lon: z.lon }];
    } else {
      const list = await owm('/geo/1.0/direct', { q: `${q},AU`, limit: '5' });
      places = (Array.isArray(list) ? list : []).map((p) => ({ name: p.name, state: p.state || '', lat: p.lat, lon: p.lon }));
    }
    return sendJson(res, 200, { places });
  }

  // ---- Current weather ----
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return sendJson(res, 400, { error: 'lat and lon are required' });
  }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return sendJson(res, 200, hit.data);

  const w = await owm('/data/2.5/weather', { lat: String(lat), lon: String(lon), units: 'metric' });
  const data = {
    temp: Math.round(w.main?.temp),
    feels: Math.round(w.main?.feels_like),
    humidity: w.main?.humidity,
    id: w.weather?.[0]?.id,
    icon: w.weather?.[0]?.icon || '',
    description: w.weather?.[0]?.description || '',
    name: w.name || '',
    at: Date.now(),
  };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) cache.clear();
  sendJson(res, 200, data);
});
