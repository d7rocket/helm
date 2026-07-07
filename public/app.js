/* HELM — frontend. Vanilla, no build step. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $('#main');

const state = {
  boot: null,          // { skills, projects, config }
  sessions: null,      // cached session list
  launch: { cat: 'all', q: '' },
  sessFilter: { q: '', project: '' },
  sessSort: { key: 'date', dir: -1 },
  runs: [],            // active/finished runs (client view)
  activeRun: null,
};

// ---------------------------------------------------------------- utilities

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
}

function fmtTime(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function localDayStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDay(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return localDayStr(dt);
}

function fmtAgo(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d < 1) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return d + 'd ago';
  if (d < 365) return Math.floor(d / 30) + 'mo ago';
  return Math.floor(d / 365) + 'y ago';
}

function modelShort(m) {
  return String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function boot() {
  if (!state.boot) state.boot = await api('/api/boot');
  return state.boot;
}

async function saveConfig(patch) {
  state.boot.config = await api('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// count-up for ledger numbers — 600ms, ease-out-quart, reduced-motion aware
function countUp(el) {
  const target = Number(el.dataset.count) || 0;
  const fmt = el.dataset.fmt === 'tok' ? fmtTokens : (v) => String(v);
  if (!target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = fmt(target);
    return;
  }
  const t0 = performance.now(), dur = 600;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 4);
    el.textContent = fmt(Math.round(target * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// tiny markdown-lite for assistant text (input escaped FIRST)
function md(s) {
  let h = esc(s);
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, code) => `<pre>${code}</pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>)(\n(?!<li>)|$)/g, '<ul>$1</ul>$2');
  h = h.split(/\n{2,}/).map(b => /^<(h\d|pre|ul)/.test(b.trim()) ? b : `<p>${b.replace(/\n/g, '<br>')}</p>`).join('');
  return h;
}

// ---------------------------------------------------------------- clock

setInterval(() => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  $('#clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}, 1000);

// ---------------------------------------------------------------- theme

function paintThemeToggle() {
  const light = document.documentElement.dataset.theme === 'light';
  const icon = $('#tt-icon'), label = $('#tt-label');
  if (!icon) return;
  icon.textContent = light ? '☀' : '☾';        // shows the current theme
  label.textContent = light ? 'LIGHT' : 'DARK';
}
$('#theme-toggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('helm-theme', next); } catch {}
  paintThemeToggle();
};
paintThemeToggle();

// accent-color picker — [id, label, preview swatch color]
const ACCENTS = [
  ['crimson', 'Crimson', 'oklch(0.63 0.205 22)'],
  ['magenta', 'Magenta', 'oklch(0.63 0.19 345)'],
  ['violet',  'Violet',  'oklch(0.62 0.20 300)'],
  ['cobalt',  'Cobalt',  'oklch(0.62 0.165 255)'],
  ['teal',    'Teal',    'oklch(0.70 0.13 195)'],
  ['emerald', 'Emerald', 'oklch(0.70 0.165 152)'],
];
function paintAccentPicker() {
  const el = $('#accent-picker');
  if (!el) return;
  const cur = document.documentElement.dataset.accent || 'crimson';
  el.innerHTML = ACCENTS.map(([id, label, col]) =>
    `<button class="swatch ${cur === id ? 'on' : ''}" data-set-accent="${id}" style="--sw:${col}" title="${label}" aria-label="${label} accent"></button>`).join('');
  $$('#accent-picker [data-set-accent]').forEach(b => b.onclick = () => {
    const id = b.dataset.setAccent;
    document.documentElement.dataset.accent = id;
    try { localStorage.setItem('helm-accent', id); } catch {}
    paintAccentPicker();
  });
}
paintAccentPicker();

// ---------------------------------------------------------------- notifications

const TITLE_BASE = 'HELM · agentic ops';
const FAVICON_BASE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%231a1013'/%3E%3Cpath d='M8 6v20M24 6v20M8 16h16' stroke='%23e0324f' stroke-width='4'/%3E";
let unseenRuns = 0;

const notifyPref = () => { try { return localStorage.getItem('helm-notify') !== 'off'; } catch { return true; } };
const notifyReady = () => 'Notification' in window && Notification.permission === 'granted' && notifyPref();

function setBadge(kind) {
  const link = $('#favicon');
  if (!link) return;
  const dot = kind === 'error'
    ? "%3Ccircle cx='25' cy='7' r='6' fill='%23e05a32'/%3E"
    : kind === 'done'
      ? "%3Ccircle cx='25' cy='7' r='6' fill='%2334d399'/%3E"
      : '';
  link.href = FAVICON_BASE + dot + '%3C/svg%3E';
}

function clearUnseen() {
  if (!unseenRuns) return;
  unseenRuns = 0;
  document.title = TITLE_BASE;
  setBadge(null);
}
window.addEventListener('focus', clearUnseen);
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearUnseen(); });

function notifyRunEnd(run) {
  if (!document.hidden && document.hasFocus()) return;   // user is watching — no need
  const failed = run.status === 'error';
  unseenRuns++;
  document.title = `(${unseenRuns}) ${TITLE_BASE}`;
  setBadge(failed ? 'error' : 'done');
  if (!notifyReady()) return;
  const result = [...run.lines].reverse().find(l => l.kind === 'result') || {};
  const meta = [result.costUsd ? '$' + result.costUsd.toFixed(2) : '', result.durationMs ? fmtDur(result.durationMs) : '']
    .filter(Boolean).join(' · ');
  try {
    const n = new Notification(failed ? 'HELM — run failed' : 'HELM — run complete', {
      body: run.prompt.slice(0, 120) + (meta ? '\n' + meta : ''),
      tag: 'helm-run-' + run.id,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

function paintNotifyToggle() {
  const btn = $('#notify-toggle'), icon = $('#nt-icon'), label = $('#nt-label');
  if (!btn) return;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'denied';
  btn.classList.remove('on', 'blocked');
  if (!supported || perm === 'denied') { btn.classList.add('blocked'); icon.textContent = '⊘'; label.textContent = 'NOTIFY'; return; }
  if (perm === 'granted' && notifyPref()) { btn.classList.add('on'); icon.textContent = '◉'; label.textContent = 'NOTIFY ON'; }
  else { icon.textContent = '◌'; label.textContent = 'NOTIFY'; }
}
{
  const btn = $('#notify-toggle');
  if (btn) btn.onclick = async () => {
    if (!('Notification' in window)) return alert('Notifications are not supported in this browser.');
    if (Notification.permission === 'denied') return alert('Notifications are blocked — allow them for this site in your browser settings.');
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
      try { localStorage.setItem('helm-notify', 'on'); } catch {}
    } else {
      try { localStorage.setItem('helm-notify', notifyPref() ? 'off' : 'on'); } catch {}
    }
    paintNotifyToggle();
  };
  paintNotifyToggle();
}

// ---------------------------------------------------------------- router

const routes = [
  { re: /^#\/today(?:\/(\d{4}-\d{2}-\d{2}))?$/, view: viewToday, nav: 'today' },
  { re: /^#\/launch$/, view: viewLaunch, nav: 'launch' },
  { re: /^#\/sessions$/, view: viewSessions, nav: 'sessions' },
  { re: /^#\/session\/([\w.-]+)\/([\w-]+)(?:\/at\/([^/]+))?$/, view: viewSessionDetail, nav: 'sessions' },
  { re: /^#\/search$/, view: viewSearch, nav: 'search' },
  { re: /^#\/usage$/, view: viewUsage, nav: 'usage' },
  { re: /^#\/active$/, view: viewActive, nav: 'active' },
];

let todayPoll = null;
let currentDay = null;

async function route() {
  clearInterval(todayPoll);
  clearInterval(activePoll);
  currentDay = null;
  closeSheet();
  const hash = location.hash || '#/today';
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) {
      $$('.rail-nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === r.nav));
      main.innerHTML = '<div class="boot-note">reading instruments…</div>';
      try { await r.view(...m.slice(1)); }
      catch (e) {
        main.innerHTML = `<div class="view"><div class="empty">INSTRUMENT FAULT<br><b>${esc(e.message)}</b></div></div>`;
      }
      return;
    }
  }
  location.hash = '#/today';
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- TODAY

async function viewToday(dateArg) {
  const date = dateArg || localDayStr();
  const [b, day] = await Promise.all([boot(), api('/api/day?date=' + date)]);
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const isToday = date === localDayStr();
  const st = day.stats;

  currentDay = date;
  const maxHour = Math.max(1, ...day.hourHist);
  const hourBars = day.hourHist.map((n, h) =>
    `<div class="hbar ${n ? 'on' : ''}" style="height:${n ? Math.max(7, Math.round((n / maxHour) * 74)) : 2}px;animation-delay:${h * 16}ms">
      ${n ? `<span class="tip">${String(h).padStart(2, '0')}:00 — ${n} prompt${n > 1 ? 's' : ''}</span>` : ''}
    </div>`).join('');

  const DOWL = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const maxRecent = Math.max(1, ...day.recent.map(r => r.count));
  const fortnight = day.recent.map((r, i) => `
    <div class="fn-cell ${r.count ? 'on' : ''} ${r.date === date ? 'sel' : ''}" data-day="${r.date}" title="${r.count} prompts">
      <span class="fn-bar"><i style="height:${r.count ? Math.max(4, Math.round((r.count / maxRecent) * 26)) : 2}px;animation-delay:${i * 22}ms"></i></span>
      <span class="fn-d">${DOWL[r.dow]}</span>
      <span class="fn-n">${r.date.slice(8)}</span>
    </div>`).join('');
  const hourLabels = Array.from({ length: 24 }, (_, h) => `<span>${String(h).padStart(2, '0')}</span>`).join('');

  const sorties = day.sessions
    .slice()
    .sort((a, b2) => (a.start || '').localeCompare(b2.start || ''))
    .map((s, i) => `
    <article class="sortie row-in" style="animation-delay:${Math.min(i * 45, 320)}ms">
      <div class="sortie-head">
        <span class="sortie-time">${fmtTime(s.start)}–${fmtTime(s.end)}</span>
        <span>${esc(s.project)}</span>
        ${s.gitBranch ? `<span>⎇ ${esc(s.gitBranch)}</span>` : ''}
      </div>
      <h3 class="sortie-title"><a href="#/session/${esc(s.slug)}/${esc(s.id)}">${esc(s.title || s.firstPrompt || 'untitled session')}</a></h3>
      ${s.title && s.firstPrompt ? `<p class="sortie-first">${esc(s.firstPrompt)}</p>` : ''}
      <div class="sortie-stats">
        <span><b>${s.prompts}</b> PROMPT${s.prompts === 1 ? '' : 'S'}</span>
        <span><b>${s.toolCalls}</b> TOOL CALL${s.toolCalls === 1 ? '' : 'S'}</span>
        <span><b>${fmtTokens(s.tokensOut)}</b> TOK OUT</span>
        <span><b>${fmtDur(s.durationMs)}</b> ELAPSED</span>
      </div>
    </article>`).join('');

  const pfeed = day.prompts.map((p, i) => `
    <div class="pline row-in" style="animation-delay:${Math.min(i * 18, 350)}ms">
      <span class="pt">${fmtTime(p.t)}</span>
      <div>
        <div class="px">${esc(p.text.length > 220 ? p.text.slice(0, 219) + '…' : p.text)}</div>
        <div class="pp">${esc(p.project)}</div>
      </div>
    </div>`).join('');

  main.innerHTML = `
  <div class="view">
    <div class="view-head">
      <div>
        <div class="view-kicker">DAILY REPORT ${isToday ? '· LIVE' : ''}</div>
        <h1 class="view-title">${DAYS[dt.getDay()]}<br><span class="thin">${String(d).padStart(2, '0')} ${MONTHS[dt.getMonth()]} ${y}</span></h1>
      </div>
      <div class="day-controls">
        <button class="btn" id="day-prev">‹</button>
        <button class="btn" id="day-next" ${isToday ? 'disabled' : ''}>›</button>
        <button class="btn btn-amber" id="day-today" ${isToday ? 'disabled' : ''}>TODAY</button>
      </div>
    </div>

    <div class="day-ledger">
      <span><b data-count="${st.promptCount}">0</b> PROMPTS</span><span class="sep">·</span>
      <span><b data-count="${st.sessionCount}">0</b> SESSIONS</span><span class="sep">·</span>
      <span><b data-count="${st.projectCount}">0</b> PROJECTS</span><span class="sep">·</span>
      <span><b data-count="${st.tokensOut}" data-fmt="tok">0</b> TOKENS OUT</span>
      ${st.models.length ? `<span class="sep">·</span><span>${st.models.map(modelShort).map(esc).join(' + ')}</span>` : ''}
    </div>

    <div class="fortnight">${fortnight}</div>

    <section class="hours">
      <div class="hours-title">ACTIVITY BY HOUR</div>
      <div class="hours-grid">${hourBars}</div>
      <div class="hours-labels">${hourLabels}</div>
    </section>

    <div class="day-body">
      <section>
        <div class="col-title">FLIGHT LOG — ${day.sessions.length} SORTIE${day.sessions.length === 1 ? '' : 'S'}</div>
        ${sorties || `<div class="empty">NO SORTIES.<br><b>The fleet was quiet on ${esc(date)}.</b></div>`}
      </section>
      <section>
        <div class="col-title">PROMPT FEED — ${day.prompts.length}</div>
        <div class="pfeed">${pfeed || `<div class="empty">NOTHING TYPED.</div>`}</div>
      </section>
    </div>
  </div>`;

  $('#day-prev').onclick = () => location.hash = '#/today/' + shiftDay(date, -1);
  $('#day-next').onclick = () => location.hash = '#/today/' + shiftDay(date, 1);
  $('#day-today').onclick = () => location.hash = '#/today';
  $$('.fn-cell').forEach(el => el.onclick = () => {
    location.hash = el.dataset.day === localDayStr() ? '#/today' : '#/today/' + el.dataset.day;
  });
  $$('[data-count]').forEach(countUp);

  // live view: re-render when today's numbers move
  if (isToday) {
    todayPoll = setInterval(async () => {
      try {
        const fresh = await api('/api/day?date=' + date);
        if (fresh.stats.promptCount !== st.promptCount || fresh.stats.tokensOut !== st.tokensOut) {
          viewToday(dateArg);
        }
      } catch {}
    }, 60000);
  }
}

// ---------------------------------------------------------------- LAUNCHPAD

const CATS = [
  ['all', 'ALL'], ['pinned', 'PINNED'], ['personal', 'PERSONAL'], ['design', 'DESIGN'],
  ['gsd', 'GSD'], ['pbi', 'POWER BI'], ['toolkit', 'TOOLKIT'], ['off', 'DISABLED'],
];

// Model options for the target strip / per-launch override.
const MODELS = [['', 'DEFAULT'], ['opus', 'OPUS'], ['sonnet', 'SONNET'], ['haiku', 'HAIKU']];

// Skills where a headless RUN is genuinely useful — autonomous, one-shot, no
// mid-run questions. For everything else TERM is the primary action, because a
// headless `claude -p` can't answer the checkpoints those skills depend on.
const AUTONOMOUS = new Set([
  'ship', 'cover', 'readme-gen', 'humanizer', 'audit', 'polish', 'optimize', 'distill',
  'security-review', 'code-review', 'dataviz', 'canvas-design',
  'gsd-autonomous', 'gsd-fast', 'gsd-quick', 'gsd-code-review', 'gsd-docs-update',
  'gsd-map-codebase', 'gsd-stats', 'gsd-extract-learnings', 'gsd-milestone-summary',
  'pbi-audit', 'pbi-format', 'pbi-format-batch', 'pbi-docs', 'pbi-changelog',
  'pbi-comment-batch', 'pbi-diff', 'pbi-extract',
]);
const isAutonomous = (name) => AUTONOMOUS.has(name);

async function viewLaunch() {
  const b = await boot();
  const cfg = b.config;
  if (cfg.model === undefined) cfg.model = '';

  main.innerHTML = `
  <div class="view">
    <div class="view-head">
      <div>
        <div class="view-kicker">SKILLS &amp; AUTOMATIONS</div>
        <h1 class="view-title">LAUNCHPAD</h1>
      </div>
    </div>

    <div class="launch-controls">
      <input class="input" id="skill-q" placeholder="search ${b.skills.length} skills…" value="${esc(state.launch.q)}" autocomplete="off">
      <button class="btn btn-sm" id="freeform-btn">＋ FREE-FORM</button>
      <button class="btn btn-ghost btn-sm" id="bulk-toggle" hidden></button>
    </div>
    <div class="cat-tabs" id="cat-tabs"></div>

    <div class="target-strip">
      <span>TARGET</span>
      <span class="select-wrap"><select class="select" id="target-proj"></select></span>
      <span class="select-wrap model-wrap"><select class="select" id="target-model" title="Model for launches">
        ${MODELS.map(([v, l]) => `<option value="${v}" ${cfg.model === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></span>
      <label class="yolo ${cfg.dangerous ? 'on' : ''}" id="yolo">
        <span class="sw"></span><span id="yolo-label">${cfg.dangerous ? 'YOLO ARMED' : 'PERMISSIONS ON'}</span>
      </label>
    </div>

    <div class="skill-list" id="skill-list"></div>
  </div>`;

  const sel = $('#target-proj');
  sel.innerHTML = b.projects.map(p =>
    `<option value="${esc(p.path)}" ${p.path === cfg.defaultProject ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  if (!cfg.defaultProject && b.projects[0]) cfg.defaultProject = b.projects[0].path;
  sel.onchange = () => saveConfig({ defaultProject: sel.value });

  const mdl = $('#target-model');
  mdl.onchange = () => saveConfig({ model: mdl.value });

  const yolo = $('#yolo');
  yolo.onclick = async (e) => {
    e.preventDefault();
    const next = !state.boot.config.dangerous;
    yolo.classList.toggle('on', next);
    $('#yolo-label').textContent = next ? 'YOLO ARMED' : 'PERMISSIONS ON';
    await saveConfig({ dangerous: next });
  };

  $('#freeform-btn').onclick = openComposer;

  const q = $('#skill-q');
  q.oninput = () => { state.launch.q = q.value; renderSkillList(); };
  renderCatTabs();
  renderSkillList();
  q.focus();
}

// Free-form run/terminal — any prompt, not tied to a skill. Reuses the sheet.
function openComposer() {
  const sh = sheetEl(), bd = backdropEl();
  const cfg = state.boot.config;
  sh.innerHTML = `
    <header class="sheet-head">
      <div>
        <div class="sheet-kind">FREE-FORM · ${cfg.dangerous ? 'YOLO' : 'PERMISSIONS ON'}</div>
        <h2 class="sheet-name">compose a run</h2>
      </div>
      <button class="btn btn-ghost btn-sm" id="sheet-close">✕</button>
    </header>
    <div class="sheet-body">
      <label class="sheet-label">PROMPT <span>sent to claude in the target project</span></label>
      <textarea class="input" id="cmp-prompt" rows="6" placeholder="e.g. summarise what changed on this branch and draft a commit message" autocomplete="off"></textarea>
      <label class="sheet-label">MODEL</label>
      <span class="select-wrap"><select class="select" id="cmp-model">
        ${MODELS.map(([v, l]) => `<option value="${v}" ${targetModel() === v ? 'selected' : ''}>${l === 'DEFAULT' ? 'DEFAULT (strip)' : l}</option>`).join('')}
      </select></span>
      <div class="sheet-actions">
        <button class="btn" id="cmp-term">OPEN TERMINAL ⧉</button>
        <button class="btn btn-amber" id="cmp-run">RUN ▸</button>
      </div>
      <div class="sheet-hint">RUN streams a headless one-shot into the console. OPEN TERMINAL drops you into an interactive claude in the target project — type the prompt yourself.</div>
    </div>`;
  bd.hidden = false; sh.hidden = false;
  requestAnimationFrame(() => sh.classList.add('open'));

  const prompt = () => $('#cmp-prompt').value.trim();
  const model = () => { const v = $('#cmp-model').value; return v || targetModel(); };
  $('#sheet-close').onclick = closeSheet;
  bd.onclick = closeSheet;
  $('#cmp-run').onclick = async () => {
    if (!prompt()) return $('#cmp-prompt').focus();
    const cwd = $('#target-proj').value;
    try {
      const { id, queued } = await api('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt(), cwd, dangerous: state.boot.config.dangerous, model: model() }),
      });
      closeSheet(); attachRun(id, prompt(), { status: queued ? 'queued' : 'running' });
    } catch (e) { alert(e.message); }
  };
  $('#cmp-term').onclick = async () => {
    const cwd = $('#target-proj').value;
    try {
      await api('/api/terminal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, command: null, model: model() }),
      });
      closeSheet();
    } catch (e) { alert(e.message); }
  };
  $('#cmp-prompt').focus();
}

// The currently-targeted model (per-launch override falls back to the strip).
function targetModel() { return ($('#target-model') || {}).value || ''; }

async function setSkillDisabled(name, disable) {
  const r = await api('/api/skill/toggle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, disable }),
  });
  const item = state.boot.skills.find(s => s.name === name);
  if (item) item.disabled = !!r.disabled;
  return r;
}

function renderCatTabs() {
  const b = state.boot;
  const pins = new Set(b.config.pins);
  const counts = { all: b.skills.filter(s => !s.disabled).length, pinned: 0, off: 0 };
  for (const s of b.skills) {
    if (s.disabled) { counts.off++; continue; }
    if (pins.has(s.name)) counts.pinned++;
    counts[s.category] = (counts[s.category] || 0) + 1;
  }
  $('#cat-tabs').innerHTML = CATS.map(([id, label]) =>
    `<button data-cat="${id}" class="${state.launch.cat === id ? 'active' : ''} ${id === 'off' ? 'tab-off' : ''}">${label}<span class="cnt">${counts[id] || 0}</span></button>`).join('');
  $$('#cat-tabs button').forEach(btn => btn.onclick = () => {
    state.launch.cat = btn.dataset.cat;
    renderCatTabs(); renderSkillList();
  });
}

let skillsAnimated = false;

// The skills currently visible under the active filter — used by list + bulk toggle.
function filteredSkills() {
  const b = state.boot;
  const pins = new Set(b.config.pins);
  const q = state.launch.q.trim().toLowerCase();
  const cat = state.launch.cat;
  return b.skills.filter(s => {
    if (cat === 'off') { if (!s.disabled) return false; }
    else if (s.disabled) return false;               // hide disabled outside the DISABLED tab
    if (cat === 'pinned' && !pins.has(s.name)) return false;
    if (cat !== 'all' && cat !== 'pinned' && cat !== 'off' && s.category !== cat) return false;
    if (q && !(s.name + ' ' + s.description).toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, z) => (pins.has(z.name) - pins.has(a.name)) || a.name.localeCompare(z.name));
}

function renderSkillList() {
  const anim = !skillsAnimated;
  skillsAnimated = true;
  const b = state.boot;
  const pins = new Set(b.config.pins);
  const q = state.launch.q.trim().toLowerCase();
  const cat = state.launch.cat;
  const list = filteredSkills();

  // Bulk enable/disable for the current view — the "toggle all pbi" workflow.
  const bulk = $('#bulk-toggle');
  const bulkable = list.filter(s => s.kind);
  if (bulk) {
    if ((cat !== 'all' && cat !== 'pinned') && bulkable.length) {
      const disabling = cat !== 'off';
      bulk.hidden = false;
      bulk.textContent = `${disabling ? 'DISABLE' : 'ENABLE'} ALL ${bulkable.length}`;
      bulk.onclick = () => bulkToggle(bulkable.map(s => s.name), disabling);
    } else { bulk.hidden = true; }
  }

  $('#skill-list').innerHTML = list.length ? list.map((s, i) => {
    const primaryRun = isAutonomous(s.name);
    const runBtn = `<button class="btn btn-sm ${primaryRun ? 'btn-amber' : 'btn-ghost'}" data-run="${esc(s.name)}" title="headless run — streamed to the console${primaryRun ? '' : '. best for autonomous skills; this one may expect input'}">RUN ▸</button>`;
    const termBtn = `<button class="btn btn-sm ${primaryRun ? 'btn-ghost' : 'btn-amber'}" data-term="${esc(s.name)}" title="open an interactive terminal">TERM ⧉</button>`;
    return `
    <div class="skill-row ${s.disabled ? 'disabled' : ''} ${anim ? 'row-in' : ''}" ${anim ? `style="animation-delay:${Math.min(i * 14, 300)}ms"` : ''} data-skill="${esc(s.name)}">
      <button class="pin-btn ${pins.has(s.name) ? 'pinned' : ''}" data-pin="${esc(s.name)}" title="pin">${pins.has(s.name) ? '◆' : '◇'}</button>
      <div class="skill-name">/${esc(s.name)}${s.kind === 'command' ? '<span class="kind-tag">cmd</span>' : ''}${s.uses ? `<span class="use-cnt" title="used ${s.uses}× across your sessions">${s.uses}×</span>` : ''}</div>
      <div class="skill-desc">${esc(s.description || '—')}</div>
      <div class="skill-acts">
        ${s.disabled
          ? `<button class="btn btn-sm btn-amber" data-enable="${esc(s.name)}">ENABLE</button>`
          : `${primaryRun ? runBtn + termBtn : termBtn + runBtn}
             <button class="power-btn" data-disable="${esc(s.name)}" title="disable — move off Claude Code's path">⏻</button>`}
      </div>
    </div>`;
  }).join('') : `<div class="empty">NO MATCHES.<br><b>Nothing on the pad for “${esc(q || cat)}”.</b></div>`;

  $$('#skill-list [data-pin]').forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    const name = el.dataset.pin;
    const cur = new Set(state.boot.config.pins);
    cur.has(name) ? cur.delete(name) : cur.add(name);
    await saveConfig({ pins: [...cur] });
    renderCatTabs(); renderSkillList();
  });
  $$('#skill-list [data-run]').forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    launchSkill(el.dataset.run, '');
  });
  $$('#skill-list [data-term]').forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    openTerm(el.dataset.term, '');
  });
  $$('#skill-list [data-disable]').forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    await setSkillDisabled(el.dataset.disable, true);
    renderCatTabs(); renderSkillList();
  });
  $$('#skill-list [data-enable]').forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    await setSkillDisabled(el.dataset.enable, false);
    renderCatTabs(); renderSkillList();
  });
  $$('#skill-list .skill-row').forEach(row => row.onclick = () => openSkillSheet(row.dataset.skill));
}

async function bulkToggle(names, disable) {
  if (disable && !confirm(`Disable ${names.length} skill${names.length === 1 ? '' : 's'}? They'll stop loading in Claude Code until re-enabled.`)) return;
  for (const name of names) { try { await setSkillDisabled(name, disable); } catch {} }
  renderCatTabs(); renderSkillList();
}

async function launchSkill(name, args) {
  const cwd = $('#target-proj').value;
  const dangerous = state.boot.config.dangerous;
  const model = targetModel();
  const prompt = '/' + name + (args ? ' ' + args : '');
  try {
    const { id, queued } = await api('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, cwd, dangerous, model }),
    });
    attachRun(id, prompt, { status: queued ? 'queued' : 'running' });
  } catch (e) {
    alert(e.message);
  }
}

async function openTerm(name, args) {
  const cwd = $('#target-proj').value;
  const command = '/' + name + (args ? ' ' + args : '');
  await api('/api/terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, command, model: targetModel() }),
  }).catch(err => alert(err.message));
}

// ------------------------------------------------------------ skill sheet

const sheetEl = () => $('#skill-sheet');
const backdropEl = () => $('#sheet-backdrop');

function closeSheet() {
  const sh = sheetEl(), bd = backdropEl();
  if (sh) { sh.hidden = true; sh.classList.remove('open'); sh.innerHTML = ''; }
  if (bd) bd.hidden = true;
}

async function openSkillSheet(name) {
  const s = state.boot.skills.find(x => x.name === name);
  if (!s) return;
  const sh = sheetEl(), bd = backdropEl();
  const pinned = new Set(state.boot.config.pins).has(name);
  const primaryRun = isAutonomous(name);

  sh.innerHTML = `
    <header class="sheet-head">
      <div>
        <div class="sheet-kind">${s.kind === 'command' ? 'COMMAND' : 'SKILL'} · ${esc((s.category || '').toUpperCase())}${s.disabled ? ' · <span class="off-tag">DISABLED</span>' : ''}</div>
        <h2 class="sheet-name">/${esc(name)}</h2>
      </div>
      <button class="btn btn-ghost btn-sm" id="sheet-close">✕</button>
    </header>
    <div class="sheet-body">
      <p class="sheet-desc">${esc(s.description || 'No description.')}</p>
      ${s.uses ? `<div class="sheet-usage">USED <b>${s.uses}×</b>${s.lastUsed ? ` · LAST ${esc(fmtAgo(s.lastUsed).toUpperCase())}` : ''}</div>` : `<div class="sheet-usage">NEVER USED IN A TRACKED SESSION</div>`}
      ${primaryRun ? '' : `<div class="sheet-hint">Interactive skill — it may ask you questions mid-run. Prefer <b>TERMINAL</b>; a headless RUN can't answer its prompts.</div>`}

      <label class="sheet-label">ARGUMENTS <span>optional — appended to /${esc(name)}</span></label>
      <input class="input" id="sheet-args" placeholder="e.g. --fix, a topic, a path…" autocomplete="off">

      <label class="sheet-label">MODEL</label>
      <span class="select-wrap"><select class="select" id="sheet-model">
        ${MODELS.map(([v, l]) => `<option value="${v}" ${targetModel() === v ? 'selected' : ''}>${l === 'DEFAULT' ? 'DEFAULT (strip)' : l}</option>`).join('')}
      </select></span>

      <div class="sheet-actions">
        <button class="btn ${primaryRun ? '' : 'btn-amber'}" id="sheet-term">TERMINAL ⧉</button>
        <button class="btn ${primaryRun ? 'btn-amber' : ''}" id="sheet-run">RUN ▸</button>
      </div>
      <div class="sheet-meta">
        <button class="btn btn-ghost btn-sm" id="sheet-pin">${pinned ? '◆ PINNED' : '◇ PIN'}</button>
        <button class="btn btn-ghost btn-sm" id="sheet-disable">${s.disabled ? 'ENABLE' : '⏻ DISABLE'}</button>
        <button class="btn btn-ghost btn-sm" id="sheet-src">VIEW SOURCE</button>
      </div>
      <div class="sheet-src" id="sheet-src-body" hidden></div>
    </div>`;

  bd.hidden = false;
  sh.hidden = false;
  requestAnimationFrame(() => sh.classList.add('open'));

  const argsFor = () => $('#sheet-args').value.trim();
  const modelOverride = () => { const v = $('#sheet-model').value; return v || targetModel(); };

  $('#sheet-close').onclick = closeSheet;
  bd.onclick = closeSheet;
  $('#sheet-run').onclick = async () => {
    const cwd = $('#target-proj').value;
    const prompt = '/' + name + (argsFor() ? ' ' + argsFor() : '');
    try {
      const { id, queued } = await api('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, cwd, dangerous: state.boot.config.dangerous, model: modelOverride() }),
      });
      closeSheet(); attachRun(id, prompt, { status: queued ? 'queued' : 'running' });
    } catch (e) { alert(e.message); }
  };
  $('#sheet-term').onclick = async () => {
    const cwd = $('#target-proj').value;
    const command = '/' + name + (argsFor() ? ' ' + argsFor() : '');
    try {
      await api('/api/terminal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, command, model: modelOverride() }),
      });
      closeSheet();
    } catch (e) { alert(e.message); }
  };
  $('#sheet-pin').onclick = async () => {
    const cur = new Set(state.boot.config.pins);
    cur.has(name) ? cur.delete(name) : cur.add(name);
    await saveConfig({ pins: [...cur] });
    openSkillSheet(name); renderCatTabs(); renderSkillList();
  };
  $('#sheet-disable').onclick = async () => {
    await setSkillDisabled(name, !s.disabled);
    closeSheet(); renderCatTabs(); renderSkillList();
  };
  $('#sheet-src').onclick = async () => {
    const box = $('#sheet-src-body');
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false; box.textContent = 'reading…';
    try {
      const src = await api('/api/skill/source?name=' + encodeURIComponent(name));
      // split frontmatter (kept raw) from the body (rendered as markdown)
      const fm = src.body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const body = fm ? src.body.slice(fm[0].length) : src.body;
      box.innerHTML = `<div class="sheet-src-path">${esc(src.path)}</div>`
        + (fm ? `<pre class="sheet-src-fm">${esc(fm[0].trim())}</pre>` : '')
        + `<div class="sheet-src-md">${md(body)}${src.truncated ? '<p>…(truncated)</p>' : ''}</div>`;
    } catch (e) { box.textContent = 'could not read source: ' + e.message; }
  };
  $('#sheet-args').focus();
}

// ---------------------------------------------------------------- SESSIONS

async function viewSessions() {
  state.sessions = await api('/api/sessions');   // always refetch — new sessions land while HELM is open
  const sessions = state.sessions;
  const projects = [...new Set(sessions.map(s => s.project))].sort();

  main.innerHTML = `
  <div class="view">
    <div class="view-head">
      <div>
        <div class="view-kicker">EVERY TRANSCRIPT · EVERY PROJECT</div>
        <h1 class="view-title">SESSIONS <span class="thin">${sessions.length}</span></h1>
      </div>
    </div>
    <div class="sess-controls">
      <input class="input" id="sess-q" placeholder="search titles &amp; first prompts…" value="${esc(state.sessFilter.q)}" autocomplete="off">
      <span class="select-wrap"><select class="select" id="sess-proj">
        <option value="">ALL PROJECTS</option>
        ${projects.map(p => `<option ${state.sessFilter.project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select></span>
    </div>
    <div class="sess-list" id="sess-list"></div>
  </div>`;

  let sessAnimated = false;
  const SORTS = {
    date:  { get: s => s.start || '', label: 'DATE' },
    title: { get: s => (s.title || s.firstPrompt || '').toLowerCase(), label: 'SESSION' },
    proj:  { get: s => s.project.toLowerCase(), label: 'PROJECT' },
    dur:   { get: s => s.durationMs || 0, label: 'DUR', r: true },
    tools: { get: s => s.toolCalls || 0, label: 'TOOLS', r: true },
    tok:   { get: s => s.tokens.out || 0, label: 'TOK OUT', r: true },
  };
  const render = () => {
    const anim = !sessAnimated;
    sessAnimated = true;
    const q = state.sessFilter.q.trim().toLowerCase();
    const proj = state.sessFilter.project;
    const { key, dir } = state.sessSort;
    const get = SORTS[key].get;
    const list = sessions.filter(s => {
      if (proj && s.project !== proj) return false;
      if (q && !((s.title || '') + ' ' + (s.firstPrompt || '') + ' ' + s.project).toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      const va = get(a), vb = get(b);
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
    });
    $('#sess-list').innerHTML = `
      <div class="list-head">
        ${Object.entries(SORTS).map(([k, c]) =>
          `<button class="sort-col ${c.r ? 'r' : ''} ${key === k ? 'on' : ''}" data-sort="${k}">${c.label}${key === k ? `<span class="dir">${dir > 0 ? '▴' : '▾'}</span>` : ''}</button>`).join('')}
      </div>` +
      (list.map((s, i) => {
        const d = s.start ? new Date(s.start) : null;
        return `
        <a class="sess-row ${anim ? 'row-in' : ''}" ${anim ? `style="animation-delay:${Math.min(i * 14, 300)}ms"` : ''} href="#/session/${esc(s.slug)}/${esc(s.id)}">
          <span class="sess-date"><b>${d ? `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '—'}</b>${d ? fmtTime(s.start) : ''}</span>
          <span class="sess-title">
            <span class="t">${esc(s.title || s.firstPrompt || 'untitled session')}</span>
            <span class="f">${esc(s.title ? (s.firstPrompt || '') : '')}</span>
          </span>
          <span class="sess-proj">${esc(s.project)}</span>
          <span class="sess-num">${fmtDur(s.durationMs)}</span>
          <span class="sess-num">${s.toolCalls}</span>
          <span class="sess-num">${fmtTokens(s.tokens.out)}</span>
        </a>`;
      }).join('') || `<div class="empty">NO SESSIONS MATCH.</div>`);
    $$('#sess-list [data-sort]').forEach(el => el.onclick = () => {
      const k = el.dataset.sort;
      const cur = state.sessSort;
      state.sessSort = { key: k, dir: cur.key === k ? -cur.dir : (SORTS[k].r ? -1 : k === 'date' ? -1 : 1) };
      render();
    });
  };

  $('#sess-q').oninput = (e) => { state.sessFilter.q = e.target.value; render(); };
  $('#sess-proj').onchange = (e) => { state.sessFilter.project = e.target.value; render(); };
  render();
}

// ---------------------------------------------------------------- SESSION DETAIL

async function viewSessionDetail(slug, id, at) {
  const detail = await api(`/api/session?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`);
  const s = detail.summary || {};
  const d = s.start ? new Date(s.start) : null;

  // group consecutive tool events
  const blocks = [];
  for (const ev of detail.events) {
    if (ev.kind === 'tool') {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'tools') last.items.push(ev);
      else blocks.push({ kind: 'tools', items: [ev] });
    } else blocks.push(ev);
  }

  const html = blocks.map((b, i) => {
    if (b.kind === 'user') return `
      <div class="tl-user" data-t="${esc(b.t || '')}"><div class="who">YOU · ${b.t ? fmtTime(b.t) : ''}</div>
      <div class="txt">${esc(b.text)}</div></div>`;
    if (b.kind === 'assistant') return `
      <div class="tl-assistant" data-t="${esc(b.t || '')}"><div class="txt">${md(b.text)}</div></div>`;
    if (b.kind === 'tools') {
      const vis = b.items.slice(0, 6);
      const rest = b.items.length - vis.length;
      return `
      <div class="tl-tools" data-block="${i}">
        ${vis.map(t => `<div class="tl-tool"><span class="tn">${esc(t.name)}</span><span class="td">${esc(t.detail || '')}</span></div>`).join('')}
        ${rest > 0 ? `<div class="tl-more" data-more="${i}">+ ${rest} MORE TOOL CALLS</div>` : ''}
      </div>`;
    }
    if (b.kind === 'command') return `<div class="tl-turn">CMD ${esc(b.text)}</div>`;
    if (b.kind === 'turn') return `<div class="tl-turn">TURN · ${fmtDur(b.ms)}</div>`;
    return '';
  }).join('');

  main.innerHTML = `
  <div class="view">
    <a class="back-link" href="#/sessions">← ALL SESSIONS</a>
    <div class="view-kicker">${esc(s.project || slug)}</div>
    <h1 class="view-title" style="font-size:clamp(26px,3vw,40px)">${esc(s.title || s.firstPrompt || 'untitled session')}</h1>
    <div class="detail-meta">
      ${d ? `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${fmtTime(s.start)}` : ''}
      <span class="sep">·</span>${fmtDur(s.durationMs)}
      <span class="sep">·</span>${s.prompts} prompts
      <span class="sep">·</span>${s.toolCalls} tool calls
      <span class="sep">·</span>${fmtTokens((s.tokens || {}).out)} tok out
      ${s.gitBranch ? `<span class="sep">·</span>⎇ ${esc(s.gitBranch)}` : ''}
      ${s.models ? `<span class="sep">·</span>${Object.keys(s.models).map(modelShort).map(esc).join(', ')}` : ''}
      ${s.cwd ? `<span class="sep">·</span><button class="btn btn-sm" id="resume-btn">RESUME ⧉</button>` : ''}
    </div>
    <div class="timeline">${html}
      ${detail.truncated ? `<div class="tl-turn">TRUNCATED · ${detail.truncated} MORE EVENTS</div>` : ''}
    </div>
  </div>`;

  const resumeBtn = $('#resume-btn');
  if (resumeBtn) resumeBtn.onclick = async () => {
    resumeBtn.textContent = 'OPENING…';
    try {
      await api('/api/terminal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: s.cwd, command: '--resume ' + id }),
      });
      resumeBtn.textContent = 'OPENED ⧉';
    } catch (e) { resumeBtn.textContent = 'FAILED'; alert(e.message); }
    setTimeout(() => { resumeBtn.textContent = 'RESUME ⧉'; }, 2500);
  };

  $$('[data-more]').forEach(el => el.onclick = () => {
    const idx = Number(el.dataset.more);
    const b = blocks[idx];
    $(`[data-block="${idx}"]`).innerHTML =
      b.items.map(t => `<div class="tl-tool"><span class="tn">${esc(t.name)}</span><span class="td">${esc(t.detail || '')}</span></div>`).join('');
  });

  // deep link from search: scroll to and flash the matched message
  if (at) {
    const target = decodeURIComponent(at);
    const el = $$('.timeline [data-t]').find(n => n.dataset.t === target);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('tl-hit');
      setTimeout(() => el.classList.remove('tl-hit'), 2400);
    }
  }
}

// ---------------------------------------------------------------- SEARCH

function fmtDateShort(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}

// escape, then bold every occurrence of the query
function mark(text, q) {
  const et = esc(text), eq = esc(q);
  if (!eq) return et;
  try { return et.replace(new RegExp(eq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), m => `<mark>${m}</mark>`); }
  catch { return et; }
}

const searchState = { q: '' };

async function viewSearch() {
  await boot();
  main.innerHTML = `
  <div class="view">
    <div class="view-head"><div>
      <div class="view-kicker">FULL-TEXT · EVERY TRANSCRIPT</div>
      <h1 class="view-title">SEARCH</h1>
    </div></div>
    <div class="sess-controls">
      <input class="input" id="search-q" placeholder="find anything you or claude ever wrote…" value="${esc(searchState.q)}" autocomplete="off">
    </div>
    <div class="search-results" id="search-results"><div class="empty">Type at least 2 characters.</div></div>
  </div>`;

  const inp = $('#search-q');
  let timer = null;
  const run = async () => {
    const q = inp.value.trim();
    searchState.q = q;
    const box = $('#search-results');
    if (q.length < 2) { box.innerHTML = `<div class="empty">Type at least 2 characters.</div>`; return; }
    box.innerHTML = `<div class="boot-note">searching transcripts…</div>`;
    try { renderSearch(await api('/api/search?q=' + encodeURIComponent(q))); }
    catch (e) { box.innerHTML = `<div class="empty">SEARCH FAILED<br><b>${esc(e.message)}</b></div>`; }
  };
  inp.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  inp.focus();
  if (searchState.q) run();
}

function renderSearch(r) {
  const el = $('#search-results');
  if (!r.hits.length) { el.innerHTML = `<div class="empty">NO HITS.<br><b>Nothing matched “${esc(r.query)}”.</b></div>`; return; }
  el.innerHTML = `<div class="search-count">${r.hits.length} session${r.hits.length === 1 ? '' : 's'} with matches</div>` +
    r.hits.map((h, i) => `
    <div class="search-hit row-in" style="animation-delay:${Math.min(i * 20, 300)}ms">
      <a class="search-hit-head" href="#/session/${esc(h.slug)}/${esc(h.id)}">
        <span class="sh-title">${esc(h.title)}</span>
        <span class="sh-meta">${esc(h.project)}${h.when ? ' · ' + fmtDateShort(h.when) : ''}</span>
      </a>
      ${h.snippets.map(s => `
      <a class="sh-snip" href="#/session/${esc(h.slug)}/${esc(h.id)}${s.t ? '/at/' + encodeURIComponent(s.t) : ''}" title="jump to this message">
        <span class="sh-k ${s.kind}">${s.kind === 'user' ? 'YOU' : 'CLAUDE'}</span><span>${mark(s.text, r.query)}</span>
      </a>`).join('')}
    </div>`).join('');
}

// ---------------------------------------------------------------- USAGE

function fmtCost(n) { return '$' + (n || 0).toFixed(2); }

const usageState = { days: 30 };
const USAGE_RANGES = [7, 30, 90, 120];

// signed WoW delta chip; hidden when the previous week has no data
function deltaChip(cur, prev, label) {
  if (!prev) return '';
  const pct = Math.round((cur - prev) / prev * 100);
  if (!isFinite(pct)) return '';
  const up = pct >= 0;
  return `<span class="delta ${up ? 'up' : 'down'}" title="last 7 days vs the 7 before">${up ? '▲' : '▼'} ${Math.abs(pct)}% ${label}</span>`;
}

async function viewUsage() {
  await boot();
  const u = await api('/api/usage?days=' + usageState.days);
  const t = u.totals;

  const maxDay = Math.max(1, ...u.series.map(d => d.out));
  const bars = u.series.map((d, i) =>
    `<div class="ubar ${d.out ? 'on' : ''}" style="height:${d.out ? Math.max(4, Math.round(d.out / maxDay * 96)) : 2}px;animation-delay:${Math.min(i * 12, 500)}ms">
      <span class="tip">${d.date.slice(5)} — ${fmtTokens(d.out)} tok · ${d.prompts} pr${d.cost ? ' · ' + fmtCost(d.cost) : ''}</span>
    </div>`).join('');

  const maxModel = Math.max(1, ...u.models.map(m => m.out));
  const modelRows = u.models.map(m => `
    <div class="ubar-row">
      <span class="ubar-lab">${esc(modelShort(m.model))}</span>
      <span class="ubar-track"><i style="width:${Math.max(2, Math.round(m.out / maxModel * 100))}%"></i></span>
      <span class="ubar-val">${fmtTokens(m.out)}</span>
    </div>`).join('') || `<div class="empty">No model data.</div>`;

  const maxProj = Math.max(1, ...u.projects.map(p => p.cost));
  const projRows = u.projects.map(p => `
    <div class="ubar-row">
      <span class="ubar-lab" title="${esc(p.project)}">${esc(p.project)}</span>
      <span class="ubar-track"><i style="width:${Math.max(2, Math.round(p.cost / maxProj * 100))}%"></i></span>
      <span class="ubar-val">${fmtCost(p.cost)} · ${fmtTokens(p.out)}</span>
    </div>`).join('') || `<div class="empty">No project data.</div>`;

  const rangeCost = u.series.reduce((a, d) => a + d.cost, 0);
  const w = u.weeks || { cur: {}, prev: {} };
  const chips = [
    deltaChip(w.cur.out, w.prev.out, 'TOK'),
    deltaChip(w.cur.cost, w.prev.cost, 'SPEND'),
    deltaChip(w.cur.prompts, w.prev.prompts, 'PROMPTS'),
  ].filter(Boolean).join('');

  main.innerHTML = `
  <div class="view">
    <div class="view-head">
      <div>
        <div class="view-kicker">TOKENS &amp; SPEND · ALL TIME</div>
        <h1 class="view-title">USAGE</h1>
      </div>
      <div class="day-controls" id="usage-range">
        ${USAGE_RANGES.map(d => `<button class="btn ${u.days === d ? 'btn-amber' : ''}" data-days="${d}">${d}D</button>`).join('')}
      </div>
    </div>

    <div class="day-ledger">
      <span><b data-count="${t.out}" data-fmt="tok">0</b> TOK OUT</span><span class="sep">·</span>
      <span><b data-count="${t.in}" data-fmt="tok">0</b> TOK IN</span><span class="sep">·</span>
      <span><b data-count="${t.cacheRead}" data-fmt="tok">0</b> CACHE READ</span><span class="sep">·</span>
      <span><b>${fmtCost(t.cost)}</b> EST. SPEND</span><span class="sep">·</span>
      <span><b data-count="${t.sessions}">0</b> SESSIONS</span>
      ${chips ? `<span class="sep">·</span>${chips}` : ''}
    </div>

    <section class="hours">
      <div class="hours-title">TOKENS OUT · LAST ${u.days} DAYS · ${fmtCost(rangeCost)} EST.</div>
      <div class="hours-grid usage-grid" style="grid-template-columns:repeat(${u.series.length},1fr)">${bars}</div>
    </section>

    <div class="usage-cols">
      <section>
        <div class="col-title">BY MODEL</div>
        ${modelRows}
      </section>
      <section>
        <div class="col-title">BY PROJECT — TOP ${u.projects.length}</div>
        ${projRows}
      </section>
    </div>
    <div class="usage-note">This is what your usage <em>would</em> cost at pay-as-you-go API rates — priced per message from each one's own model and exact token counts, not your actual (subscription) bill. Rates live in <code>lib/store.js › PRICING</code>.</div>
  </div>`;

  $$('#usage-range [data-days]').forEach(b => b.onclick = () => {
    usageState.days = Number(b.dataset.days);
    viewUsage();
  });
  $$('[data-count]').forEach(countUp);
}

// ---------------------------------------------------------------- ACTIVE

let activePoll = null;

async function viewActive() {
  await boot();
  main.innerHTML = `
  <div class="view">
    <div class="view-head"><div>
      <div class="view-kicker">RUNNING NOW · LOCAL FLEET</div>
      <h1 class="view-title">ACTIVE</h1>
    </div></div>
    <div id="active-body"><div class="boot-note">scanning…</div></div>
  </div>`;

  const load = async () => {
    try { renderActive(await api('/api/active')); } catch {}
  };
  await load();
  clearInterval(activePoll);
  activePoll = setInterval(load, 4000);
}

function renderActive(a) {
  const body = $('#active-body');
  if (!body) return;
  const runsHtml = a.runs.length ? a.runs.map(r => {
    if (r.persisted) {
      const when = r.startedAt ? `${fmtDateShort(r.startedAt)} ${fmtTime(r.startedAt)}` : '';
      return `
      <div class="active-run persisted" title="${esc(r.resultText || '')}">
        <span class="lamp ${lampClass(r.status)}"></span>
        <span class="ar-prompt">${esc(r.prompt)}</span>
        <span class="ar-meta">${when}${r.costUsd ? ` · $${r.costUsd.toFixed(2)}` : ''}${r.durationMs ? ' · ' + fmtDur(r.durationMs) : ''}</span>
        <span class="ar-status">${esc(r.status.toUpperCase())}
          <button class="btn btn-ghost btn-sm" data-rerun="${esc(r.id)}" title="run again with the same prompt/target">↻</button>
        </span>
      </div>`;
    }
    return `
    <div class="active-run" data-openrun="${esc(r.id)}" data-prompt="${esc(r.prompt)}">
      <span class="lamp ${lampClass(r.status)}"></span>
      <span class="ar-prompt">${esc(r.prompt)}</span>
      <span class="ar-meta">${esc(r.model || '')}${r.dangerous ? ' · YOLO' : ''} · ${r.events} ev</span>
      <span class="ar-status">${esc(r.status.toUpperCase())}</span>
    </div>`;
  }).join('') : `<div class="empty">No runs yet — launch one from the pad.</div>`;

  const sessHtml = a.sessions.length ? a.sessions.map(s => `
    <a class="active-sess" href="#/session/${esc(s.slug)}/${esc(s.id)}">
      <span class="as-dot"></span>
      <span class="as-title">${esc(s.title)}</span>
      <span class="as-meta">${esc(s.project)} · ${fmtTime(s.end)}${s.gitBranch ? ' · ⎇ ' + esc(s.gitBranch) : ''}</span>
    </a>`).join('') : `<div class="empty">No sessions touched in the last 15 minutes.</div>`;

  body.innerHTML = `
    <section class="active-sec">
      <div class="col-title">HELM RUNS — ${a.runs.length}</div>
      ${runsHtml}
    </section>
    <section class="active-sec">
      <div class="col-title">ACTIVE ELSEWHERE — LAST 15 MIN</div>
      <p class="active-hint">Sessions with activity in any terminal recently. HELM can see them, but only manages runs it launched.</p>
      ${sessHtml}
    </section>`;

  $$('[data-openrun]').forEach(el => el.onclick = () => {
    const id = el.dataset.openrun;
    if (!state.runs.find(r => r.id === id)) attachRun(id, el.dataset.prompt, { open: true });
    else { state.activeRun = id; consoleEl.hidden = false; consoleEl.classList.add('open'); $('#console-toggle').textContent = '▼'; renderConsole(); }
  });
  $$('[data-rerun]').forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    try {
      const { id, queued } = await api('/api/rerun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: el.dataset.rerun }) });
      const src = a.runs.find(r => r.id === el.dataset.rerun);
      attachRun(id, src ? src.prompt : '(re-run)', { status: queued ? 'queued' : 'running' });
    } catch (err) { alert(err.message); }
  });
}

// ---------------------------------------------------------------- CONSOLE

const consoleEl = $('#console');
const consoleBody = $('#console-body');
const consoleTabs = $('#console-tabs');
const consoleLamp = $('#console-lamp');
const killBtn = $('#console-kill');
const rerunBtn = $('#console-rerun');
const copyBtn = $('#console-copy');
const clearBtn = $('#console-clear');

$('#console-bar').onclick = (e) => {
  if (e.target.closest('button') && !e.target.closest('#console-toggle')) return;
  consoleEl.classList.toggle('open');
  $('#console-toggle').textContent = consoleEl.classList.contains('open') ? '▼' : '▲';
};

function lampClass(status) {
  if (status === 'running') return 'lamp-amber lamp-pulse';
  if (status === 'queued') return 'lamp-queued lamp-pulse';
  if (status === 'done') return 'lamp-green';
  return 'lamp-red';
}

function attachRun(id, prompt, opts = {}) {
  const { open = true, status = 'running', silent = false } = opts;
  const run = { id, prompt, status, lines: [], silent, notified: false };
  state.runs.unshift(run);
  if (open || !state.activeRun) state.activeRun = id;
  consoleEl.hidden = false;
  if (open) {
    consoleEl.classList.add('open');
    $('#console-toggle').textContent = '▼';
  }
  renderConsole();

  const es = new EventSource('/api/run-stream?id=' + id);
  es.onmessage = (msg) => {
    let ev; try { ev = JSON.parse(msg.data); } catch { return; }
    run.lines.push(ev);
    if (ev.kind === 'launch' && run.status === 'queued') run.status = 'running'; // dequeued
    if (ev.kind === 'done') run.status = 'done';
    if (ev.kind === 'error') run.status = 'error';
    if (ev.kind === 'result' && !ev.ok) run.status = 'error';
    if ((ev.kind === 'done' || ev.kind === 'error') && !run.notified && !run.silent) {
      run.notified = true;
      notifyRunEnd(run);
    }
    if (state.activeRun === id) renderConsole(true);
    else renderTabs();
  };
  es.addEventListener('eof', () => { es.close(); if (run.status === 'running') run.status = 'done'; renderConsole(); });
  es.onerror = () => { /* server closes on completion */ };
}

function renderTabs() {
  const live = $('#nav-live');
  if (live) live.hidden = !state.runs.some(r => r.status === 'running');
  consoleTabs.innerHTML = state.runs.slice(0, 8).map(r => `
    <button class="${state.activeRun === r.id ? 'active' : ''}" data-runtab="${r.id}">
      <span class="lamp ${lampClass(r.status)}"></span>
      ${esc(r.prompt.length > 30 ? r.prompt.slice(0, 29) + '…' : r.prompt)}
    </button>`).join('');
  $$('[data-runtab]').forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    state.activeRun = el.dataset.runtab;
    renderConsole();
  });
}

function renderConsole(append = false) {
  renderTabs();
  const run = state.runs.find(r => r.id === state.activeRun);
  if (!run) {
    consoleBody.innerHTML = '';
    killBtn.hidden = rerunBtn.hidden = copyBtn.hidden = clearBtn.hidden = true;
    return;
  }

  consoleLamp.className = 'lamp ' + lampClass(run.status);
  const finished = run.status !== 'running' && run.status !== 'queued';
  killBtn.hidden = finished;
  killBtn.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id }) });
  };
  rerunBtn.hidden = !finished;
  rerunBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      const { id } = await api('/api/rerun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id }) });
      attachRun(id, run.prompt);
    } catch (err) { alert(err.message); }
  };
  copyBtn.hidden = !finished;
  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    const result = [...run.lines].reverse().find(l => l.kind === 'result' && l.text);
    const text = result ? result.text : run.lines.filter(l => l.kind === 'text').map(l => l.text).join('\n\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'COPIED ✓';
      setTimeout(() => { copyBtn.textContent = 'COPY'; }, 1500);
    } catch { alert('Clipboard unavailable.'); }
  };
  clearBtn.hidden = !state.runs.some(r => r.status !== 'running');
  clearBtn.onclick = (e) => {
    e.stopPropagation();
    state.runs = state.runs.filter(r => r.status === 'running');
    if (!state.runs.find(r => r.id === state.activeRun)) state.activeRun = (state.runs[0] || {}).id || null;
    if (!state.runs.length) { consoleEl.hidden = true; consoleEl.classList.remove('open'); }
    renderConsole();
  };

  const line = (ev) => {
    switch (ev.kind) {
      case 'launch': return `<div class="cl cl-launch"><span class="g">$</span><span class="b">${esc(ev.text)}</span></div>`;
      case 'init': return `<div class="cl cl-init"><span class="g">◈</span><span class="b">session up — ${esc(modelShort(ev.model || ''))} — ${ev.tools} tools</span></div>`;
      case 'text': return `<div class="cl cl-text"><span class="g">·</span><span class="b">${esc(ev.text)}</span></div>`;
      case 'tool': return `<div class="cl cl-tool"><span class="g">▸</span><span class="b"><span class="tn">${esc(ev.name)}</span>  ${esc(ev.detail || '')}</span></div>`;
      case 'result': return `<div class="cl cl-result ${ev.ok ? '' : 'bad'}"><span class="g">${ev.ok ? '✓' : '✕'}</span><span class="b">${esc(ev.text || ev.subtype)}${ev.durationMs ? `\n— ${fmtDur(ev.durationMs)}${ev.costUsd ? ` · $${ev.costUsd.toFixed(2)}` : ''} · ${ev.turns || '?'} turns` : ''}</span></div>`;
      case 'error': return `<div class="cl cl-error"><span class="g">✕</span><span class="b">${esc(ev.text)}</span></div>`;
      case 'done': return `<div class="cl cl-done"><span class="g">■</span><span class="b">${esc(ev.text)}</span></div>`;
      default: return '';
    }
  };

  const atBottom = consoleBody.scrollHeight - consoleBody.scrollTop - consoleBody.clientHeight < 60;
  consoleBody.innerHTML = run.lines.map(line).join('');
  if (!append || atBottom) consoleBody.scrollTop = consoleBody.scrollHeight;
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetEl() && !sheetEl().hidden) { closeSheet(); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '1') location.hash = '#/today';
  else if (e.key === '2') location.hash = '#/launch';
  else if (e.key === '3') location.hash = '#/sessions';
  else if (e.key === '4') location.hash = '#/search';
  else if (e.key === '5') location.hash = '#/usage';
  else if (e.key === '6') location.hash = '#/active';
  else if (e.key === '/') {
    const inp = $('.main .input');
    if (inp) { e.preventDefault(); inp.focus(); }
  } else if (e.key === 'ArrowLeft' && currentDay) {
    location.hash = '#/today/' + shiftDay(currentDay, -1);
  } else if (e.key === 'ArrowRight' && currentDay && currentDay !== localDayStr()) {
    const next = shiftDay(currentDay, 1);
    location.hash = next === localDayStr() ? '#/today' : '#/today/' + next;
  }
});

// ---------------------------------------------------------------- init

(async function init() {
  // Reattach to live runs the server still remembers (page reloads don't lose telemetry)
  try {
    const runs = await api('/api/runs');
    const live = runs.filter(r => !r.persisted);
    // silent: replayed events from already-finished runs must not fire notifications
    for (const r of live.slice(0, 8).reverse()) attachRun(r.id, r.prompt, { open: false, silent: r.status !== 'running' && r.status !== 'queued', status: r.status === 'queued' ? 'queued' : 'running' });
  } catch {}
  route();
})();
