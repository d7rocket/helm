// HELM runner — launches headless Claude Code runs (`claude -p`) and streams
// their stream-json output to the UI over SSE. Also opens interactive
// terminals. Local, single-user; runs are kept in memory.
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_CONCURRENT = 3;
const MAX_QUEUED = 10;
const MAX_EVENTS = 5000;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const runs = new Map(); // id -> run
const queue = [];       // ids waiting for a free slot

// ---------------------------------------------------------------------------
// Persisted history — finished runs survive server restarts (data/runs.json).
// Events are not persisted (too big); we keep the final result summary.
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const HISTORY_MAX = 200;
let history = [];
try { history = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')).slice(0, HISTORY_MAX); } catch {}

function persistRun(run) {
  const last = [...run.events].reverse().find(e => e.kind === 'result') || {};
  history.unshift({
    id: run.id, prompt: run.prompt, cwd: run.cwd, dangerous: run.dangerous, model: run.model,
    status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
    events: run.events.length,
    resultText: String(last.text || '').slice(0, 600),
    costUsd: last.costUsd || 0, durationMs: last.durationMs || 0, turns: last.turns || 0,
  });
  history = history.slice(0, HISTORY_MAX);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = RUNS_FILE + '.tmp';           // atomic write: temp in same dir, then rename
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(tmp, RUNS_FILE);
  } catch {}
}

// Resolve an executable on PATH cross-platform (`where` on Windows, `which` elsewhere).
function which(cmd) {
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const lines = (r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    return IS_WIN ? (lines.find(l => /\.(exe|cmd|bat)$/i.test(l)) || lines[0]) : lines[0];
  } catch { return null; }
}

let claudeBin = null;
function findClaude() {
  if (claudeBin) return claudeBin;
  const home = os.homedir();
  const guesses = IS_WIN
    ? [path.join(home, '.local', 'bin', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  for (const g of guesses) if (fs.existsSync(g)) { claudeBin = g; return claudeBin; }
  claudeBin = which('claude') || 'claude'; // fall back to bare name and hope PATH resolves it
  return claudeBin;
}

let wtAvailable = null;
function hasWindowsTerminal() {
  if (wtAvailable !== null) return wtAvailable;
  wtAvailable = !!which('wt');
  return wtAvailable;
}

// POSIX single-quote a string so it survives a shell command line intact.
function shq(s) { return `'` + String(s).replace(/'/g, `'\\''`) + `'`; }

function activeCount() {
  let n = 0;
  for (const r of runs.values()) if (r.status === 'running') n++;
  return n;
}

function pushEvent(run, ev) {
  ev.i = run.events.length;
  if (run.events.length < MAX_EVENTS) run.events.push(ev);
  for (const l of run.listeners) l(ev);
}

function mapStreamLine(o) {
  // Map claude CLI stream-json lines to compact UI events
  if (o.type === 'system' && o.subtype === 'init') {
    return { kind: 'init', model: o.model, cwd: o.cwd, tools: (o.tools || []).length };
  }
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const evs = [];
    for (const item of o.message.content) {
      if (item.type === 'text' && item.text && item.text.trim()) {
        evs.push({ kind: 'text', text: item.text });
      } else if (item.type === 'tool_use') {
        const input = item.input || {};
        let detail = input.description || input.file_path || input.command || input.pattern || input.prompt || '';
        detail = String(detail).replace(/\s+/g, ' ').slice(0, 160);
        evs.push({ kind: 'tool', name: item.name, detail });
      }
    }
    return evs;
  }
  if (o.type === 'result') {
    return {
      kind: 'result',
      ok: o.subtype === 'success',
      subtype: o.subtype,
      text: typeof o.result === 'string' ? o.result : '',
      durationMs: o.duration_ms,
      costUsd: o.total_cost_usd,
      turns: o.num_turns,
    };
  }
  return null;
}

// Only a curated set of model aliases is accepted, so a bad UI value can never
// reach the CLI. Empty/unknown → omit --model (inherit the CLI default).
const MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
function modelArg(m) { return MODELS.has(String(m || '')) ? String(m) : ''; }

function startRun({ prompt, cwd, dangerous, model }) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { error: 'Target project directory does not exist.' };
  }
  if (!prompt || !prompt.trim()) return { error: 'Empty prompt.' };

  const id = crypto.randomBytes(6).toString('hex');
  const run = {
    id, prompt, cwd, dangerous: !!dangerous, model: modelArg(model),
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
    listeners: new Set(),
    proc: null,
  };

  // At capacity → queue instead of erroring; pump() launches it when a slot frees.
  if (activeCount() >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUED) return { error: `Queue full: ${MAX_QUEUED} runs already waiting.` };
    run.status = 'queued';
    runs.set(id, run);
    queue.push(id);
    pushEvent(run, { kind: 'text', text: `Queued — position ${queue.length}, ${MAX_CONCURRENT} runs active.` });
    return { id, queued: true };
  }

  runs.set(id, run);
  spawnRun(run);
  return { id };
}

// Launch queued runs while slots are free.
function pump() {
  while (activeCount() < MAX_CONCURRENT && queue.length) {
    const run = runs.get(queue.shift());
    if (!run || run.status !== 'queued') continue;
    run.status = 'running';
    spawnRun(run);
  }
}

function spawnRun(run) {
  const { id, prompt, cwd, dangerous, model: mdl } = run;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (mdl) args.push('--model', mdl);
  if (dangerous) args.push('--dangerously-skip-permissions');

  let proc;
  try {
    proc = spawn(findClaude(), args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    run.status = 'error';
    run.endedAt = new Date().toISOString();
    pushEvent(run, { kind: 'error', text: 'Failed to launch claude: ' + e.message });
    persistRun(run);
    return;
  }
  run.proc = proc;
  pushEvent(run, { kind: 'launch', text: `claude -p "${prompt}" — ${cwd}${mdl ? ' — ' + mdl : ''}${dangerous ? ' — YOLO' : ''}` });

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const mapped = mapStreamLine(o);
      if (!mapped) continue;
      for (const ev of Array.isArray(mapped) ? mapped : [mapped]) pushEvent(run, ev);
    }
  });
  let errBuf = '';
  proc.stderr.on('data', (c) => { errBuf = (errBuf + c.toString('utf8')).slice(-4000); });
  proc.on('close', (code) => {
    run.endedAt = new Date().toISOString();
    if (run.status === 'killed') {
      pushEvent(run, { kind: 'done', text: 'Run killed.' });
    } else if (code === 0) {
      run.status = 'done';
      pushEvent(run, { kind: 'done', text: 'Run complete.' });
    } else {
      run.status = 'error';
      pushEvent(run, { kind: 'error', text: `Exited with code ${code}. ${errBuf.slice(-600)}` });
    }
    persistRun(run);
    pump();
  });
}

// Relaunch a finished run with its original parameters (live or persisted).
function rerun(id) {
  const old = runs.get(id) || history.find(h => h.id === id);
  if (!old) return { error: 'run not found' };
  if (old.status === 'running' || old.status === 'queued') return { error: 'run is still active' };
  return startRun({ prompt: old.prompt, cwd: old.cwd, dangerous: old.dangerous, model: old.model });
}

function killRun(id) {
  const run = runs.get(id);
  if (!run) return false;
  if (run.status === 'queued') {
    // Not spawned yet — just drop it from the queue.
    const qi = queue.indexOf(id);
    if (qi >= 0) queue.splice(qi, 1);
    run.status = 'killed';
    run.endedAt = new Date().toISOString();
    pushEvent(run, { kind: 'done', text: 'Run killed (was queued).' });
    persistRun(run);
    return true;
  }
  if (run.status !== 'running') return false;
  run.status = 'killed';
  const pid = run.proc && run.proc.pid;
  if (IS_WIN) {
    // Kill the whole process tree — claude spawns children.
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
  } else {
    try { run.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 2500);
  }
  return true;
}

function listRuns() {
  const live = [...runs.values()].map(r => ({
    id: r.id, prompt: r.prompt, cwd: r.cwd, dangerous: r.dangerous, model: r.model,
    status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
    events: r.events.length,
  }));
  const liveIds = new Set(live.map(r => r.id));
  const past = history
    .filter(h => !liveIds.has(h.id))
    .map(h => ({ ...h, persisted: true }));
  return [...live, ...past].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

function getRun(id) { return runs.get(id) || null; }

// Open an interactive terminal at `cwd` running claude (optionally a command).
// Windows: Windows Terminal if present, else cmd. macOS: Terminal.app via
// osascript. Linux: the first terminal emulator we can find.
function openTerminal({ cwd, command, model }) {
  if (!cwd || !fs.existsSync(cwd)) return { error: 'Directory does not exist.' };
  const claude = findClaude();
  const mdl = modelArg(model);
  const claudeCli = mdl ? `${claude} --model ${mdl}` : claude;
  // Slash commands go as one quoted arg; flag-style commands (--resume <id>) go raw.
  const safe = String(command || '').replace(/["&|<>^%!$`]/g, '').trim();

  try {
    if (IS_WIN) {
      const winCmd = safe ? (safe.startsWith('/') ? `${claudeCli} "${safe}"` : `${claudeCli} ${safe}`) : claudeCli;
      const child = hasWindowsTerminal()
        ? spawn('cmd', ['/c', 'start', '', 'wt', '-d', cwd, 'cmd', '/k', winCmd],
            { detached: true, stdio: 'ignore', windowsHide: true })
        : spawn('cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && ${winCmd}`],
            { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { ok: true };
    }

    // POSIX: build the claude invocation (safe already stripped of shell metachars).
    const claudeBase = mdl ? `${shq(claude)} --model ${mdl}` : shq(claude);
    const claudeCmd = safe ? `${claudeBase} ${safe.startsWith('/') ? shq(safe) : safe}` : claudeBase;
    const inner = `cd ${shq(cwd)} && ${claudeCmd}`;

    if (IS_MAC) {
      const script = `tell application "Terminal"\nactivate\ndo script ${shq(inner)}\nend tell`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }

    // Linux — probe common emulators, keep the shell open after claude exits.
    const keep = `${inner}; exec "$SHELL"`;
    const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'kitty', 'xterm']
      .find(which);
    if (!term) return { error: 'No terminal emulator found. Install gnome-terminal, konsole, or xterm.' };
    const args = term === 'gnome-terminal'
      ? ['--', 'bash', '-c', keep]
      : ['-e', `bash -c ${shq(keep)}`];
    spawn(term, args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) {
    return { error: 'Failed to open terminal: ' + e.message };
  }
}

module.exports = { startRun, rerun, killRun, listRuns, getRun, openTerminal, findClaude };
