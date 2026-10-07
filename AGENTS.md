# ACE — Agentic Compute Environment

## Purpose

Zero-dependency Node CLI and `ace/v1` spec for Git-native packages that
describe reproducible orchestrator-driven agentic coding environments.
The package describes the environment — orchestrator, workers, tools,
models, policies, memory, lifecycle — not application source.

## Layout

- `ace.mjs` — the CLI (bin: `ace`). `node ace.mjs --help` is authoritative for commands.
- `lib/` — `pkg.mjs` (manifest/lockfile), `runtime.mjs`, `registry.mjs` (local file registry)
- `schemas/` — ace/v1 JSON schemas
- `site/` — static landing (`index.html`, `donate.html`, `styles.css`, `app.js`, `vendor/motion.mjs`)
- `launch/` — launch materials
- `PLAN.md` — module contracts, phases, worker assignments
- `PRODUCT.md` — product framing; `DESIGN.md` — Phosphor Terminal design world

## Commands

```bash
node ace.mjs init --name <n>   # scaffold a workspace (copies ace.mjs + lib in)
node ace.mjs --help            # full command reference
node --check ace.mjs           # syntax gate — also lib/*.mjs and site/app.js
node --test test/              # tests when a suite exists — built-in runner only
```

CI (`.github/workflows/ci.yml`) runs syntax check + scaffold smoke + tests on
every push and pull request. There is no install step: the package has no
dependencies.

## Rules for agents

- **Zero dependencies.** Never add npm dependencies (runtime or dev).
  Tests use the built-in `node:test` runner only.
- **Honesty gates.** `window.ACE_CHECKOUT_URL = null` (`site/app.js`) and
  `window.ACE_DONATE_URL = null` (`site/donate.html`) stay null until a live
  Stripe Payment Link exists. Never invent prices, links, or
  `npm install -g` claims — the package is not published to npm yet.
- **Self-contained site.** No external assets (fonts, scripts, styles).
  Content links to this GitHub repository are fine.
- **No secrets.** Never commit tokens, keys, or `.env` files.
- **Shared checkouts.** Run `git status` before staging and stage explicit
  paths — other agents may be working in this repo at the same time.

## Ownership

Owner: `ace.mjs` (CLI). Contracts: `PLAN.md`.
