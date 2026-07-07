// HELM — local agentic operations console for Claude Code.
// Zero dependencies. Binds to 127.0.0.1 only. Nothing leaves this machine.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const store = require('./lib/store');
const runner = require('./lib/runner');

const PORT = Number(process.env.HELM_PORT || 7777);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'data', 'helm.config.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { pins: [], defaultProject: '', dangerous: true, model: '' }; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback for hash-less deep links
      if (!path.extname(rel)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        });
        return;
      }
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000' : 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/boot': async (req, res) => {
    const [skills, projects] = await Promise.all([store.getSkills(), store.getProjects()]);
    sendJSON(res, 200, { skills, projects, config: readConfig(), claudeBin: runner.findClaude() });
  },

  'GET /api/day': async (req, res, q) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : store.dayOf(Date.now());
    sendJSON(res, 200, await store.getDay(date));
  },

  'GET /api/sessions': async (req, res) => {
    const sessions = await store.getSessions();
    sendJSON(res, 200, sessions.map(s => ({
      id: s.id, slug: s.slug, title: s.title, firstPrompt: s.firstPrompt,
      project: s.project, cwd: s.cwd, gitBranch: s.gitBranch,
      start: s.start, end: s.end, durationMs: s.durationMs,
      prompts: s.prompts, assistantMsgs: s.assistantMsgs, toolCalls: s.toolCalls,
      tokens: s.tokens, models: Object.keys(s.models), sizeKB: s.sizeKB,
    })));
  },

  'GET /api/session': async (req, res, q) => {
    const detail = await store.getSessionDetail(q.slug || '', q.id || '');
    if (!detail) return sendJSON(res, 404, { error: 'session not found' });
    sendJSON(res, 200, detail);
  },

  'GET /api/search': async (req, res, q) => {
    sendJSON(res, 200, await store.searchTranscripts(q.q || ''));
  },

  'GET /api/usage': async (req, res, q) => {
    const days = Math.min(120, Math.max(7, Number(q.days) || 30));
    sendJSON(res, 200, await store.getUsage(days));
  },

  'GET /api/active': async (req, res) => {
    const runs = runner.listRuns();
    const sessions = await store.getRecentlyActive(15 * 60 * 1000, Date.now());
    sendJSON(res, 200, { runs, sessions });
  },

  'PUT /api/config': async (req, res) => {
    const body = await readBody(req);
    const cfg = readConfig();
    if (Array.isArray(body.pins)) cfg.pins = body.pins.filter(p => typeof p === 'string').slice(0, 200);
    if (typeof body.defaultProject === 'string') cfg.defaultProject = body.defaultProject;
    if (typeof body.dangerous === 'boolean') cfg.dangerous = body.dangerous;
    if (typeof body.model === 'string') cfg.model = body.model;
    writeConfig(cfg);
    sendJSON(res, 200, cfg);
  },

  'POST /api/skill/toggle': async (req, res) => {
    const body = await readBody(req);
    const result = store.toggleSkill(String(body.name || ''), !!body.disable);
    sendJSON(res, result.error ? 400 : 200, result);
  },

  'GET /api/skill/source': async (req, res, q) => {
    const src = store.getSkillSource(String(q.name || ''));
    if (!src) return sendJSON(res, 404, { error: 'not found' });
    sendJSON(res, 200, src);
  },

  'POST /api/run': async (req, res) => {
    const body = await readBody(req);
    const result = runner.startRun({
      prompt: String(body.prompt || '').slice(0, 4000),
      cwd: String(body.cwd || ''),
      dangerous: !!body.dangerous,
      model: String(body.model || ''),
    });
    sendJSON(res, result.error ? 400 : 200, result);
  },

  'POST /api/rerun': async (req, res) => {
    const body = await readBody(req);
    const result = runner.rerun(String(body.id || ''));
    sendJSON(res, result.error ? 400 : 200, result);
  },

  'POST /api/kill': async (req, res) => {
    const body = await readBody(req);
    sendJSON(res, 200, { ok: runner.killRun(String(body.id || '')) });
  },

  'GET /api/runs': async (req, res) => {
    sendJSON(res, 200, runner.listRuns());
  },

  'POST /api/terminal': async (req, res) => {
    const body = await readBody(req);
    const result = runner.openTerminal({
      cwd: String(body.cwd || ''),
      command: body.command ? String(body.command).slice(0, 500) : null,
      model: String(body.model || ''),
    });
    sendJSON(res, result.error ? 400 : 200, result);
  },
};

function handleRunStream(req, res, q) {
  const run = runner.getRun(String(q.id || ''));
  if (!run) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const ev of run.events) send(ev);
  if (run.status !== 'running' && run.status !== 'queued') { res.write('event: eof\ndata: {}\n\n'); res.end(); return; }
  const listener = (ev) => {
    send(ev);
    if (ev.kind === 'done' || ev.kind === 'error') {
      res.write('event: eof\ndata: {}\n\n');
      cleanup();
      res.end();
    }
  };
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);
  const cleanup = () => { clearInterval(hb); run.listeners.delete(listener); };
  run.listeners.add(listener);
  req.on('close', cleanup);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname === '/api/run-stream' && req.method === 'GET') {
    return handleRunStream(req, res, parsed.query);
  }

  const key = `${req.method} ${pathname}`;
  const handler = routes[key];
  if (handler) {
    try { await handler(req, res, parsed.query); }
    catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }
  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'no such endpoint' });
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  HELM · agentic operations console`);
  console.log(`  http://${HOST}:${PORT}\n`);
  console.log(`  data source : ${store.CLAUDE_DIR}`);
  console.log(`  claude bin  : ${runner.findClaude()}`);
  console.log(`  binding     : localhost only — nothing leaves this machine\n`);
});
