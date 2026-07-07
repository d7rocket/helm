# HELM

> Your agentic operations console. Daily flight logs, one-click skill launches, and every Claude Code session on one local instrument panel — nothing leaves the machine.

HELM sits on top of Claude Code's own data (`~/.claude`) and turns it into an operations room. It runs entirely on your machine, binds to localhost only, and has zero dependencies — just Node and the `claude` CLI you already have.

## What it is

| View | What it shows |
|------|---------------|
| **Today** | A date-navigable daily report — prompts, sessions, projects, tokens out, activity by hour, a flight log of every sortie, and the raw prompt feed |
| **Launchpad** | Every skill and command you have installed, as one-click buttons. Pick a target project, arm YOLO or keep permissions, hit RUN for a headless streamed run or TERM to open a real terminal |
| **Sessions** | Every transcript across every project — searchable ledger with titles, durations, tool calls, and tokens. Click through to the full conversation timeline |
| **Console** | Live telemetry for headless runs — tool calls tick in as the agent works, with cost and duration on landing |

Dark and light themes ship together (top of the sidebar toggles them; your choice is remembered, and it follows your OS preference on first run).

## Requirements

- **[Node.js](https://nodejs.org) 18+** — no `npm install` needed; HELM has no dependencies.
- **[Claude Code](https://claude.com/claude-code)** on your PATH (the `claude` CLI). HELM reads its `~/.claude` data and spawns runs through it.

Works on **macOS, Linux, and Windows**.

## Quick start

**macOS / Linux**

```sh
./helm.sh
```

**Windows**

```
double-click helm.cmd
```

**Any platform**

```sh
node server.js
# then open http://127.0.0.1:7777
```

Set `HELM_PORT` to bind a different port.

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Server | Node.js, zero dependencies | Nothing to install, nothing to update, nothing phoning home |
| Data | Reads `~/.claude` transcripts, history, skills — read-only | Claude Code already keeps the records; HELM just instruments them |
| Runs | Spawns `claude -p --output-format stream-json`, streamed over SSE | Real headless agent runs from a button |
| Frontend | Vanilla HTML/CSS/JS, fonts bundled locally | No build step, no CDN, works offline |
| Binding | `127.0.0.1:7777` only | Local-first by construction |

## Layout

```
helm/
├── server.js          HTTP server, API routes, SSE
├── lib/
│   ├── store.js       ~/.claude parsers (sessions, history, skills) + cache
│   └── runner.js      headless claude runs, kill, cross-platform terminal launch
├── public/
│   ├── index.html     shell
│   ├── styles.css     the instrument panel (dark + light themes)
│   ├── theme-init.js  sets the theme before first paint (no flash)
│   ├── app.js         router + views
│   └── fonts/         Bricolage Grotesque · Hanken Grotesk · Fragment Mono
├── data/              helm.config.json (pins, target, yolo) — gitignored
├── helm.cmd           Windows launcher
└── helm.sh            macOS / Linux launcher
```

## Notes

- **YOLO ARMED** runs headless with `--dangerously-skip-permissions`. Flip it off to run permission-gated instead.
- Runs are capped at 3 concurrent; kill any run from the console bar.
- All parsing is cached by file mtime — the first load reads your transcripts, after that it's instant.
- Nothing is written to `~/.claude`. HELM only writes its own `data/helm.config.json`.

## Fonts

Bundled locally under `public/fonts/`, all under the SIL Open Font License:
[Bricolage Grotesque](https://github.com/ateliertriay/bricolage), [Hanken Grotesk](https://github.com/marcologous/Hanken-Grotesk), [Fragment Mono](https://github.com/weiweihuanghuang/fragment-mono).

## License

MIT — see [LICENSE](LICENSE).
