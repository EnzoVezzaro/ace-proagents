# ACE — install the crew, then govern it

## What this repository is

Two things in one zero-dependency Node package:

- **the installer** — `ace setup` interrogates the operator, inspects the target
  repository, prints a plan, applies it and verifies it. It installs six linked
  parts (see `docs/STACK.md`), and it is what this repository is *for*.
- **the runtime** — the governance layer (`ace govern` / `crew` / `task` /
  `handoff` / `watchdog` / `adapters`) that governs what the installer wrote, plus
  the `ace/v1` package surface (`init` / `install` / `run`) it grew out of.

The same `ace/v1` `ace` key is written by `ace setup` (from the answers) and by
`ace init` (as a scaffold). Nothing about the spec is installer-only.

## Layout

- `ace.mjs` — the CLI router and every package command. `node ace.mjs --help` is
  authoritative for the command surface.
- `lib/stack.mjs` — the six parts (`PARTS`), the plan/apply/verify pipeline, and
  the generators for every file written into a target repo.
- `lib/intake.mjs` — the questions, answer validation, repository inspection, and
  the context every part is built from (including the id/space/name rules).
- `lib/cli-stack.mjs` — `ace setup` and `ace parts`.
- `assets/stack/orchestration/**` — the bundle copied **verbatim** into a target
  repo: `tabs.mjs`, `selftest.mjs`, `README.md`, `lib/{topology,cap,herdr,ego,handoff,free-models}.mjs`.
- `lib/pkg.mjs`, `lib/runtime.mjs`, `lib/registry.mjs` — manifest/lockfile,
  durable state and events, the local file registry.
- `lib/config.mjs`, `lib/crew.mjs`, `lib/governance.mjs`, `lib/watchdog.mjs`,
  `lib/bots.mjs`, `lib/cli-governance.mjs` — the layered effective configuration,
  the roster/budget/boundary, the governor and supervisor cycles, the independent
  control plane, the experimental management bots, and the governance commands.
- `lib/adapters/` — the swap points (`index.mjs`) and the deterministic fakes
  (`impl.mjs`). Core modules never import a product.
- `schemas/workspace.schema.json` — the `ace/v1` schema for the `ace` key.
- `docs/STACK.md` — what the installer installs, how the parts link, vendored
  versus generated, and which copy of the bundle is which. `docs/APP-INTEGRATION.md`
  — the machine-readable surface a UI may consume.
- `test/*.test.mjs` — `test/stack.test.mjs` is the installer's acceptance suite.
- `site/` — the static landing (`index.html`, `styles.css`, `app.js`,
  `vendor/motion.mjs`); `launch/` — launch materials.
- `PRODUCT.md` product framing · `DESIGN.md` the Phosphor Terminal design world ·
  `PLAN.md` the historical build contracts · `SECURITY.md` the reporting policy.

The installer files — `lib/stack.mjs`, `lib/intake.mjs`, `lib/cli-stack.mjs`,
`assets/stack/**`, `docs/STACK.md`, `test/stack.test.mjs` — are on `origin/main`
(pushed 2026-10-13). The `v0.1.3` tag predates them and carries the runtime only.

## Commands

```bash
node ace.mjs --help                    # the command surface
node ace.mjs parts --questions --json  # the intake schema, with defaults and reasons
node ace.mjs setup --dry-run --goal "…" --outcome "…" --projects path/a,path/b
node ace.mjs setup …                   # the same, for real: plan → apply → verify

npm test                               # node --test test/*.test.mjs — builtin runner, zero deps
npm run check                          # node --check over ace.mjs, lib/**, assets/stack/** and site/app.js
```

CI (`.github/workflows/ci.yml`) runs the syntax check, a scaffold smoke run, a
**crew-stack smoke run** (install into a scratch repo, then run the installed
`orchestration/selftest.mjs`) and the tests on every push and pull request. There
is no install step: the package has no dependencies.

To exercise an install by hand, work in a scratch directory — never in this repo:

```bash
d=$(mktemp -d) && cd "$d"
mkdir -p experiments/api && echo '# api' > experiments/api/README.md
printf '{"name":"scratch","version":"1.0.0","scripts":{"test":"node --test"}}' > package.json
node <this-repo>/ace.mjs setup --goal "…" --outcome "…" --projects experiments/api
node orchestration/selftest.mjs        # the written code proves itself, offline
node orchestration/tabs.mjs cap        # reads the generated data; no multiplexer needed
```

## Invariants (enforced in code, not by prompt)

- **One name per project.** `project.id === its tab label === its browser space
  === basename(its tree)`. `lib/topology.mjs` (`placementInvariant`) and
  `lib/ego.mjs` (`spaceInvariant`) return violations rather than describing a
  project whose names disagree; `ace setup` refuses to write one, and the
  installed `selftest.mjs` fails on it.
- **Always 1 + N tabs.** One `control-plane` tab (the governor plus one supervisor
  per project) and one tab per project (that project's workers). Adding a project
  adds one tab by data, never a second control plane.
- **One global worker budget.** Every project tab combined, every harness kind
  combined; the control plane is never counted and never trimmed; the cap is a
  **setting with a reported source**, not a constant.
- **Free models only.** A model may be assigned work only when its freeness is
  established for that run. A name containing `-free` is not evidence, and with
  nothing verified the dispatch is **refused** — never silently billed.
- **Evidence or silence.** A handoff that claims `DONE` without a command, a path
  or a measurement is recorded `unverified`, not done. Passing in a worker's own
  pane does not prove the integrated tree passes.
- **The governor talks to supervisors only.** A governor → worker message is
  refused in code and names the supervisor to use instead.
- **Recovery is bounded and audited.** Checkpoint first, hold the lease, respect
  `recovery.*`, journal to `.ace/actions.jsonl`, and never report a restart that
  was not delivered. A heartbeat alone is not proof of work.
- **Everything third-party is an adapter**, and management bots stay experimental
  and off by default.
- **The installer verifies what it wrote** and reports a check it could not run
  as `skip` with its reason — never as a pass.

## Rules for agents

- **Zero dependencies.** Never add npm dependencies (runtime or dev); tests use
  the builtin `node:test` runner only.
- **A shipped asset is fixed at its source.** The bundle in `assets/stack/` is
  what other people install: change it there, then re-run `ace setup --force`
  where the fix must land. Never patch only an installed copy.
- **Never weaken a check, an assertion or a refusal to make something pass.**
  That includes the verifier in `lib/stack.mjs`, the installed `selftest.mjs`, the
  free-model refusal, and the budget. If a check is wrong, fix *why* it is wrong
  and say so; if the requested behaviour requires changing a check, explain that
  in the change.
- **Installs stay idempotent.** A generated file that already exists and differs
  is reported and left alone unless `--force` is explicit; memory files are seeded
  once and never overwritten, not even with `--force`; `.acc-memory.md` and the
  `ace` key are the only places a second run has anything to say about.
- **Do not fake a timestamp** to make a generated document byte-identical, and do
  not "fix" an idempotency report by rewriting content that did not change.
- **Honesty gates.** Never invent a customer, a benchmark, a price or an
  installation claim on the landing or in the docs, and never show a command in
  the landing that a visitor could not actually run today.
- **Self-contained site.** No external assets (fonts, scripts, styles); links to
  this repository are fine.
- **No secrets.** Never commit tokens, keys or `.env` files.
- **Shared checkouts.** Run `git status` before staging and stage explicit paths —
  other agents work in this repo at the same time.
- **A new configuration field is four changes**: `lib/config.mjs` (defaults and
  validation), `schemas/workspace.schema.json`, the tests, and the README/`docs`
  together — `test/schema.test.mjs` fails otherwise.
- **Third-party capability = adapter**: add a provider to `lib/adapters/index.mjs`
  and a fake to `lib/adapters/impl.mjs`.
- **Never report a check you did not run.** Reports carry `checksNotRun`, and a
  completion claim with no command that exited 0 is rejected.
- **The npm release lags the repository until it is published deliberately.**
  `origin/main` carries the installer and the runtime, and npm ships `0.1.4`, the
  first release with the installer; `0.1.2` and the `v0.1.3` tag predate it.
  State the registry version as it actually is. Bump the version, publish, push a
  tag or deploy only when asked — and when you do, update this file, `README.md`,
  `PRODUCT.md` and the landing page in the same change.

## Ownership

Owner: `ace.mjs` (router) with `lib/stack.mjs` (the installer). Contracts:
`docs/STACK.md` for the installed stack, `PLAN.md` for the module contracts.
