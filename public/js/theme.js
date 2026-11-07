// theme.js — light / dark / auto theme. Loaded in <head> (before the page is drawn) so there's
// no flash of the wrong colours. Used by both the POS and the customer display.
//
// The choice is saved per device: 'auto' (follow the phone/PC setting), 'light', 'dark' or 'blue'.
(function () {
  var KEY = 'pos_theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function pref() {
    try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; }
  }

  function apply() {
    var p = pref();
    var theme = p === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : p;
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f2f2ef' : theme === 'blue' ? '#0a1222' : '#000000');
  }

  apply();
  // Follow the system when it switches (e.g. dark mode at sunset) while on 'auto'.
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  // Another window (POS <-> customer display) changed the theme: follow it.
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });

  window.PocketTheme = {
    get: pref,
    set: function (p) {
      try { localStorage.setItem(KEY, p); } catch (e) { /* storage blocked */ }
      apply();
    },
  };
})();
