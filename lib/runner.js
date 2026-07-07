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
const MAX_EVENTS = 5000;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const runs = new Map(); // id -> run

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

function startRun({ prompt, cwd, dangerous }) {
  if (activeCount() >= MAX_CONCURRENT) {
    return { error: `Concurrency limit: ${MAX_CONCURRENT} runs already active.` };
  }
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { error: 'Target project directory does not exist.' };
  }
  if (!prompt || !prompt.trim()) return { error: 'Empty prompt.' };

  const id = crypto.randomBytes(6).toString('hex');
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (dangerous) args.push('--dangerously-skip-permissions');

  const run = {
    id, prompt, cwd, dangerous: !!dangerous,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
    listeners: new Set(),
    proc: null,
  };
  runs.set(id, run);

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
    pushEvent(run, { kind: 'error', text: 'Failed to launch claude: ' + e.message });
    return { id };
  }
  run.proc = proc;
  pushEvent(run, { kind: 'launch', text: `claude -p "${prompt}" — ${cwd}${dangerous ? ' — YOLO' : ''}` });

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
  });

  return { id };
}

function killRun(id) {
  const run = runs.get(id);
  if (!run || run.status !== 'running') return false;
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
  return [...runs.values()]
    .map(r => ({
      id: r.id, prompt: r.prompt, cwd: r.cwd, dangerous: r.dangerous,
      status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
      events: r.events.length,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function getRun(id) { return runs.get(id) || null; }

// Open an interactive terminal at `cwd` running claude (optionally a command).
// Windows: Windows Terminal if present, else cmd. macOS: Terminal.app via
// osascript. Linux: the first terminal emulator we can find.
function openTerminal({ cwd, command }) {
  if (!cwd || !fs.existsSync(cwd)) return { error: 'Directory does not exist.' };
  const claude = findClaude();
  // Slash commands go as one quoted arg; flag-style commands (--resume <id>) go raw.
  const safe = String(command || '').replace(/["&|<>^%!$`]/g, '').trim();

  try {
    if (IS_WIN) {
      const winCmd = safe ? (safe.startsWith('/') ? `${claude} "${safe}"` : `${claude} ${safe}`) : claude;
      const child = hasWindowsTerminal()
        ? spawn('cmd', ['/c', 'start', '', 'wt', '-d', cwd, 'cmd', '/k', winCmd],
            { detached: true, stdio: 'ignore', windowsHide: true })
        : spawn('cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && ${winCmd}`],
            { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { ok: true };
    }

    // POSIX: build the claude invocation (safe already stripped of shell metachars).
    const claudeCmd = safe ? `${shq(claude)} ${safe.startsWith('/') ? shq(safe) : safe}` : shq(claude);
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

module.exports = { startRun, killRun, listRuns, getRun, openTerminal, findClaude };
