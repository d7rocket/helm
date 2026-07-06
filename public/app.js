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

// ---------------------------------------------------------------- router

const routes = [
  { re: /^#\/today(?:\/(\d{4}-\d{2}-\d{2}))?$/, view: viewToday, nav: 'today' },
  { re: /^#\/launch$/, view: viewLaunch, nav: 'launch' },
  { re: /^#\/sessions$/, view: viewSessions, nav: 'sessions' },
  { re: /^#\/session\/([\w.-]+)\/([\w-]+)$/, view: viewSessionDetail, nav: 'sessions' },
];

async function route() {
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

  const maxHour = Math.max(1, ...day.hourHist);
  const hourBars = day.hourHist.map((n, h) =>
    `<div class="hbar ${n ? 'on' : ''}" style="height:${n ? Math.max(7, Math.round((n / maxHour) * 74)) : 2}px">
      ${n ? `<span class="tip">${String(h).padStart(2, '0')}:00 — ${n} prompt${n > 1 ? 's' : ''}</span>` : ''}
    </div>`).join('');
  const hourLabels = Array.from({ length: 24 }, (_, h) => `<span>${String(h).padStart(2, '0')}</span>`).join('');

  const sorties = day.sessions
    .slice()
    .sort((a, b2) => (a.start || '').localeCompare(b2.start || ''))
    .map(s => `
    <article class="sortie">
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

  const pfeed = day.prompts.map(p => `
    <div class="pline">
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
      <span><b>${st.promptCount}</b> PROMPTS</span><span class="sep">·</span>
      <span><b>${st.sessionCount}</b> SESSIONS</span><span class="sep">·</span>
      <span><b>${st.projectCount}</b> PROJECTS</span><span class="sep">·</span>
      <span><b>${fmtTokens(st.tokensOut)}</b> TOKENS OUT</span>
      ${st.models.length ? `<span class="sep">·</span><span>${st.models.map(modelShort).map(esc).join(' + ')}</span>` : ''}
    </div>

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
}

// ---------------------------------------------------------------- LAUNCHPAD

const CATS = [
  ['all', 'ALL'], ['pinned', 'PINNED'], ['personal', 'PERSONAL'], ['design', 'DESIGN'],
  ['gsd', 'GSD'], ['pbi', 'POWER BI'], ['toolkit', 'TOOLKIT'],
];

async function viewLaunch() {
  const b = await boot();
  const cfg = b.config;

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
    </div>
    <div class="cat-tabs" id="cat-tabs"></div>

    <div class="target-strip">
      <span>TARGET</span>
      <span class="select-wrap"><select class="select" id="target-proj"></select></span>
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

  const yolo = $('#yolo');
  yolo.onclick = async (e) => {
    e.preventDefault();
    const next = !state.boot.config.dangerous;
    yolo.classList.toggle('on', next);
    $('#yolo-label').textContent = next ? 'YOLO ARMED' : 'PERMISSIONS ON';
    await saveConfig({ dangerous: next });
  };

  const q = $('#skill-q');
  q.oninput = () => { state.launch.q = q.value; renderSkillList(); };
  renderCatTabs();
  renderSkillList();
  q.focus();
}

function renderCatTabs() {
  const b = state.boot;
  const pins = new Set(b.config.pins);
  const counts = { all: b.skills.length, pinned: pins.size };
  for (const s of b.skills) counts[s.category] = (counts[s.category] || 0) + 1;
  $('#cat-tabs').innerHTML = CATS.map(([id, label]) =>
    `<button data-cat="${id}" class="${state.launch.cat === id ? 'active' : ''}">${label}<span class="cnt">${counts[id] || 0}</span></button>`).join('');
  $$('#cat-tabs button').forEach(btn => btn.onclick = () => {
    state.launch.cat = btn.dataset.cat;
    renderCatTabs(); renderSkillList();
  });
}

let openSkill = null;

function renderSkillList() {
  const b = state.boot;
  const pins = new Set(b.config.pins);
  const q = state.launch.q.trim().toLowerCase();
  const cat = state.launch.cat;

  let list = b.skills.filter(s => {
    if (cat === 'pinned' && !pins.has(s.name)) return false;
    if (cat !== 'all' && cat !== 'pinned' && s.category !== cat) return false;
    if (q && !(s.name + ' ' + s.description).toLowerCase().includes(q)) return false;
    return true;
  });
  list.sort((a, z) => (pins.has(z.name) - pins.has(a.name)) || a.name.localeCompare(z.name));

  $('#skill-list').innerHTML = list.length ? list.map(s => {
    const open = openSkill === s.name;
    return `
    <div class="skill-row ${open ? 'open' : ''}" data-skill="${esc(s.name)}">
      <button class="pin-btn ${pins.has(s.name) ? 'pinned' : ''}" data-pin="${esc(s.name)}" title="pin">${pins.has(s.name) ? '◆' : '◇'}</button>
      <div class="skill-name">/${esc(s.name)}</div>
      <div class="skill-desc">${esc(s.description || '—')}</div>
      <div class="skill-acts">
        <button class="btn btn-sm btn-amber" data-run="${esc(s.name)}">RUN ▸</button>
        <button class="btn btn-sm" data-term="${esc(s.name)}">TERM ⧉</button>
      </div>
      ${open ? `
      <div class="skill-expand">
        <input class="input" id="skill-args" placeholder="arguments (optional) — appended to /${esc(s.name)}" autocomplete="off">
        <button class="btn btn-amber" data-runargs="${esc(s.name)}">LAUNCH ▸</button>
      </div>` : ''}
    </div>`;
  }).join('') : `<div class="empty">NO MATCHES.<br><b>Nothing on the pad for “${esc(q)}”.</b></div>`;

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
  $$('#skill-list [data-runargs]').forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    launchSkill(el.dataset.runargs, $('#skill-args').value.trim());
  });
  $$('#skill-list [data-term]').forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    const cwd = $('#target-proj').value;
    await api('/api/terminal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, command: '/' + el.dataset.term }),
    }).catch(err => alert(err.message));
  });
  $$('#skill-list .skill-row').forEach(row => row.onclick = () => {
    openSkill = openSkill === row.dataset.skill ? null : row.dataset.skill;
    renderSkillList();
    if (openSkill) $('#skill-args')?.focus();
  });
}

async function launchSkill(name, args) {
  const cwd = $('#target-proj').value;
  const dangerous = state.boot.config.dangerous;
  const prompt = '/' + name + (args ? ' ' + args : '');
  try {
    const { id } = await api('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, cwd, dangerous }),
    });
    attachRun(id, prompt);
  } catch (e) {
    alert(e.message);
  }
}

// ---------------------------------------------------------------- SESSIONS

async function viewSessions() {
  if (!state.sessions) state.sessions = await api('/api/sessions');
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

  const render = () => {
    const q = state.sessFilter.q.trim().toLowerCase();
    const proj = state.sessFilter.project;
    const list = sessions.filter(s => {
      if (proj && s.project !== proj) return false;
      if (q && !((s.title || '') + ' ' + (s.firstPrompt || '') + ' ' + s.project).toLowerCase().includes(q)) return false;
      return true;
    });
    $('#sess-list').innerHTML = `
      <div class="list-head">
        <span>DATE</span><span>SESSION</span><span>PROJECT</span>
        <span class="r">DUR</span><span class="r">TOOLS</span><span class="r">TOK OUT</span>
      </div>` +
      (list.map(s => {
        const d = s.start ? new Date(s.start) : null;
        return `
        <a class="sess-row" href="#/session/${esc(s.slug)}/${esc(s.id)}">
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
  };

  $('#sess-q').oninput = (e) => { state.sessFilter.q = e.target.value; render(); };
  $('#sess-proj').onchange = (e) => { state.sessFilter.project = e.target.value; render(); };
  render();
}

// ---------------------------------------------------------------- SESSION DETAIL

async function viewSessionDetail(slug, id) {
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
      <div class="tl-user"><div class="who">DEVESH · ${b.t ? fmtTime(b.t) : ''}</div>
      <div class="txt">${esc(b.text)}</div></div>`;
    if (b.kind === 'assistant') return `
      <div class="tl-assistant"><div class="txt">${md(b.text)}</div></div>`;
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
    </div>
    <div class="timeline">${html}
      ${detail.truncated ? `<div class="tl-turn">TRUNCATED · ${detail.truncated} MORE EVENTS</div>` : ''}
    </div>
  </div>`;

  $$('[data-more]').forEach(el => el.onclick = () => {
    const idx = Number(el.dataset.more);
    const b = blocks[idx];
    $(`[data-block="${idx}"]`).innerHTML =
      b.items.map(t => `<div class="tl-tool"><span class="tn">${esc(t.name)}</span><span class="td">${esc(t.detail || '')}</span></div>`).join('');
  });
}

// ---------------------------------------------------------------- CONSOLE

const consoleEl = $('#console');
const consoleBody = $('#console-body');
const consoleTabs = $('#console-tabs');
const consoleLamp = $('#console-lamp');
const killBtn = $('#console-kill');

$('#console-bar').onclick = (e) => {
  if (e.target.closest('button') && !e.target.closest('#console-toggle')) return;
  consoleEl.classList.toggle('open');
  $('#console-toggle').textContent = consoleEl.classList.contains('open') ? '▼' : '▲';
};

function attachRun(id, prompt) {
  const run = { id, prompt, status: 'running', lines: [] };
  state.runs.unshift(run);
  state.activeRun = id;
  consoleEl.hidden = false;
  consoleEl.classList.add('open');
  $('#console-toggle').textContent = '▼';
  renderConsole();

  const es = new EventSource('/api/run-stream?id=' + id);
  es.onmessage = (msg) => {
    let ev; try { ev = JSON.parse(msg.data); } catch { return; }
    run.lines.push(ev);
    if (ev.kind === 'done') run.status = 'done';
    if (ev.kind === 'error') run.status = 'error';
    if (ev.kind === 'result' && !ev.ok) run.status = 'error';
    if (state.activeRun === id) renderConsole(true);
    else renderTabs();
  };
  es.addEventListener('eof', () => { es.close(); if (run.status === 'running') run.status = 'done'; renderConsole(); });
  es.onerror = () => { /* server closes on completion */ };
}

function renderTabs() {
  consoleTabs.innerHTML = state.runs.slice(0, 8).map(r => `
    <button class="${state.activeRun === r.id ? 'active' : ''}" data-runtab="${r.id}">
      <span class="lamp ${r.status === 'running' ? 'lamp-amber lamp-pulse' : r.status === 'done' ? 'lamp-green' : 'lamp-red'}"></span>
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
  if (!run) { consoleBody.innerHTML = ''; return; }

  consoleLamp.className = 'lamp ' + (run.status === 'running' ? 'lamp-amber lamp-pulse' : run.status === 'done' ? 'lamp-green' : 'lamp-red');
  killBtn.hidden = run.status !== 'running';
  killBtn.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id }) });
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

// ---------------------------------------------------------------- init

route();
