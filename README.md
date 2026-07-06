# HELM

> Your agentic operations console. Daily flight logs, one-click skill launches, and every Claude Code session on one local instrument panel — nothing leaves the machine.

## What it is

HELM sits on top of Claude Code's own data (`~/.claude`) and turns it into an operations room:

| View | What it shows |
|------|---------------|
| **Today** | A date-navigable daily report — prompts, sessions, projects, tokens out, activity by hour, a flight log of every sortie, and the raw prompt feed |
| **Launchpad** | All 129 skills and commands as one-click buttons. Pick a target project, arm YOLO or keep permissions, hit RUN for a headless streamed run or TERM to open a real terminal |
| **Sessions** | Every transcript across every project — searchable ledger with titles, durations, tool calls, and tokens. Click through to the full conversation timeline |
| **Console** | Live telemetry for headless runs — tool calls tick in as the agent works, with cost and duration on landing |

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Server | Node.js, zero dependencies | Nothing to install, nothing to update, nothing phoning home |
| Data | Reads `~/.claude` transcripts, history, skills — read-only | Claude Code already keeps the records; HELM just instruments them |
| Runs | Spawns `claude -p --output-format stream-json`, streamed over SSE | Real headless agent runs from a button |
| Frontend | Vanilla HTML/CSS/JS, fonts bundled locally | No build step, no CDN, works offline |
| Binding | `127.0.0.1:7777` only | Local-first by construction |

## Quick start

```
double-click helm.cmd
```

or

```
node server.js
# then open http://127.0.0.1:7777
```

## Layout

```
helm/
├── server.js          HTTP server, API routes, SSE
├── lib/
│   ├── store.js       ~/.claude parsers (sessions, history, skills) + cache
│   └── runner.js      headless claude runs, kill, terminal launch
├── public/
│   ├── index.html     shell
│   ├── styles.css     the instrument panel
│   ├── app.js         router + views
│   └── fonts/         Bricolage Grotesque · Hanken Grotesk · Fragment Mono
├── data/              helm.config.json (pins, target, yolo) — gitignored
└── helm.cmd           double-click launcher
```

## Notes

- **YOLO ARMED** runs headless with `--dangerously-skip-permissions`. Flip it off to run permission-gated instead.
- Runs are capped at 3 concurrent; kill any run from the console bar.
- All parsing is cached by file mtime — first load reads ~65 MB of transcripts, after that it's instant.
