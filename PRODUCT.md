# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

The product itself is a CLI (`ace.mjs`, zero runtime dependencies, Node 20+).
`web` describes this repository's only visual surface: the static landing under
`site/`, deployed as-is to static hosting (Vercel project `ace`). There is no
native or hosted application in this repository. (Inferred from the codebase and
previously labeled as an inference; unchanged.)

## Users
Primary: developers who already run agentic coding CLIs, and the agents acting on
their behalf. They have a repository with more than one work area and want a crew
working it without holding the arrangement together by hand — no tab list to keep
straight, no browser profile per project, no budget nobody enforces.

The second user is the agent itself: the installer is written so that an agent can
complete it with no terminal to prompt on (`--intake <file>`, or flags, or
`ace parts --questions --json` as the schema). A tool that can only be installed
by a human answering questions cannot be installed by the agents this is for.

They judge a tool in seconds by reading its mechanism and its CLI surface.

## Product Purpose
ACE installs a crew of coding agents into a repository, and then governs it.

`ace setup` interrogates the operator, reads what the repository already says
about itself, and writes the arrangement as data: **six linked parts** — Herdr
spaces (one tab per project plus a control plane), one Ego Lite browser space per
project, a governor over one global worker budget, a supervisor and its workers
per project with a dollar on every task, ACC memory per tree, and the ProAgents
money contract with the handoff convention. The parts are held together by one
name: `project.id === its tab label === its browser space === basename(its tree)`.

Success means a developer understands the mechanism in one screen, trusts the
honesty of the page, and runs the one command.

## Positioning
"Six parts, one name: a crew of agents for your repository." Every part is
useless alone, and each hands one exact name to the next, so installing them
separately is the bug the product exists to remove.

The mechanism a neighbouring tool cannot copy:

- **The parts are linked by an invariant, not by convention.** `lib/topology.mjs`
  and `lib/ego.mjs` return violations, the installer refuses to write a setup whose
  names disagree, and the installed `selftest.mjs` fails on one.
- **What is proven is shipped; what is specific is generated.** The modules are
  copied byte-for-byte from `assets/stack/`; only `projects.json`, the `ace` key,
  the ACC files, the ProAgents layer and `STACK.md` are written per repository.
  So an install is the code that runs, not a template that resembles it.
- **It refuses rather than guesses.** No answers and no terminal → refuse and
  write nothing. Two trees colliding on one id → refuse. A check that cannot run →
  reported `skip` with its reason, never as a pass. No verified free model →
  dispatch refused instead of silently billed. A generated file that already
  exists and differs → left alone, and said so.
- **It verifies what it wrote**, by importing the installed modules and running
  ACE's own configuration validation over the generated `ace` key.

Status: the installer and the governance runtime are on `origin/main` and in the
published package — **npm `0.1.4`**, the first release with the installer;
npm's `0.1.2` and the `v0.1.3` tag predate it.

## Capabilities
Installer first:

- `ace setup` — interrogate → inspect → plan → apply → verify, interactively, from
  `--intake <file.json>`, or from flags; `--dry-run` prints the plan and writes
  nothing; `--parts a,b` installs a subset (requirements come with it); `--force`
  overwrites differing generated files; `--json` emits one document.
- `ace parts [<id>] [--questions]` — the catalogue of the six parts and the intake
  schema an agent answers.

Runtime second (what governs the installed stack):

- `ace config` / `crew` / `govern` / `supervise` / `task` / `handoff` / `route` /
  `heartbeat` / `watchdog` / `bots` / `adapters`, all with `--json`.
- In an installed repo: `node orchestration/tabs.mjs plan|up|status|cap|govern|brief|dispatch|verify|cycle`
  and `node orchestration/selftest.mjs`.

Package surface third (how the `ace/v1` spec is declared by hand):
`ace init`, `install` (git-native, registry optional), `list`, `info`, `search`,
`run`, `status`, `context`, `agents`, `tasks`, `events`, `stop`, `snapshot`,
`restore`, `compose`, `doctor`, `update`, `uninstall`, `secret set`, `activity`,
`logs`, `restart`, `verify`, `autopilot`.

## Constraints (confirmed, must preserve)
- **Zero runtime dependencies.** Node builtins only; tests use the builtin runner.
- **The site is self-contained:** static HTML/CSS/JS with the vendored Motion
  bundle only — no CDN, no network fonts, no external scripts. It deploys as-is.
- **Honesty rules.** `window.ACE_CHECKOUT_URL` and `window.ACE_DONATE_URL` point
  at the one real live Stripe Payment Link (the $9.00 USD/month ACE Pro support
  subscription) and are never replaced with a test-mode or invented link. No
  invented prices, customers, benchmarks or installation claims. ACTUAL /
  ESTIMATE / FORECAST / SCENARIO language is never merged.
- **Money is integer cents** wherever a value is shown.
- **The installer writes only inside the target repository.** It starts no agent,
  creates no tab, opens no browser space, invents no model route, and never
  publishes, pushes or deploys.
- **Installs are idempotent**, and memory files are seeded once and never
  overwritten — not even with `--force`.

## Voice
Precise, technical, confident; mechanism over adjectives. Developer-native
vocabulary: interrogation, plan, apply, verify, topology, worker cap, handoff,
refusal. Say what is not implemented in the same breath as what is.

## Open decisions
- **Which price converts is unmeasured.** ACE Pro is $9.00 USD/month and ACE is
  MIT-style free; there is no measured conversion to point at.
- **The deployed application's source is not in this repository** (the landing in
  `site/` is). Whether it is folded in here is open; `docs/APP-INTEGRATION.md`
  describes the surface such an application would consume.
- **Platform `web` is an inference** from the static-site codebase; no native
  surface exists.
