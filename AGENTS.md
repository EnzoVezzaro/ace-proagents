# ACE — Agentic Compute Environment

## Purpose

Zero-dependency Node CLI and `ace/v1` spec for Git-native packages that
describe reproducible orchestrator-driven agentic coding environments.
The package describes the environment — orchestrator, workers, tools,
models, policies, memory, lifecycle — not application source.

## Layout

- `ace.mjs` — the CLI (bin: `ace`). `node ace.mjs --help` is authoritative for commands.
- `lib/` — `pkg.mjs` (manifest/lockfile), `runtime.mjs` (durable state + events),
  `registry.mjs` (local file registry), and the governance layer: `config.mjs`
  (layered effective configuration), `crew.mjs` (roster, budget, boundary),
  `governance.mjs` (governor + supervisor cycles), `watchdog.mjs` (independent
  control plane), `bots.mjs` (experimental management bots), `cli-governance.mjs`
  (the governance commands), `adapters/` (the swap points + deterministic fakes)
- `schemas/` — ace/v1 JSON schemas
- `site/` — static landing (`index.html`, `donate.html`, `styles.css`, `app.js`, `vendor/motion.mjs`)
- `launch/` — launch materials
- `PLAN.md` — module contracts, phases, worker assignments
- `PRODUCT.md` — product framing; `DESIGN.md` — Phosphor Terminal design world

## Commands

```bash
node ace.mjs init --name <n>   # scaffold a workspace (copies ace.mjs + lib/ recursively)
node ace.mjs --help            # full command reference, including the governance surface
npm test                       # node --test test/ — built-in runner only, zero deps
npm run check                  # node --check over ace.mjs, lib/** and site/app.js
```

CI (`.github/workflows/ci.yml`) runs syntax check + scaffold smoke + tests on
every push and pull request. There is no install step: the package has no
dependencies.

## Governance invariants (enforced in code, not by prompt)

- The governor talks to **supervisors only**. `crew.checkRoute` refuses a
  governor → worker message and names the supervisor to use instead.
- The active-agent limit defaults to **4 and is not a maximum**. Every start goes
  through `crew.canStart`, which counts every active agent across every runtime;
  never bypass it and never hard-code 4.
- A handoff is a **durable artifact with evidence**, never a claim. Passing in a
  worker's isolated workspace does not prove the integrated project passes — the
  supervisor re-runs the checks after integrating.
- Recovery is **bounded and audited**: checkpoint first, hold the lease, respect
  `recovery.*`, journal to `.ace/actions.jsonl`, and never report a restart that
  was not delivered.
- A heartbeat is not proof of work: liveness needs a recent heartbeat *and* a
  live pid, and progress needs task movement or events inside the window.
- Everything third-party sits behind the adapter contract in
  `lib/adapters/index.mjs`. Core modules must not import a product.
- Management bots are **experimental and off by default**, and submit work
  through ACE's budget and policies or not at all.

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
- **Configuration changes are four changes.** A new field updates
  `lib/config.mjs` (defaults + validation), `schemas/workspace.schema.json`,
  tests and the README/PLAN together — `test/schema.test.mjs` fails otherwise.
- **Third-party capabilities are adapters.** Add a provider to
  `lib/adapters/index.mjs` and a fake to `lib/adapters/impl.mjs`; never import a
  product from the core modules.
- **Never report a check you did not run.** Reports carry `checksNotRun`, and
  `verifyHandoff` rejects a completion claim with no command that exited 0.

## Ownership

Owner: `ace.mjs` (CLI). Contracts: `PLAN.md`.
