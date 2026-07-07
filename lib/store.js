// HELM data layer — reads ~/.claude (transcripts, history, skills, commands).
// Everything is read-only against Claude Code's own files; parse results are
// cached in memory keyed by (path, mtime, size).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
// Disabling a skill/command means moving it off Claude Code's discovery path
// into these sibling dirs. Fully reversible; keeps skills/ and commands/ pristine.
const SKILLS_OFF_DIR = path.join(CLAUDE_DIR, 'skills-disabled');
const COMMANDS_OFF_DIR = path.join(CLAUDE_DIR, 'commands-disabled');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

const cache = new Map(); // key -> { stamp, value }

function stamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

async function cached(key, file, compute) {
  const s = stamp(file);
  const hit = cache.get(key);
  if (hit && hit.stamp === s) return hit.value;
  const value = await compute();
  cache.set(key, { stamp: s, value });
  return value;
}

function dayOf(ts) {
  // Local calendar day for a timestamp (ISO string or epoch ms)
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Pricing (USD per 1M tokens) — ESTIMATE of what these tokens WOULD cost at
// pay-as-you-go API rates. Not a billed figure (a subscription bills flat).
// Cache rates derive from input: read 0.1x, write(5m) 1.25x. Current-gen models
// have no >200K long-context premium. Tune these to your plan if rates change.
// ---------------------------------------------------------------------------

const PRICING = {
  fable:  { in: 10, out: 50, cacheRead: 1.0,  cacheWrite: 12.5 },
  opus:   { in: 5,  out: 25, cacheRead: 0.5,  cacheWrite: 6.25 },
  sonnet: { in: 3,  out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  haiku:  { in: 1,  out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
  _default: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
function priceFor(model) {
  const s = String(model).replace(/^claude-/, '');
  for (const k of Object.keys(PRICING)) if (k[0] !== '_' && s.includes(k)) return PRICING[k];
  return PRICING._default;
}
// Exact per-message cost — each assistant message priced by ITS own model and usage.
function messageCost(model, u) {
  const p = priceFor(model);
  return (u.input_tokens || 0) / 1e6 * p.in
    + (u.output_tokens || 0) / 1e6 * p.out
    + (u.cache_read_input_tokens || 0) / 1e6 * p.cacheRead
    + (u.cache_creation_input_tokens || 0) / 1e6 * p.cacheWrite;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const clip = (s, n = 120) => {
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  if (input.description) return clip(input.description);
  if (input.file_path) return clip(input.file_path);
  if (input.command) return clip(input.command);
  if (input.pattern) return clip(input.pattern);
  if (input.skill) return clip('/' + input.skill + (input.args ? ' ' + input.args : ''));
  if (input.prompt) return clip(input.prompt);
  if (input.url) return clip(input.url);
  if (input.query) return clip(input.query);
  for (const v of Object.values(input)) if (typeof v === 'string') return clip(v);
  return '';
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    fn(obj);
  }
}

function parseSessionFile(slug, file) {
  const id = path.basename(file, '.jsonl');
  const sum = {
    id, slug,
    title: null, firstPrompt: null,
    cwd: null, gitBranch: null,
    start: null, end: null,
    prompts: 0, assistantMsgs: 0, toolCalls: 0, sidechainMsgs: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,              // exact per-message cost estimate (USD, API rates)
    models: {},           // model -> output tokens
    tools: {},            // tool name -> count
    perDay: {},           // day -> { prompts, out }
    sizeKB: 0,
  };
  try { sum.sizeKB = Math.round(fs.statSync(file).size / 1024); } catch {}

  return new Promise((resolve) => {
    eachLine(file, (o) => {
      if (o.timestamp) {
        if (!sum.start || o.timestamp < sum.start) sum.start = o.timestamp;
        if (!sum.end || o.timestamp > sum.end) sum.end = o.timestamp;
      }
      if (o.type === 'ai-title' && o.aiTitle) sum.title = o.aiTitle;

      if (o.type === 'user' && o.message) {
        if (o.isSidechain) { sum.sidechainMsgs++; return; }
        if (!sum.cwd && o.cwd) sum.cwd = o.cwd;
        if (!sum.gitBranch && o.gitBranch) sum.gitBranch = o.gitBranch;
        const c = o.message.content;
        const isHuman = typeof c === 'string' && !o.isMeta
          && !/^\s*</.test(c) && !/^Caveat:/.test(c) && !/^\[Request interrupted/.test(c);
        if (isHuman) {
          sum.prompts++;
          if (!sum.firstPrompt) sum.firstPrompt = c.replace(/\s+/g, ' ').trim().slice(0, 200);
          if (o.timestamp) {
            const d = dayOf(o.timestamp);
            (sum.perDay[d] = sum.perDay[d] || { prompts: 0, out: 0, cost: 0 }).prompts++;
          }
        }
      }

      if (o.type === 'assistant' && o.message) {
        if (o.isSidechain) { sum.sidechainMsgs++; }
        else sum.assistantMsgs++;
        const m = o.message;
        const u = m.usage || {};
        sum.tokens.in += u.input_tokens || 0;
        sum.tokens.out += u.output_tokens || 0;
        sum.tokens.cacheRead += u.cache_read_input_tokens || 0;
        sum.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
        const mCost = (m.model && m.model !== '<synthetic>') ? messageCost(m.model, u) : 0;
        sum.cost += mCost;
        if (m.model) sum.models[m.model] = (sum.models[m.model] || 0) + (u.output_tokens || 0);
        if (o.timestamp) {
          const d = dayOf(o.timestamp);
          const pd = (sum.perDay[d] = sum.perDay[d] || { prompts: 0, out: 0, cost: 0 });
          pd.out += u.output_tokens || 0;
          pd.cost = (pd.cost || 0) + mCost;
        }
        if (Array.isArray(m.content)) {
          for (const item of m.content) {
            if (item.type === 'tool_use') {
              sum.toolCalls++;
              sum.tools[item.name] = (sum.tools[item.name] || 0) + 1;
            }
          }
        }
      }
    }).then(() => resolve(sum)).catch(() => resolve(sum));
  });
}

// Claude Code slugifies a cwd by replacing every non-alphanumeric run with '-'.
// Derive this machine's home-dir slug so we can strip it back off generically.
const HOME_SLUG = os.homedir().replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '');

// Convert a projects-dir slug back to something readable using the cwd we
// found inside the transcript; fall back to de-slugging (home-relative).
function projectNameFromCwd(cwd, slug) {
  if (cwd) {
    const base = path.basename(cwd);
    return base || cwd;
  }
  let s = slug;
  if (HOME_SLUG && s.startsWith(HOME_SLUG)) s = s.slice(HOME_SLUG.length).replace(/^-+/, '');
  return s.replace(/-/g, '/') || 'home';
}

async function listSessionFiles() {
  const out = [];
  let slugs = [];
  try { slugs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const slug of slugs) {
    const dir = path.join(PROJECTS_DIR, slug);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (e.endsWith('.jsonl')) out.push({ slug, file: path.join(dir, e) });
    }
  }
  return out;
}

async function getSessions() {
  const files = await listSessionFiles();
  const sums = await Promise.all(
    files.map(({ slug, file }) =>
      cached(`sess:${file}`, file, () => parseSessionFile(slug, file)))
  );
  const sessions = sums
    .filter(s => s.prompts > 0 || s.assistantMsgs > 0)
    .map(s => ({
      ...s,
      project: projectNameFromCwd(s.cwd, s.slug),
      durationMs: s.start && s.end ? (new Date(s.end) - new Date(s.start)) : 0,
    }));
  sessions.sort((a, b) => (b.end || '').localeCompare(a.end || ''));
  return sessions;
}

async function getSessionDetail(slug, id) {
  // Guard: id/slug must resolve inside PROJECTS_DIR
  if (!/^[\w.-]+$/.test(slug) || !/^[\w-]+$/.test(id)) return null;
  const file = path.join(PROJECTS_DIR, slug, id + '.jsonl');
  if (!file.startsWith(PROJECTS_DIR) || !fs.existsSync(file)) return null;

  const events = [];
  const MAX = 3000;
  let truncated = 0;
  const push = (ev) => { if (events.length < MAX) events.push(ev); else truncated++; };

  await eachLine(file, (o) => {
    if (o.isSidechain) return;
    if (o.type === 'user' && o.message && typeof o.message.content === 'string' && !o.isMeta) {
      const c = o.message.content;
      if (/^\s*</.test(c) || /^Caveat:/.test(c)) {
        const cmd = c.match(/<command-name>([^<]+)<\/command-name>/);
        const args = c.match(/<command-args>([^<]*)<\/command-args>/);
        if (cmd) push({ kind: 'command', t: o.timestamp, text: (cmd[1] + ' ' + (args ? args[1] : '')).trim() });
      } else {
        push({ kind: 'user', t: o.timestamp, text: c });
      }
    }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const item of o.message.content) {
        if (item.type === 'text' && item.text && item.text.trim()) {
          push({ kind: 'assistant', t: o.timestamp, text: item.text, model: o.message.model });
        } else if (item.type === 'tool_use') {
          push({ kind: 'tool', t: o.timestamp, name: item.name, detail: summarizeToolInput(item.name, item.input) });
        }
      }
    }
    if (o.type === 'system' && o.subtype === 'turn_duration') {
      push({ kind: 'turn', t: o.timestamp, ms: o.durationMs });
    }
  });

  const summary = (await getSessions()).find(s => s.id === id) || null;
  return { summary, events, truncated };
}

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------

async function getHistory() {
  return cached('history', HISTORY_FILE, async () => {
    const rows = [];
    if (!fs.existsSync(HISTORY_FILE)) return rows;
    await eachLine(HISTORY_FILE, (o) => {
      if (o.display && o.timestamp) {
        rows.push({ t: o.timestamp, text: o.display, project: o.project || '', sessionId: o.sessionId || '' });
      }
    });
    return rows;
  });
}

async function getDay(date) {
  const [history, sessions] = await Promise.all([getHistory(), getSessions()]);
  const prompts = history
    .filter(r => dayOf(r.t) === date)
    .map(r => ({ ...r, project: path.basename(r.project || '') || 'home' }));

  const hourHist = new Array(24).fill(0);
  for (const p of prompts) hourHist[new Date(p.t).getHours()]++;

  const daySessions = sessions.filter(s => s.perDay[date]);
  const tokens = { out: 0 };
  const models = {};
  for (const s of daySessions) {
    tokens.out += s.perDay[date].out;
    // day-attributed output per-model is unavailable; report session models as presence
    for (const m of Object.keys(s.models)) models[m] = 1;
  }

  const projects = [...new Set(daySessions.map(s => s.project))];

  // Days that have any activity (for calendar navigation)
  const activeDays = [...new Set(history.map(r => dayOf(r.t)))].sort();

  // Last 14 calendar days ending today, with prompt counts (for the strip)
  const dayCounts = {};
  for (const r of history) {
    const d = dayOf(r.t);
    dayCounts[d] = (dayCounts[d] || 0) + 1;
  }
  const recent = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const ds = dayOf(dt);
    recent.push({ date: ds, count: dayCounts[ds] || 0, dow: dt.getDay() });
  }

  return {
    date,
    prompts,
    hourHist,
    stats: {
      promptCount: prompts.length,
      sessionCount: daySessions.length,
      projectCount: projects.length,
      tokensOut: tokens.out,
      models: Object.keys(models),
    },
    sessions: daySessions.map(s => ({
      id: s.id, slug: s.slug, title: s.title, firstPrompt: s.firstPrompt,
      project: s.project, start: s.start, end: s.end, durationMs: s.durationMs,
      prompts: s.perDay[date].prompts, tokensOut: s.perDay[date].out,
      toolCalls: s.toolCalls, gitBranch: s.gitBranch,
    })),
    activeDays,
    recent,
  };
}

// ---------------------------------------------------------------------------
// Skills & commands
// ---------------------------------------------------------------------------

const DESIGN_SET = new Set([
  'adapt', 'animate', 'audit', 'bolder', 'canvas-design', 'clarify', 'colorize',
  'critique', 'delight', 'design-taste-frontend', 'distill', 'emil-design-eng',
  'high-end-visual-design', 'impeccable', 'industrial-brutalist-ui', 'layout',
  'make-interfaces-feel-better', 'minimalist-ui', 'optimize', 'overdrive',
  'polish', 'quieter', 'redesign-existing-projects', 'shape',
  'stitch-design-taste', 'typeset', 'ui-ux-pro-max',
]);
const PERSONAL_SET = new Set([
  'ship', 'voice', 'cover', 'readme-gen', 'sync-content', 'inner-council',
  'humanizer', 'full-output-enforcement', 'pbi-docgen', 'validate-phase',
]);

function categorize(name) {
  if (name.startsWith('gsd-')) return 'gsd';
  if (name.startsWith('pbi-')) return 'pbi';
  if (DESIGN_SET.has(name)) return 'design';
  if (PERSONAL_SET.has(name)) return 'personal';
  return 'toolkit';
}

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  // Tolerant single-level YAML: key: value (value may span until next key)
  const lines = m[1].split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s?(.*)$/);
    if (kv) { key = kv[1].toLowerCase(); out[key] = kv[2].trim(); }
    else if (key && line.trim()) out[key] += ' ' + line.trim();
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/^["']|["']$/g, '');
  return out;
}

function readSkillDirs(dir, disabled, into) {
  let dirs = [];
  try { dirs = fs.readdirSync(dir); } catch { return; }
  for (const d of dirs) {
    const f = path.join(dir, d, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(f, 'utf8')); } catch {}
    const name = fm.name || d;
    if (into.has(name)) continue;
    into.set(name, {
      name, kind: 'skill', disabled,
      description: (fm.description || '').slice(0, 400),
      category: categorize(name),
    });
  }
}

function readCommandFiles(dir, disabled, into) {
  let cmds = [];
  try { cmds = fs.readdirSync(dir); } catch { return; }
  for (const c of cmds) {
    if (!c.endsWith('.md')) continue;
    const name = c.replace(/\.md$/, '');
    if (into.has(name)) continue; // skills win over commands, enabled wins over disabled
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(path.join(dir, c), 'utf8')); } catch {}
    into.set(name, {
      name, kind: 'command', disabled,
      description: (fm.description || '').slice(0, 400),
      category: categorize(name),
    });
  }
}

async function getSkills() {
  const items = new Map();
  // Enabled first so it wins on name collisions, then disabled siblings.
  readSkillDirs(SKILLS_DIR, false, items);
  readSkillDirs(SKILLS_OFF_DIR, true, items);
  readCommandFiles(COMMANDS_DIR, false, items);
  readCommandFiles(COMMANDS_OFF_DIR, true, items);
  const list = [...items.values()];
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// Move a skill/command between its live dir and its -disabled sibling.
// `disable=true` turns it off (Claude Code stops discovering it); false re-enables.
// Many names (all pbi-*) exist as BOTH a skill folder and a command file — we
// move every matching copy so the toggle fully takes effect.
function toggleSkill(name, disable) {
  if (!/^[\w.-]+$/.test(name)) return { error: 'invalid skill name' };
  const targets = [
    { on: path.join(SKILLS_DIR, name), off: path.join(SKILLS_OFF_DIR, name), kind: 'skill' },
    { on: path.join(COMMANDS_DIR, name + '.md'), off: path.join(COMMANDS_OFF_DIR, name + '.md'), kind: 'command' },
  ];
  const moved = [];
  for (const t of targets) {
    const src = disable ? t.on : t.off;
    const dst = disable ? t.off : t.on;
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) continue; // already on the target side — treat as done
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      moved.push(t.kind);
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!moved.length) {
    // Nothing to move: verify it already sits on the requested side, else not found.
    const onExists = targets.some(t => fs.existsSync(t.on));
    const offExists = targets.some(t => fs.existsSync(t.off));
    if (disable ? offExists : onExists) return { name, kinds: moved, disabled: !!disable };
    if (!onExists && !offExists) return { error: 'skill not found' };
  }
  return { name, kinds: moved, disabled: !!disable };
}

// Read the raw SKILL.md / command .md body (frontmatter kept) for the detail drawer.
function getSkillSource(name) {
  if (!/^[\w.-]+$/.test(name)) return null;
  const candidates = [
    path.join(SKILLS_DIR, name, 'SKILL.md'),
    path.join(SKILLS_OFF_DIR, name, 'SKILL.md'),
    path.join(COMMANDS_DIR, name + '.md'),
    path.join(COMMANDS_OFF_DIR, name + '.md'),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const body = fs.readFileSync(f, 'utf8');
        return { path: f, body: body.slice(0, 20000), truncated: body.length > 20000 };
      }
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Full-text search across every transcript
// ---------------------------------------------------------------------------

// Extracted searchable messages per transcript, cached by (path, mtime, size) —
// repeat queries scan memory instead of re-reading and re-parsing every .jsonl.
function getSearchDoc(file) {
  return cached(`search:${file}`, file, async () => {
    const rows = [];
    await eachLine(file, (o) => {
      if (o.isSidechain) return;
      if (o.type === 'user' && o.message && typeof o.message.content === 'string' && !o.isMeta) {
        const c = o.message.content;
        if (/^\s*</.test(c) || /^Caveat:/.test(c)) return;
        rows.push({ t: o.timestamp, kind: 'user', text: c });
      } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const it of o.message.content) {
          if (it.type === 'text' && it.text) rows.push({ t: o.timestamp, kind: 'assistant', text: it.text });
        }
      }
    });
    return rows;
  });
}

async function searchTranscripts(query, limit = 60) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return { query, hits: [] };
  const [files, sessions] = await Promise.all([listSessionFiles(), getSessions()]);
  const byId = new Map(sessions.map(s => [s.id, s]));
  const hits = [];

  for (const { slug, file } of files) {
    const id = path.basename(file, '.jsonl');
    const rows = await getSearchDoc(file);
    const snippets = [];
    for (const r of rows) {
      if (snippets.length >= 3) break;
      const idx0 = r.text.toLowerCase().indexOf(q);
      if (idx0 < 0) continue;
      const flat = r.text.replace(/\s+/g, ' ').trim();
      const idx = flat.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 55);
      const snip = (start > 0 ? '…' : '') + flat.slice(start, idx >= 0 ? idx + q.length + 90 : 145) + '…';
      snippets.push({ t: r.t, kind: r.kind, text: snip });
    }
    if (snippets.length) {
      const s = byId.get(id) || {};
      hits.push({
        slug, id, project: s.project || slug,
        title: s.title || s.firstPrompt || 'untitled session',
        when: s.end || s.start, count: snippets.length, snippets,
      });
    }
    if (hits.length >= limit) break;
  }
  hits.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  return { query, hits };
}

// ---------------------------------------------------------------------------
// Usage & cost estimate
// ---------------------------------------------------------------------------

async function getUsage(days = 30) {
  const sessions = await getSessions();
  const daily = {}, byModel = {}, byProject = {};
  const totals = { out: 0, in: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: sessions.length };

  for (const s of sessions) {
    totals.out += s.tokens.out; totals.in += s.tokens.in;
    totals.cacheRead += s.tokens.cacheRead; totals.cacheWrite += s.tokens.cacheWrite;
    const c = s.cost || 0; totals.cost += c;
    for (const [d, v] of Object.entries(s.perDay)) {
      (daily[d] = daily[d] || { out: 0, prompts: 0, cost: 0 });
      daily[d].out += v.out; daily[d].prompts += v.prompts; daily[d].cost += v.cost || 0;
    }
    for (const [m, out] of Object.entries(s.models)) byModel[m] = (byModel[m] || 0) + out;
    const proj = s.project || 'home';
    (byProject[proj] = byProject[proj] || { out: 0, cost: 0, sessions: 0 });
    byProject[proj].out += s.tokens.out; byProject[proj].cost += c; byProject[proj].sessions++;
  }

  // Last `days` calendar days ending today.
  const series = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const ds = dayOf(dt);
    const d = daily[ds] || {};
    series.push({ date: ds, out: d.out || 0, prompts: d.prompts || 0, cost: d.cost || 0 });
  }

  // Week-over-week: last 7 calendar days vs the 7 before them.
  const weekSum = (offset) => {
    const w = { out: 0, prompts: 0, cost: 0 };
    for (let i = offset; i < offset + 7; i++) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const d = daily[dayOf(dt)] || {};
      w.out += d.out || 0; w.prompts += d.prompts || 0; w.cost += d.cost || 0;
    }
    return w;
  };
  const weeks = { cur: weekSum(0), prev: weekSum(7) };

  const models = Object.entries(byModel).map(([m, out]) => ({ model: m, out })).sort((a, b) => b.out - a.out);
  const projects = Object.entries(byProject)
    .map(([project, v]) => ({ project, ...v })).sort((a, b) => b.cost - a.cost).slice(0, 20);

  return { totals, series, models, projects, days, weeks };
}

// Sessions whose last event landed within `withinMs` — a lightweight "active now" signal.
async function getRecentlyActive(withinMs, now) {
  const sessions = await getSessions();
  const cut = now - withinMs;
  return sessions
    .filter(s => s.end && new Date(s.end).getTime() >= cut)
    .slice(0, 12)
    .map(s => ({
      id: s.id, slug: s.slug, title: s.title || s.firstPrompt || 'untitled session',
      project: s.project, end: s.end, prompts: s.prompts, toolCalls: s.toolCalls,
      tokensOut: s.tokens.out, gitBranch: s.gitBranch,
    }));
}

// ---------------------------------------------------------------------------
// Projects (targets for runs)
// ---------------------------------------------------------------------------

async function getProjects() {
  const sessions = await getSessions();
  const byPath = new Map();
  for (const s of sessions) {
    if (!s.cwd) continue;
    if (!fs.existsSync(s.cwd)) continue;
    const cur = byPath.get(s.cwd);
    if (!cur || (s.end || '') > (cur.lastActive || '')) {
      byPath.set(s.cwd, {
        path: s.cwd,
        name: projectNameFromCwd(s.cwd, s.slug),
        lastActive: s.end,
        sessions: (cur ? cur.sessions : 0) + 1,
      });
    } else {
      cur.sessions++;
    }
  }
  const list = [...byPath.values()];
  list.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''));
  return list;
}

module.exports = {
  getSessions, getSessionDetail, getDay, getSkills, getProjects,
  toggleSkill, getSkillSource, searchTranscripts, getUsage, getRecentlyActive,
  dayOf, CLAUDE_DIR,
};
