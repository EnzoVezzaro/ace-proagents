# ACE

**A skill and one CLI that installs a crew of coding agents into a repository.**
`ace setup` asks what the work is, reads what the repository already says about
itself, and writes the whole arrangement — the terminal spaces, one browser space
per project, a governor over a global worker budget, one supervisor and its
workers per project, durable memory, and a money line on every task.

**Zero runtime dependencies.** Node ESM only (`ace.mjs`), Node 20+. Spec `ace/v1`. MIT.

## The problem it removes

A crew of agents working several areas at once is usually held together by hand:
a terminal tab here, a browser profile there, a note about which agent owns which
tree, a budget nobody enforces. ACE asks a few questions and writes that
arrangement down as data, under one name you can follow wherever you look:

```text
project.id === its tab label === its browser space === basename(its tree)
```

The terminal tab, the browser space, the state directory and the governor's
report all call a project the same thing, so there is one place to look for what
it touched and one place to look for what it did in a browser. Adding a project
is adding data to `orchestration/projects.json` — never editing the installer or
a tab list.

## Design rules

**Git stays the source of truth.** An ACE package describes the *environment* — orchestrator, workers, tools, models, policies, memory, lifecycle — not application source. The local registry indexes specifications; it is optional.

**Specification is not state.** `package.json` (the `ace` key) + `ace-lock.json` describe what should exist, and `orchestration/projects.json` is the data the installed crew reads. What actually exists — missions, handoffs, dispatch and cap logs, heartbeats, leases, routes — lives under `orchestration/state/` and `.ace/`, and neither is published.

## Install

Clone it and run it with Node 20+. There is nothing to build and nothing to
install — the package has no dependencies:

```bash
git clone https://github.com/EnzoVezzaro/ace-proagents.git
cd ace-proagents
node ace.mjs --help
```

`package.json` declares `"bin": { "ace": "./ace.mjs" }`, so `npm i ace-proagents`
also installs an `ace` command. **What is published predates the installer:** npm
serves `0.1.2`, and `origin/main` (tag `v0.1.3`) carries the `ace/v1` package, the
CLI and the governance runtime. The installer — `lib/stack.mjs`,
`lib/intake.mjs`, `lib/cli-stack.mjs`, `assets/stack/**`, `docs/STACK.md`,
`test/stack.test.mjs` — is committed on this checkout's `main` and **not pushed
yet**, so a clone of `origin/main` answers "unknown command: setup".

Run `ace setup` from a checkout that has the installer, with the **target
repository** as the working directory:

```bash
cd /path/to/your-repo
node /path/to/ace-proagents/ace.mjs setup
```

`ace init` copies the CLI and `lib/`, but `assets/stack/` only travels with
`ace setup`. A workspace scaffolded by `init` alone therefore has no bundle to
install, and `setup` refuses (`PLAN_INVALID`, exit 2) rather than writing half an
arrangement.

The other half of the product is the skill an agent loads before running any of
this: `.agents/skills/ace/SKILL.md`. It lives with the workspace that uses ACE
rather than inside this package, and it is the manual for the interrogation, the
six parts, and the rules for driving what was installed.

## Install the crew

```bash
# on a terminal: it asks, and prints why each question matters
node ace.mjs setup

# or answer in one line — how an agent does it, with no terminal to prompt on
node ace.mjs setup \
  --goal "ship the paid API" \
  --money "the $19/mo plan" \
  --projects experiments/alpha-api,experiments/beta-web

node ace.mjs setup --dry-run --json    # the plan alone; writes nothing
node ace.mjs parts --questions         # the intake schema, with defaults and reasons
```

Five stages — **interrogate → inspect → plan → apply → verify** — and it prints
what it decided, what it wrote and what it checked:

```text
plan     — 6 part(s), 21 write(s)
apply    — 21 written, 0 left alone
verify   — 14 passed, 0 failed, 2 not run
```

The two checks reported as *not run* state their precondition instead of passing
quietly: live tab creation needs a running Herdr session, and a governor cycle
needs live state.

With no answers and no terminal, `ace setup` refuses with `INTAKE_INVALID`, names
every missing field and writes nothing. `--intake <file.json>` takes the answers
as a file (the same keys as the flags; `ace parts --questions --json` is the
schema), `--parts a,b` installs a subset (the parts it requires come with it),
and `--force` overwrites generated files that differ. `--harness`, `--model
provider/model`, `--cap`, `--browser`, `--verification`, `--first-task` and
`--deadline` answer the rest of the interrogation.

Exit codes: `0` installed and verified · `1` installed but a check failed, or an
operator must act · `2` a usage, intake or plan error — nothing written.

### The six parts

| Part | What it installs |
|---|---|
| `herdr-spaces` | one Herdr tab per project plus a `control-plane` tab, and the orchestrator that maintains them |
| `ego-lite-spaces` | one Ego Lite browser space per project, named after the project's own tree |
| `govern` | one governor over a **global** worker budget, with free-model-only failover |
| `supervisors-workers` | exactly one supervisor and its workers per project, every task carrying the money line it can produce |
| `acc` | the ACC control file and one `.acc-memory.md` per tree, so a session starts informed |
| `proagents` | the money contract, the handoff convention every mission ends with, and the tool registry |

[docs/STACK.md](./docs/STACK.md) is their map: what each installs, what it
requires, which exact name it hands to the next, and which files are copied
verbatim rather than generated.

### What lands in the repository

```text
orchestration/projects.json   the data: topology, budget, harness policy, projects, tasks
orchestration/tabs.mjs        plan · up · status · cap · govern · brief · dispatch · verify · cycle
orchestration/lib/            topology · cap · herdr · ego · handoff · free-models
orchestration/state/          per-project missions, handoffs, dispatch and cap logs
STACK.md                      the map of what was installed, and how to drive it
.acc-memory.md                durable memory, and one beside each project tree
proagents/                    the money contract, the handoff convention, the tool registry
```

Then, inside a Herdr session:

```bash
node orchestration/tabs.mjs plan        # the roster, and the budget with its source
node orchestration/tabs.mjs up          # create the tabs and start the agents that fit
node orchestration/tabs.mjs govern      # the governor's brief across every project
node orchestration/selftest.mjs         # the installed setup's own proof
```

`orchestration/selftest.mjs` runs offline against the code that was just written
into the repository and prints its own count — 62 assertions on a fresh install,
exit 0, with no multiplexer, no network and no browser. It is the check that
catches a bundle which was copied but cannot actually run.

### What an install does not do

- It starts no agent, creates no tab and opens no browser space. `tabs.mjs up`
  does that, inside a running multiplexer.
- It invents no model route. With no model supplied, none is written, and work is
  refused rather than silently billed when no free model is verified.
- It writes nothing outside the repository, and never publishes or pushes.
- It never clobbers a generated file that already exists and differs: a repo that
  already has a `projects.json` has decisions in it that an installer cannot
  re-derive. Memory files are seeded once and never overwritten at all.
- It does not claim a check passed when the check could not run.

## The package workflow (`init` → `run`)

The installer is one half of ACE; this is the other. A package declares its
environment specification by hand, and the runtime governs whichever arrangement
is in place — the installed one, or one written by hand:

```bash
node ace.mjs init --name my-workspace
cd my-workspace
node ace.mjs install
node ace.mjs run
node ace.mjs status
node ace.mjs context --json
node ace.mjs stop
```

`init` copies `ace.mjs` and `lib/` into the workspace, so after `cd my-workspace` you can invoke `node ace.mjs` directly.

During `ace init`, the CLI will:

1. Create `package.json` with an `ace` key (`ace/v1` environment spec)
2. Write an empty `ace-lock.json`
3. Scaffold a starter `README.md`
4. Copy `ace.mjs` + `lib/` so the package is self-contained

Git-native install (local registry optional):

```bash
node ace.mjs install github:owner/repo
node ace.mjs install github:owner/repo#v1.2.0
node ace.mjs install git+https://example.com/owner/repo.git
```

## Command reference

Installing the crew:

| Command | Description |
|---------|-------------|
| `ace setup [--intake <file>] [--goal …] [--money …] [--projects a,b] [--dry-run] [--parts a,b] [--force] [--json]` | Install the crew stack into this repository: interrogate → inspect → plan → apply → verify |
| `ace parts [<id>] [--questions] [--json]` | The six parts ACE installs, and the intake schema an agent can answer |

Packages:

| Command | Description |
|---------|-------------|
| `ace init [--name <n>]` | Scaffold `package.json` (with `ace` key) + `ace-lock.json` + README; copy CLI into the target |
| `ace install [<pkg>]` | Install from local lockfile/registry, or a git ref (`github:…` / `git+https://…`) |
| `ace list` | List installed packages |
| `ace info <pkg>` | Show package detail |
| `ace search <q>` | Search the local registry |
| `ace run` | Start the runtime |
| `ace status` | Human-readable status overview |
| `ace context [--json]` | Show environment context |
| `ace agents` | List agents |
| `ace tasks` | List tasks |
| `ace events [--limit N]` | Show event stream (default 20) |
| `ace stop` | Stop the runtime |
| `ace snapshot` | Create a snapshot |
| `ace restore <id>` | Restore a snapshot |
| `ace compose [--json]` | Print composed spec (extends + overrides + capabilities) |
| `ace doctor [--json]` | Environment diagnostics |
| `ace update` | Update dependencies per version constraints |
| `ace uninstall <pkg>` | Remove a dependency from `package.json` |
| `ace secret set <name>` | Inject a secret into `.ace/secrets/<name>` |
| `ace activity` | NOW / NEXT activity stream |
| `ace logs [--limit N]` | Tail the event log (default 20) |
| `ace restart` | Recover + continue |
| `ace verify [check] [--json]` | Run configured verification (`lint`/`typecheck`/`test`/`build` scripts); honest pass when none are configured |
| `ace autopilot [status] [--json]` | The always-on loop: `PLAN → EXECUTE → VERIFY → CHECKPOINT → SUCCESS/FAIL → REPLAN` per cycle (`.ace/autopilot.json`) |
| `ace autopilot on [--interval N] [--mission "…"]` | Start the detached loop; the mission is recorded, never claimed to be decomposed |
| `ace autopilot run [--max-cycles N] [--json]` | Run cycles in this terminal, then exit (non-zero if the last cycle failed) |
| `ace autopilot off` | Stop exactly the recorded pid |

Governance (the runtime that governs the installed stack):

| Command | Description |
|---------|-------------|
| `ace config [--resolve]` | Effective configuration, per-key layer, validation, security floor |
| `ace config check` | Validate it; actionable errors with fixes |
| `ace config set <k=v> [--task <id>]` | Write a session or task override |
| `ace crew [--json]` | The roster, the live budget and the boundary rule |
| `ace crew spawn <role>` | Start a worker; refused when the budget is exhausted |
| `ace govern [--dry-run]` | One governor cycle |
| `ace supervise [--project P] [--dry-run]` | One supervisor cycle |
| `ace task add\|list\|show\|claim\|start\|review\|integrate\|done\|fail\|block\|cancel` | Durable tasks; `claim` is single-owner |
| `ace handoff submit <task> --file <json>` | A structured handoff artifact |
| `ace handoff verify <task>` | Supervisor-side acceptance check |
| `ace route show\|set <agent>` | Inspect or change a route (validated before it is written) |
| `ace heartbeat --agent <id>` | Record liveness |
| `ace watchdog [status\|cycle\|on\|off\|run]` | Independent control plane for governor failures; `run [--max-cycles N]` loops in the foreground |
| `ace bots [status\|enable\|intake\|inbox\|deliver]` | Experimental management bots (off by default) |
| `ace adapters [list\|health\|audit]` | The adapter registry, its health and its contract audit |

### The `--json` contract

Every governance command above accepts `--json`, and the output is machine
readable in a fixed shape:

- **Success:** exactly one JSON document on **stdout**, nothing on stderr.
- **Refusal or configuration error:** exactly one structured error document on
  **stderr**, stdout empty. Exit `1` is "an operator must act", exit `2` is a
  usage or configuration error.
- **Loops:** `ace watchdog run --json` and `ace autopilot run --json` write one
  JSON document **per cycle** (a stream, not a single document).

`ace setup` and `ace parts` follow the same discipline: one document on stdout,
or one structured error on stderr with the affected fields named.

Prose never shares a stream with a document, so `ace task claim <id> --agent <a>
--json | jq .task.status` works, and a refusal is readable the same way.

## How It Works

### Workflow

```
ace setup                      → install the crew: plan, apply, verify
ace init --name my-workspace   → scaffold package + lockfile + self-contained CLI
ace install                    → resolve lockfile / local registry, or clone a git ref
ace run                        → init .ace/ state, set status running
ace status / context / agents  → inspect runtime
ace stop                       → graceful stop (state preserved)
ace snapshot / restore         → checkpoint and roll back
ace verify                     → run configured verification scripts
ace autopilot on               → 24/7 loop: verify + checkpoint every cycle
```

### What `ace init` generates

```
my-workspace/
├── package.json      # npm-style manifest + ace key (ace/v1 environment spec)
├── ace-lock.json     # resolved versions + integrity
├── ace.mjs           # copied CLI entry
├── lib/              # copied modules: pkg, runtime, registry, config, crew,
│                     # governance, watchdog, bots, cli-governance, adapters/,
│                     # and the installer's own intake, stack and cli-stack
├── README.md
└── .ace/             # runtime state (created on run; private, not published)
    ├── state.json
    ├── events.jsonl
    ├── agents/
    ├── tasks/
    ├── heartbeats/    # liveness with the task, route and progress sequence
    ├── leases/        # single-owner coordination for tasks and routes
    ├── routes/        # the active model/provider route per agent
    ├── checkpoints/   # recoverable state written before any recovery action
    ├── handoffs/      # durable handoff artifacts, one directory per task
    ├── actions.jsonl  # the recovery / failover / escalation journal
    ├── context/
    └── snapshots/
```

`init` copies the CLI and `lib/` only — the crew bundle under `assets/stack/` is
not copied here, because `ace setup` is what writes it into a repository.

Public package files (`package.json`, `ace-lock.json`, `README.md`) are publishable. Runtime state under `.ace/` and `orchestration/state/` is private, and the installer ships an `orchestration/state/.gitignore` that keeps the directory while ignoring what agents write into it.

### Package format

The `ace` key in `package.json` defines the orchestrator, worker topology, tools, models, runtime, network, filesystem, memory, git, policies, and lifecycle. Like npm's `main` / `bin` / `scripts`, it may also declare workspace document entry points:

```json
"ace": {
  "spec": "ace/v1",
  "name": "my-workspace",
  "orchestrator": { "runtime": "opencode", "role": "orchestrator" },
  "entry": {
    "manifest": "package.json",
    "readme": "README.md",
    "main": "ace.mjs",
    "lockfile": "ace-lock.json"
  }
}
```

`validateWorkspace` checks that every `entry` value is a non-empty relative path.

### Local registry

MVP registry is file-backed at `.ace-registry/` (gitignored). `ace search` / `ace info` / lockfile install read it. Git-native install clones into `.ace/workspaces/<name>` and reads that checkout's `package.json` `ace` key.

## Configuration

All environment shape lives in the `ace` key. From the answers it was given,
`ace setup` writes a fuller one — `goal`, `roles.governor`,
`roles.supervisors`, `roles.workers`, `concurrency`, `adapters`, `verification`,
and an `orchestration` block that points at `orchestration/projects.json` — plus
`models.default` when a model was pinned with `--model provider/id`. It merges
that key into your manifest and leaves every other key alone. Minimal example
(fields match what `ace init` scaffolds):

```json
{
  "name": "my-workspace",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "dependencies": {},
  "ace": {
    "spec": "ace/v1",
    "name": "my-workspace",
    "orchestrator": { "runtime": "opencode", "role": "orchestrator" },
    "agents": {
      "strategy": "dynamic",
      "defaults": { "runtime": "opencode" },
      "workers": [
        { "role": "architect" },
        { "role": "frontend" },
        { "role": "backend" },
        { "role": "tester" },
        { "role": "reviewer" }
      ]
    },
    "tools": ["git", "github", "filesystem", "terminal"],
    "runtime": { "provider": "local" },
    "extends": []
  }
}
```

## Architecture

```text
ACE SETUP     →  interrogate → inspect → plan → apply → verify      (six parts, one name)
      │
THE CREW      →  orchestration/projects.json   the data: topology, budget, projects, tasks
      │          orchestration/tabs.mjs        plan · up · status · cap · govern · dispatch
      │          orchestration/state/          missions, handoffs, dispatch, cap, governor brief
      │          .acc-memory.md · proagents/    memory, the money contract, the handoff convention
      │
ACE RUNTIME   →  governor → supervisors → workers, over the same projects and the same budget
      │          .ace/state.json, events.jsonl, agents/, tasks/, heartbeats/, leases/, routes/
      │
ACE PACKAGE   →  package.json (manifest + ace spec) + ace-lock.json
      │
ACE REGISTRY  →  package metadata / specifications / versions / integrity   (optional, file-backed)
```

Status: working early release (spec draft `ace/v1`). The stack installer, the
package format, the CLI, the registry, composition, the verify/autopilot loop and
the governance layer (governor, supervisors, workers, central budget, failover,
watchdog) are implemented and covered by `npm test` — 141 tests, green on Node 20
and Node 22, with `npm run check` clean.

The strongest check is the end-to-end one: `ace setup` installs the bundle into a
scratch repository, and then the code that was written there has to pass its own
proof (`node orchestration/selftest.mjs`, 62 assertions, exit 0 for the
two-project install above — 61 with one project). The CI workflow
runs exactly that; it was added on 2026-10-13 and has not yet been exercised on
GitHub, because nothing has been pushed since.

[PLAN.md](./PLAN.md) holds module contracts and worker assignments,
[PRODUCT.md](./PRODUCT.md) the product framing, [docs/STACK.md](./docs/STACK.md)
the map of what the installer writes, and
[docs/APP-INTEGRATION.md](./docs/APP-INTEGRATION.md) the read-only `--json`
surface a UI may consume.

`engines` declares the Node.js floor the CLI needs (`>=20`); it is not a claim
about an ACE runtime version. The spec version is `ace/v1`.

## Governing the crew (Governor → Supervisor → Worker)

Installing the stack writes the arrangement; this is the runtime that governs it.
ACE manages the environment in which a Governor, project Supervisors and worker
agents operate. Three names matter:

- **Governor** — one per package. Checks each supervisor's liveness *and*
  evidence-backed progress, replaces a supervisor's model/provider route when it
  becomes unusable, requests diagnosis through the affected supervisor, and
  escalates what it cannot recover.
- **Supervisor** — one per project. Turns the goal into bounded tasks, assigns
  them (one owner per task), monitors its own workers, and switches their routes
  when they become unusable.
- **Worker** — a bounded implementer that reports what it changed, what it ran,
  what failed and what it did **not** test.

The governor → worker boundary is enforced in code
(`lib/crew.mjs#checkRoute`), not by prompt: a governor that tries to message a
worker is refused and told to go through that worker's supervisor. A worker role
named for its specialty ("backend") is still recognised as a worker.

### The declared goal

`goal.statement` in the `ace` key is the project's main goal, and
`goal.milestones` is an optional list of strings. `ace govern` reports alignment
against that declaration — `in progress`, `goal reached`, or the honest
`no goal declared — set goal.statement in the ace key` — rather than inventing
one.

Governance commands exit `0` on success, `1` when an action needs an operator
(an escalation, a rejected handoff, a failed post-merge check) and `2` on a usage
or configuration error. `--dry-run` predicts the outcome and writes nothing.

### Configuration layers

Precedence is deterministic, lowest to highest:

```text
built-in defaults < installation profile < environment profile
                 < project config   < task override      < session override
```

| Layer | Where |
|-------|-------|
| defaults | code (`lib/config.mjs#defaultConfig`) |
| installation | `$ACE_HOME/profile.json` (`$ACE_HOME` defaults to `~/.ace`) |
| environment | `$ACE_PROFILE_FILE` (+ `ACE_MAX_ACTIVE_AGENTS`) |
| project | `package.json` → `"ace"` |
| task | `.ace/tasks/<id>.json` → `"config"` |
| session | `.ace/session.json` |

Objects merge recursively; an array in a higher layer **replaces** the array
below it (package composition via `extends` concatenates declarations instead —
that is npm-style extension, not configuration). `ace config --resolve` prints
which layer last set every key.

**Security policy is enforced separately from precedence.** A lower-trust layer
(project, task, session) may not loosen a key that an operator-owned layer
(installation or environment profile) explicitly set: `network.mode`,
`filesystem.mode`, `git.push`, `policies.require_review_before_merge`,
`policies.production_access` and `experimental.management_bots.enabled`. The
attempt is refused with `SECURITY_OVERRIDE_DENIED` and a fix.

The built-in defaults are not a floor. They describe the shipped baseline, so a
`package.json` may still enable an experimental feature for its own project; a
profile the operator wrote can pin that key against every lower layer.

### The active-agent budget

`concurrency.max_active_agents` defaults to **4 and is not a maximum** — raising
it is a supported configuration. The budget is enforced centrally in
`lib/crew.mjs`: every active agent counts, whatever runtime it uses, so separate
runtimes cannot each spend the project budget. `concurrency.runtime_overrides`
adds per-runtime caps on top of the global limit, and `count_governor` /
`count_supervisors` decide whether the planners spend the worker budget (they do
not, by default).

### Adapters: everything is swappable

Core orchestration never imports a concrete product. Each capability resolves a
provider from `adapters.<kind>.provider` through the contract in
`lib/adapters/index.mjs` (`describe`, `validate`, `health`, `status`, plus
kind-specific operations) across: multiplexer, workspace, agent-runtime,
provider, context, handoff, tools, verification, persistence, watchdog and
management-bot.

The reference configuration is Herdr, git worktrees, ACC, ProAgents and
OpenCode. Deterministic fakes for every kind ship in `lib/adapters/impl.mjs`, so
the test suite needs no credential and incurs no provider cost. Declaring a
provider that does not exist — or one that exists in the modelled world but is
not implemented here (a Docker workspace, say) — fails with
`INCOMPATIBLE_ADAPTER` and says what to use instead. A provider whose credential
is not set fails with `MISSING_CREDENTIAL` rather than silently degrading.
`ace adapters audit` checks every adapter against the contract; `ace adapters
health` reports the same at runtime.

### Recovery, and its bounds

- A **heartbeat alone never proves progress** — the governor also checks task
  movement and events inside `recovery.progress_window_seconds`, and reports
  `NO_PROGRESS` for a live agent with none.
- A fresh heartbeat left by a **dead process** is still a failure: liveness needs
  a recent heartbeat *and* a live pid when one was recorded.
- A liveness failure is **restarted**; an unusable route is **replaced**.
- A replacement route is **validated** before it is installed; with nothing left
  to try, the governor escalates with `CHAIN_EXHAUSTED` instead of pretending.
- Every action is bounded by `recovery.max_restarts`,
  `recovery.max_route_switches` and `recovery.cooldown_seconds`, is preceded by
  a **checkpoint**, holds a **lease** so concurrent recoveries cannot mutate the
  same route, and is journaled in `.ace/actions.jsonl`.
- Nothing claims a restart it did not deliver: with no delivery function the
  action is recorded and escalated to the operator.

### Continuous operation, and what it depends on

Continuous operation is an objective, not a guarantee. ACE recovers from what it
can observe and escalate what it cannot, and it will keep running only while
these hold:

- **The host is running.** ACE supervises agents; nothing here keeps the machine
  awake. An external scheduler (launchd, systemd, cron) is the usual answer for
  `ace watchdog run`.
- **Credentials are valid.** A provider whose key is missing or rejected fails
  with `MISSING_CREDENTIAL`/`ROUTE_UNAVAILABLE` and burns a failover step; if the
  chain is exhausted, the governor escalates rather than looping.
- **Quota and budget allow it.** No provider quota or usage endpoint is
  integrated in this build, so quota exhaustion is visible only through a failing
  route — and it is reported as a check the governor did not run.
- **The network reaches the provider.** A restricted network policy denies the
  connection; that is a policy outcome, not a bug.
- **State storage is intact.** `.ace/` must survive restarts for recovery to
  mean anything; `ace restart` reconciles what it finds and reports what it
  could not.

### The watchdog (governor self-recovery)

A governor cannot recover itself when its process or model is gone, so an
independent control plane does it: `ace watchdog status | cycle | on | off |
run`. It takes the `watchdog:governor` lease so only one watchdog ever acts,
validates the replacement route, checkpoints first, and escalates when the chain
or the restart budget is exhausted.

`ace watchdog cycle` is one bounded check. `ace watchdog run` is the foreground
loop — it reports every cycle as it lands and stops after `--max-cycles N` (with
`--json`, one document per cycle). `watchdog on` spawns the same loop detached,
and `watchdog off` stops exactly the pid it recorded.

### Verification and handoffs

A handoff is a durable JSON artifact under `.ace/handoffs/<task>/<attempt>.json`
— status, summary, changed files, commands *with exit codes*, checks **not** run,
decisions, risks and the recommended next action. `ace handoff verify` refuses a
completion claim with no command that exited 0.

The supervisor re-runs the workspace checks **after integrating**: passing in a
worker's isolated workspace does not prove the integrated project passes. When
they fail, the task returns to active work under the same owner and the blocker
is reported. Tasks are single-owner — `ace task claim` refuses a second owner
and a lease backs the refusal. `ace restart` reconciles after a crash: an agent
whose process is gone becomes `interrupted`, and its task is requeued (or failed
once its attempts are exhausted) instead of being lost.

### Isolation

A terminal pane is not a security boundary. Each project has its own workspace
(and `git.worktrees` for independent tasks), and `lib/crew.mjs#checkWriteScope`
refuses a write outside the assigned workspace or inside another project's root.
Cross-project context and messages are refused unless `context.sharing` is
`"shared"` — which widens context, never ownership.

### Experimental management bots

Off by default. Nothing is accepted until
`experimental.management_bots.enabled` is explicitly true **and** the connection
is complete (`endpoint`, `identity`, `secret_ref`, a `projects` mapping).
Requests pass one adapter that validates identity, authorization, project
mapping, schema, idempotency (a repeated request id creates one task, not two),
approvals and **the same budget** — a bot cannot launch a second group of agents
that bypasses ACE. A delivery failure is recorded and retried; it never undoes an
accepted task. GitBot is the default provider once enabled; OpenDots and custom
adapters take the same contract. Neither ships a native ACE integration upstream,
so the adapter boundary is what ACE provides today.

### Runtime state

Two private trees, never published, because they describe different things:

- **`orchestration/state/`** — the installed crew, written by the orchestrator:
  `state/<project>/missions.json` and `missions/<id>.brief.md` (the exact prompt
  that was delivered), `state/<project>/handoffs/<id>-<STATE>.md`,
  `handoff-ledger.jsonl`, `dispatch.jsonl`, `cap.jsonl` (refused spawns, with
  their reason), and `state/_global/` holding `assignments.json`,
  `providers.json`, `failover.jsonl`, `cap-settings.jsonl` and
  `governor-brief.md`.
- **`.ace/`** — ACE's own runtime: `state.json`, `events.jsonl`, `actions.jsonl`,
  `agents/`, `tasks/`, `heartbeats/`, `leases/`, `routes/`, `checkpoints/`,
  `handoffs/`, `snapshots/`, `session.json`, `bots/` and `secrets/`. Secrets are
  referenced by name (`secret:<name>`); their values are redacted from events,
  handoffs, action journal entries and generated artifacts.

## ACE Pro (support subscription)

ACE is MIT-licensed and the CLI stays free. **ACE Pro** is a $9.00 USD/month support subscription, billed through Stripe — cancel any time.

- Landing: <https://ace-seven-blue.vercel.app>
- Subscribe directly: <https://buy.stripe.com/9B6dRaclLgbjbqx1bB28800>
- Cancel any time in the Stripe customer portal: <https://billing.stripe.com/p/login/9B6dRaclLgbjbqx1bB28800>

## License

MIT — see [LICENSE](./LICENSE).
