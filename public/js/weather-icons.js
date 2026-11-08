// weather-icons.js — WMO weather code (Open-Meteo) -> emoji. Shared by the POS and the customer display.
export function weatherEmoji(code, isDay = true) {
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code === 1) return isDay ? '🌤' : '🌙';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫';
  if (code >= 51 && code <= 57) return '🌦';
  if (code === 61 || code === 80) return '🌦';
  if ((code >= 63 && code <= 67) || code === 81 || code === 82) return '🌧';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨';
  if (code >= 95) return '⛈';
  return '🌡';
}
