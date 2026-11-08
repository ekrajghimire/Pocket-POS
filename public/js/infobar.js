// infobar.js — the strip above the cart: clock, weekday + date, and live weather.
//
// Weather comes from /api/weather (OpenWeather, key kept on the server). The chosen place is
// saved on this device. It refreshes every 15 minutes; the last reading is kept so something
// sensible shows while offline.

const LOC_KEY = 'pos_weather_loc_v1';     // {name, lat, lon} or {off: true}
const LAST_KEY = 'pos_weather_last_v1';   // last weather reading
const REFRESH_MS = 15 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };

// ---------- Clock ----------
function tickClock() {
  const now = new Date();
  $('clockTime').textContent = now.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
  $('clockDate').textContent = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------- Weather ----------
/** OpenWeather condition id -> emoji. https://openweathermap.org/weather-conditions */
function emoji(id, icon = '') {
  const night = icon.endsWith('n');
  if (id >= 200 && id < 300) return '⛈';
  if (id >= 300 && id < 400) return '🌦';
  if (id >= 500 && id < 600) return id <= 501 ? '🌦' : '🌧';
  if (id >= 600 && id < 700) return '🌨';
  if (id >= 700 && id < 800) return '🌫';
  if (id === 800) return night ? '🌙' : '☀️';
  if (id === 801) return night ? '🌙' : '🌤';
  if (id === 802) return '⛅';
  if (id >= 803) return '☁️';
  return '🌡';
}

function render(w, loc) {
  const chip = $('weatherChip');
  const credit = $('wxCredit');
  if (loc && loc.off) { chip.hidden = true; credit.hidden = true; return; }
  chip.hidden = false;
  $('wxDesc').textContent = '';
  chip.title = '';
  if (!loc) {
    $('wxIcon').textContent = '🌤';
    $('wxTemp').textContent = 'Weather';
    $('wxPlace').textContent = 'Tap to set';
    credit.hidden = true;
    return;
  }
  if (!w) {
    $('wxIcon').textContent = '…';
    $('wxTemp').textContent = '--°';
    $('wxPlace').textContent = loc.name;
    credit.hidden = false;
    return;
  }
  $('wxIcon').textContent = emoji(w.id, w.icon);
  $('wxTemp').textContent = `${w.temp}°`;
  const desc = w.description ? w.description[0].toUpperCase() + w.description.slice(1) : '';
  $('wxPlace').textContent = loc.name || w.name;
  chip.title = `${desc} · feels like ${w.feels}° · humidity ${w.humidity}%`;
  $('wxDesc').textContent = desc;
  credit.hidden = false;
}

let timer = null;
let setupNeeded = false;

export async function refreshWeather() {
  const loc = read(LOC_KEY);
  if (!loc || loc.off) { render(null, loc); return; }
  render(read(LAST_KEY), loc);                       // show the last reading straight away
  try {
    const res = await fetch(`/api/weather?lat=${loc.lat}&lon=${loc.lon}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 501 && data.setup) {
      setupNeeded = true;
      $('wxIcon').textContent = '🌤'; $('wxTemp').textContent = 'Weather'; $('wxDesc').textContent = ''; $('wxPlace').textContent = 'Not set up';
      $('wxCredit').hidden = true;
      return;
    }
    if (!res.ok) throw new Error(data.error || res.status);
    setupNeeded = false;
    write(LAST_KEY, data);
    render(data, loc);
  } catch { /* offline or service down: keep the last reading */ }
}

export function startInfobar() {
  tickClock();
  setInterval(tickClock, 1000 * 10);
  refreshWeather();
  clearInterval(timer);
  timer = setInterval(refreshWeather, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickClock(); refreshWeather(); } });
  window.addEventListener('online', refreshWeather);
}

// ---------- Choosing the place (used by the Weather sheet in app.js) ----------
export function weatherLocation() { return read(LOC_KEY); }
export function isSetupNeeded() { return setupNeeded; }

export async function searchPlaces(q) {
  const res = await fetch(`/api/weather?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
  return data.places || [];
}

export function setWeatherLocation(loc) {
  write(LOC_KEY, loc);
  localStorage.removeItem(LAST_KEY);
  refreshWeather();
}

/** Use the device's location (asks permission). Resolves to the saved place. */
export function useDeviceLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device cannot share its location'));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = +pos.coords.latitude.toFixed(3);
      const lon = +pos.coords.longitude.toFixed(3);
      let name = 'This location';
      try {
        const r = await fetch(`/api/weather?lat=${lat}&lon=${lon}`, { cache: 'no-store' });
        const d = await r.json();
        if (r.ok && d.name) name = d.name;
      } catch { /* keep generic name */ }
      const loc = { name, lat, lon };
      setWeatherLocation(loc);
      resolve(loc);
    }, (err) => reject(new Error(err.code === 1 ? 'Location permission was refused' : 'Could not get the location')),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
}
