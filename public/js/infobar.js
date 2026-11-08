// infobar.js — the strip above the cart: clock, weekday + date, and live weather.
//
// Weather comes from /api/weather (Open-Meteo, via our server). The chosen place is
// saved on this device. It refreshes every 15 minutes; the last reading is kept so something
// sensible shows while offline.

import { weatherEmoji } from './weather-icons.js';

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
const emoji = weatherEmoji;

function render(w, loc) {
  const chip = $('weatherChip');
  if (loc && loc.off) { chip.hidden = true; return; }
  chip.hidden = false;
  $('wxDesc').textContent = '';
  chip.title = '';
  if (!loc) {
    $('wxIcon').textContent = '🌤';
    $('wxTemp').textContent = 'Weather';
    $('wxPlace').textContent = 'Tap to set';
    return;
  }
  if (!w) {
    $('wxIcon').textContent = '…';
    $('wxTemp').textContent = '--°';
    $('wxPlace').textContent = loc.name;
    return;
  }
  $('wxIcon').textContent = emoji(w.code, w.isDay);
  $('wxTemp').textContent = `${w.temp}°`;
  $('wxDesc').textContent = w.description || '';
  // second line: place + today's high/low
  $('wxPlace').textContent = Number.isFinite(w.hi) ? `${loc.name} · ${w.hi}°/${w.lo}°` : loc.name;
  // Open-Meteo's licence (CC BY 4.0) asks for credit: it's here and in the weather picker.
  chip.title = `${w.description} · feels like ${w.feels}° · humidity ${w.humidity}% · today ${w.hi}° / ${w.lo}° — Weather data by Open-Meteo.com`;
}

let timer = null;

export async function refreshWeather() {
  const loc = read(LOC_KEY);
  if (!loc || loc.off) { render(null, loc); return; }
  render(read(LAST_KEY), loc);                       // show the last reading straight away
  try {
    const res = await fetch(`/api/weather?lat=${loc.lat}&lon=${loc.lon}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.status);
    write(LAST_KEY, data);
    render(data, loc);
  } catch { /* offline or service down: keep the last reading */ }
}

// ---------- Where the bar sits ----------
// Phone (camera on top, cart below): above the cart.
// Computer / landscape tablet (side by side): bottom of the left panel, where there's room.
const WIDE = window.matchMedia('(orientation: landscape) and (min-width: 700px)');

function placeInfobar() {
  const bar = document.querySelector('.infobar');
  const scanner = $('scanner');
  const cart = document.querySelector('.cart');
  if (WIDE.matches) {
    if (bar.parentElement !== scanner) scanner.appendChild(bar);
    scanner.classList.add('has-info');
    matchFooterHeight();
  } else {
    if (bar.parentElement !== cart) cart.insertBefore(bar, cart.querySelector('.cart-head'));
    scanner.classList.remove('has-info');
    bar.style.height = '';
  }
}

/** On wide screens, make the bar exactly as tall as the Total/Checkout footer on the right. */
function matchFooterHeight() {
  if (!WIDE.matches) return;
  const h = document.querySelector('.cart-foot').offsetHeight + document.querySelector('.home-credit').offsetHeight;
  document.querySelector('.infobar').style.height = h + 'px';
  $('scanner').style.setProperty('--info-h', h + 'px');   // flash / edit banners sit just above it
}

export function startInfobar() {
  placeInfobar();
  WIDE.addEventListener('change', placeInfobar);
  // Keep the "space above the bar" right as its height changes (weather loads, window resizes).
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(matchFooterHeight);
    ro.observe(document.querySelector('.cart-foot'));
    ro.observe(document.querySelector('.home-credit'));
  }
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
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = +pos.coords.latitude.toFixed(3);
      const lon = +pos.coords.longitude.toFixed(3);
      const loc = { name: 'Your location', lat, lon };
      setWeatherLocation(loc);
      resolve(loc);
    }, (err) => reject(new Error(err.code === 1 ? 'Location permission was refused' : 'Could not get the location')),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
}
