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

const runs = new Map(); // id -> run

let claudeBin = null;
function findClaude() {
  if (claudeBin) return claudeBin;
  const guess = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(guess)) { claudeBin = guess; return claudeBin; }
  try {
    const r = spawnSync('where', ['claude'], { encoding: 'utf8' });
    const line = (r.stdout || '').split(/\r?\n/).find(l => l.trim().endsWith('.exe') || l.trim().endsWith('.cmd'));
    if (line) { claudeBin = line.trim(); return claudeBin; }
  } catch {}
  claudeBin = 'claude'; // hope PATH resolves it
  return claudeBin;
}

let wtAvailable = null;
function hasWindowsTerminal() {
  if (wtAvailable !== null) return wtAvailable;
  try {
    const r = spawnSync('where', ['wt'], { encoding: 'utf8' });
    wtAvailable = r.status === 0 && (r.stdout || '').trim().length > 0;
  } catch { wtAvailable = false; }
  return wtAvailable;
}

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
  try { run.proc.kill(); } catch {}
  // On Windows, kill the whole tree
  try { spawn('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true }); } catch {}
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

function openTerminal({ cwd, command }) {
  if (!cwd || !fs.existsSync(cwd)) return { error: 'Directory does not exist.' };
  const claude = findClaude();
  const claudeCmd = command ? `${claude} "${command.replace(/"/g, '')}"` : claude;
  let child;
  if (hasWindowsTerminal()) {
    child = spawn('cmd', ['/c', 'start', '', 'wt', '-d', cwd, 'cmd', '/k', claudeCmd],
      { detached: true, stdio: 'ignore', windowsHide: true });
  } else {
    child = spawn('cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && ${claudeCmd}`],
      { detached: true, stdio: 'ignore', windowsHide: true });
  }
  child.unref();
  return { ok: true };
}

module.exports = { startRun, killRun, listRuns, getRun, openTerminal, findClaude };
