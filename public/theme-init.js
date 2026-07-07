/* Runs in <head> before first paint — sets the theme so there's no flash.
   Order of preference: saved choice -> OS preference -> dark. */
(function () {
  'use strict';
  var t;
  try { t = localStorage.getItem('helm-theme'); } catch (e) { t = null; }
  if (t !== 'light' && t !== 'dark') {
    t = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = t;
})();
