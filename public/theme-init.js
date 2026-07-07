/* Runs in <head> before first paint — sets theme + accent so there's no flash.
   Mode preference: saved choice -> OS preference -> dark.
   Accent: saved choice -> crimson. */
(function () {
  'use strict';
  var root = document.documentElement;

  var t;
  try { t = localStorage.getItem('helm-theme'); } catch (e) { t = null; }
  if (t !== 'light' && t !== 'dark') {
    t = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  root.dataset.theme = t;

  var ACCENTS = ['crimson', 'magenta', 'violet', 'cobalt', 'teal', 'emerald'];
  var a;
  try { a = localStorage.getItem('helm-accent'); } catch (e) { a = null; }
  root.dataset.accent = ACCENTS.indexOf(a) >= 0 ? a : 'crimson';
})();
