// theme.js — colour theme for the POS and the customer display. Loaded in <head> (before the
// page is drawn) so there's no flash of the wrong colours.
//
// Two settings, saved per device:
//   mode   : 'auto' (follow the phone/PC), 'light' or 'dark'   -> <html data-theme="light|dark">
//   accent : 'green' or 'blue'                                    -> <html data-accent="green|blue">
(function () {
  var MODE_KEY = 'pos_theme';
  var ACCENT_KEY = 'pos_accent';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function read(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
  }

  // Older versions stored 'blue' as the theme itself: convert to dark + blue.
  if (read(MODE_KEY, '') === 'blue') { write(MODE_KEY, 'dark'); write(ACCENT_KEY, 'blue'); }

  var BAR = { 'dark-green': '#000000', 'light-green': '#f2f2ef', 'dark-blue': '#0a1222', 'light-blue': '#f1f4fa' };

  function apply() {
    var mode = read(MODE_KEY, 'auto');
    var accent = read(ACCENT_KEY, 'green');
    var theme = mode === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : mode;
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-accent', accent);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BAR[theme + '-' + accent] || '#000000');
  }

  apply();
  // Follow the system when it switches (e.g. dark mode at sunset) while on 'auto'.
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  // Another window (POS <-> customer display) changed the theme: follow it.
  window.addEventListener('storage', function (e) { if (e.key === MODE_KEY || e.key === ACCENT_KEY) apply(); });

  window.PocketTheme = {
    getMode: function () { return read(MODE_KEY, 'auto'); },
    getAccent: function () { return read(ACCENT_KEY, 'green'); },
    setMode: function (m) { write(MODE_KEY, m); apply(); },
    setAccent: function (a) { write(ACCENT_KEY, a); apply(); },
  };
})();
