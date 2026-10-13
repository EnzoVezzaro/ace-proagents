# exp-007 — ACE (Agentic Compute Environment)

## Status (2026-10-13): this file is the historical build record

**What ACE is now.** A skill plus one CLI that installs a crew of coding agents
into a repository. `ace setup` interrogates the project, inspects it, prints a
plan, applies it and verifies it; `ace parts` describes the six things it
installs.

**What this document is.** The build contract for ACE `v0.1.x`: the package
format, the module contracts, the phases and the worker assignments that produced
the runtime. It is kept because those module contracts are still the contracts the
runtime implements — not because it describes the current architecture.

**What supersedes it.**

| For | Read |
| --- | --- |
| the front door, the install flow and its exit codes | `README.md` |
| the six parts and the one-name invariant | `docs/STACK.md` |
| the installer itself: parts, plan, apply, verify | `lib/stack.mjs` |
| the interrogation and the repository inspection | `lib/intake.mjs` |
| the stack that ships into an installed repo, and its proof | `assets/stack/orchestration/` |
| the read-only surface a UI may consume | `docs/APP-INTEGRATION.md` |

**Pushed 2026-10-13.** The installer files (`lib/stack.mjs`, `lib/intake.mjs`,
`lib/cli-stack.mjs`, `assets/stack/**`, `docs/STACK.md`, `test/stack.test.mjs`)
are on `origin/main` and in the published package (`0.1.4`); npm's `0.1.2` and
the `v0.1.3` tag predate the installer.

> **Historical positioning (v0.1.x).** ACE was first built as *npm for agentic
> coding environments*: an open, Git-native package ecosystem for reproducible
> orchestrator-driven agentic coding environments. The package manager is still
> here (`ace init` / `install` / `list` / `search`), but it is no longer the
> product's front door.

Status at the time of this build: MVP. Spec `ace/v1`. Primary interface: the `ace`
CLI. Zero runtime dependencies; the current floor is **Node 20** (this file said
Node >= 18 when it was written, which is no longer true of `package.json`).

---

## Current architecture: the installer (added 2026-10-13)

`ace setup` runs five stages and prints what it decided at each one:

| Stage | What it does |
| --- | --- |
| interrogate | asks eleven questions (goal, the dollar the work can produce, the trees the crew works in, harness, model, the global worker budget, workers per project, browser need, what proves a change is done, a first task, a deadline) and prints **why** each matters |
| inspect | reads the repository rather than trusting the answers: git state, `package.json` scripts turned into the verification commands, candidate work-area roots, an existing `orchestration/projects.json`, an existing `ace` key, an existing `.acc-memory.md` |
| plan | the write set, which part causes each write, and the links between the parts — no filesystem effects |
| apply | writes it, merges rather than replaces, and never overwrites what it did not seed |
| verify | checks the written setup part by part, against the installed modules themselves |

`ace parts [<id>] [--questions]` prints the catalogue and the intake schema, so an
agent can answer the interrogation without a terminal (`--intake <file.json>`, or
the answers as flags).

### The six parts

| Part | Installs | Requires |
| --- | --- | --- |
| `herdr-spaces` | one Herdr tab per project plus a `control-plane` tab; `orchestration/tabs.mjs`, `lib/{herdr,topology,cap}.mjs`, `projects.json`, `state/.gitignore`, `README.md`, `selftest.mjs` | — |
| `ego-lite-spaces` | one Ego Lite browser space per project; `lib/ego.mjs` | `herdr-spaces` |
| `govern` | one governor over a **global** worker budget, free-models-only failover; `lib/free-models.mjs` plus the `ace` key | `herdr-spaces`, `supervisors-workers` |
| `supervisors-workers` | exactly one supervisor and its workers per project, every task carrying the money line it can produce; `projects.json` plus the `ace` key roles | `govern` |
| `acc` | the ACC control file and one `.acc-memory.md` per tree | `herdr-spaces` |
| `proagents` | the money contract, the handoff convention, the tool registry, `STACK.md` | `supervisors-workers` |

One rule links them, and it is the reason they are parts of one system rather
than six tools:

```text
project.id === its tab label === its browser space === basename(its tree)
```

**Copied verbatim** from `assets/stack/orchestration/`: `tabs.mjs`, `selftest.mjs`,
`README.md` and `lib/*.mjs`. **Generated per repository**: `orchestration/projects.json`,
the `ace` key merged into `package.json` (other keys untouched), `.acc/**`,
`proagents/**` and `STACK.md`.

### The checks that refuse rather than warn

- Intake: a project root that does not exist, two roots colliding on one id, or an
  agent name the multiplexer cannot attach is a violation — the plan is refused
  and nothing is written.
- No answers and no terminal: `INTAKE_INVALID`, naming every missing field, with
  nothing written. `--dry-run` writes nothing either.
- A generated file that already exists and differs is **left alone** unless
  `--force` is explicit; a repo that already has a `projects.json` has decisions
  in it an installer cannot re-derive.
- Memory files are seeded once and are never overwritten, not even with `--force`.
- Verification reports a check that could not run as `not run` with its
  precondition, never as a pass.

Exit codes: `0` installed and verified · `1` a check failed, or an operator must
act · `2` a usage, intake or plan error — nothing written.

### The acceptance suite

- `test/stack.test.mjs` — the installer's own suite, part of the repo's 141 tests.
  It proves the plan and apply are hermetic, that the manifest merge touches no
  other key, and — the load-bearing cases — that `verifyStack` fails on every kind
  of breakage (two supervisors, an unpriced task, a mismatched browser space, a
  duplicated project id, a budget that disagrees with the stack's cap).
- `assets/stack/orchestration/selftest.mjs` — ships into every installed repository
  and runs there, offline: the topology rule, the cap math, the cap as a setting,
  the space invariant, the handoff lifecycle and every failure kind, the money
  rule, and the free-model refusal. 62 assertions, exit 0, no multiplexer, no
  network, no browser.
- `.github/workflows/ci.yml` — a crew-stack smoke step installs into a scratch
  repo and runs the installed `selftest.mjs` and `tabs.mjs cap`. It ran green on
  GitHub on 2026-10-13 (run `38436935008`, Node 20 and 22) on the push that
  shipped the installer.

---

*(Sections 1–10 below are the `v0.1.x` build record: the package format, the
runtime and the governance layer as specified and built. They remain the module
contracts.)*

## 1. Architecture (three levels)

```text
ACE REGISTRY  →  package metadata / specifications / versions / integrity
      │
ACE PACKAGE   →  package.json (manifest + ace spec) + ace-lock.json
      │
ACE RUNTIME   →  orchestrator + workers + tools + state + events
      │
ACE STATE     →  .ace/state.json, .ace/events.jsonl, .ace/agents/, .ace/tasks/, .ace/context/
```

**Specification ≠ State.** A package describes what *should* exist. Runtime
state describes what *does* exist, who is acting, what happened, what's next.

## 2. Repository layout

```text
ace-proagents/
├── ace.mjs                 # CLI entry + command router (ALL commands)
├── package.json            # npm-style manifest (name, version, deps, engines.ace)
├── package.json ace key          # the ACE package spec (ace/v1)
├── ace-lock.json           # resolved versions + integrity
├── PLAN.md                 # this file
├── README.md
├── lib/
│   ├── pkg.mjs             # package format: parse/validate, lockfile, compose
│   ├── runtime.mjs         # runtime state, context, events, lifecycle
│   └── registry.mjs        # local registry + search + git-native install
├── schemas/
│   └── workspace.schema.json
├── .ace/                   # runtime state (gitignored via local .gitignore)
├── ideas.json              # engine integration (revenue_sync, owner_digest)
└── metrics.json            # engine integration
```

## 3. Module contracts (FIXED — implement against these exactly)

### `lib/pkg.mjs`
```js
loadPackage(dir)          → { manifest, workspace, dir }   // reads package.json, extracts the ace spec key
validateWorkspace(obj)    → { ok, errors[] }              // against ace/v1 rules
readLockfile(dir)         → { packages: {name: {version, integrity}} } | null
writeLockfile(dir, lock)  → void                          // writes ace-lock.json
compose(spec, deps)       → merged spec                   // extends/overrides/merge (phase 7)
```

### `lib/runtime.mjs`
```js
initState(dir)            → void                          // creates .ace/ tree
getState(dir)             → { status, active, agents[], tasks[], updatedAt }
appendEvent(dir, ev)      → void                          // appends to .ace/events.jsonl
getAgents(dir)            → [{ id, role, status, task, startedAt, lastActivity }]
getTasks(dir)             → [{ id, title, status, assignedTo, priority, createdAt }]
getContext(dir)           → { host, runtime, project, git, tools, resources }
setStatus(dir, status)    → void                          // created|installed|ready|running|paused|stopped
snapshot(dir)             → { id, at, spec, state, git }  // writes .ace/snapshots/<id>.json
restore(dir, snapshotId)  → void
```

### `lib/registry.mjs`
```js
searchLocal(query)        → [{ name, description, version, score }]
infoLocal(name)           → { name, version, description, orchestrator, agents[], tools[], runtime, repository, dependencies[] }
installGit(ref)           → { dir, version }               // github:user/repo[#ref] or git+https://...
publishLocal(pkg)         → { name, version, integrity }   // sha256 of package.json ace key
```

### `ace.mjs` (CLI)
```text
ace init [--name <n>]        scaffold package.json (manifest + ace spec) + ace-lock.json + README
ace install [<pkg>]         resolve + install (local registry, or git ref)
ace list                    installed packages
ace info <pkg>              package detail
ace search <q>              search local registry
ace run                     start runtime (init state, setStatus running, spawn marker)
ace status                  human overview (orchestrator, agents, tasks, git, resources)
ace context [--json]        environment context
ace agents                  list agents
ace tasks                   list tasks
ace events [--limit N]      event stream
ace stop                    graceful stop (setStatus stopped, preserve state)
ace snapshot                create snapshot
ace restore <id>            restore snapshot
```

## 4. Runtime state shapes

`.ace/state.json`:
```json
{ "status": "running", "active": { "agent": "orchestrator", "role": "orchestrator", "status": "working", "task": null, "startedAt": "..." }, "agents": [], "tasks": [], "updatedAt": "..." }
```

`.ace/events.jsonl` — one JSON object per line:
```json
{ "id": "evt_...", "timestamp": "...", "type": "orchestrator.started", "actor": "orchestrator", "task": null, "metadata": {} }
```

`.ace/agents/<id>.json`, `.ace/tasks/<id>.json`, `.ace/context/context.json`.

## 5. Registry (MVP = local file-backed, no network)

Local registry lives at `ace-proagents/.ace-registry/` (gitignored).
`ace search`/`ace info`/`ace install <name>` read it. `ace publish` writes a
metadata record + computes `sha256` integrity of `package.json ace key`. Git-native
install (`ace install github:user/repo[#ref]`) shells out to `git clone` into
`.ace/workspaces/<name>` and reads its `package.json ace key`.

## 6. Worker assignments (DISJOINT — no overlapping writes)

| Worker | Owns | Never writes |
| --- | --- | --- |
| **bunny-1** | `ace.mjs` (CLI entry + ALL command handlers + output) | `lib/**`, `schemas/**` |
| **bunny-2** | `lib/pkg.mjs`, `schemas/workspace.schema.json` | `ace.mjs`, `lib/runtime.mjs`, `lib/registry.mjs` |
| **bunny-3** | `lib/runtime.mjs`, `lib/registry.mjs` | `ace.mjs`, `lib/pkg.mjs`, `schemas/**` |

All three: read this PLAN.md first. Zero new npm deps. Plain JSON state.
`node --check` every file. Run a real demo of every command and paste output.

## 7. MVP phases (what this build delivers)

- **Phase 1** — package format: `package.json` (manifest + ace spec key), `ace-lock.json`

The `ace` key may declare an `entry` map of workspace document entry points (role → relative path), mirroring npm's `main`/`bin`/`scripts`:
```json
"ace": {
  "entry": {
    "agents": "AGENTS.md",
    "agentConfig": "opencode.json",
    "readme": "README.md",
    "manifest": "package.json",
    "lockfile": "ace-lock.json",
    "main": "ace.mjs",
    "orchestrator": "opencode.json"
  }
}
```
Recognized roles: agents, agentConfig, readme, manifest, lockfile, main, orchestrator. Additional roles allowed. `validateWorkspace` checks every value is a non-empty string path.
- **Phase 2** — CLI: `init/install/list/info/search/run/status/context/agents/tasks/events/stop/snapshot/restore`
- **Phase 3** — Git integration: `ace install github:user/repo[#ref]`
- **Phase 4** — runtime state: `.ace/state.json`, `.ace/events.jsonl`, `.ace/agents/`, `.ace/tasks/`, `.ace/context/`
- **Phase 5** — orchestrator integration: `ace context --json`
- **Phase 6** — registry: local discovery, search, publish, integrity

Phases 7-8 (composition engine, advanced runtime: remote compute, distributed
workers, policy enforcement) are future work, out of scope for this build.

## 8. Quality gates

- `node --check` passes on every `.mjs` file.
- Every CLI command runs and produces the documented output.
- `ace init` → `ace install` → `ace run` → `ace status` → `ace context --json` → `ace snapshot` → `ace restore` works end-to-end.
- No file outside your ownership is modified.

---

## 9. Phases 7–8 (composition + advanced runtime)

### Phase 7 — Composition (extends in lib/pkg.mjs)

The `ace` key in `package.json` may declare:
```json
"ace": {
  "extends": ["@ace/base-coding", "@ace/github"],
  "overrides": {
    "agents": { "workers": [{ "role": "security" }] }
  },
  "capabilities": ["gpu"]
}
```

`compose(spec, deps)` must:
1. Resolve each `extends` entry to a workspace spec (from local registry or git).
2. Merge parents first, child last (child wins on scalar conflict; arrays concatenate; deep-merge objects).
3. Apply `overrides` as a deep-merge on top of the child.
4. Filter `capabilities` to those the runtime reports available.
5. Return the merged spec. Never mutate the input.

`resolveDependencies(manifest, registry)` must:
- Walk `manifest.dependencies` (name → semver range like `^1.0.0`).
- Resolve each to a concrete version from the registry.
- Detect conflicts (two packages requiring incompatible ranges) and return `{ ok, graph, conflicts[] }`.

`doctor(dir)` must check: runtime present, host OS, memory, CPU, required capabilities. Return `{ ok, checks[{name, ok, detail}], warnings[] }`.

### Phase 8 — Advanced runtime (in lib/runtime.mjs)

`recover(dir)` — reconstruct state after crash: read `.ace/state.json`, replay `.ace/events.jsonl` to rebuild agents/tasks, set status to `recovering` then `ready`. Return the recovered state.

`trackResources(dir)` — sample `process.cpuUsage`, `os.freemem()`, `os.totalmem()`, disk usage into `.ace/context/resources.json` with a timestamp.

`enforcePolicies(dir, action)` — `action` is `{ type: "filesystem.write"|"network.connect"|"git.push"|"production.access"|"merge", path?, target? }`. Read `package.json ace key` `policies`. Return `{ allowed, reason }`. Deny by default if a policy is declared and the action violates it.

`spawnWorker(dir, role)` — create `.ace/agents/<role>-<n>.json` with status `idle`, append `agent.spawned` event, return the agent id.

`healthcheck(dir)` — if `package.json ace key` has `lifecycle.healthcheck`, run it via execFileSync with a timeout; return `{ ok, output }`.

### CLI additions (in ace.mjs)

```text
ace compose                 print the composed spec (extends + overrides + capabilities)
ace doctor                  environment diagnostics
ace update                  update dependencies per version constraints
ace uninstall <pkg>         remove a dependency
ace secret set <name>       inject a secret into .ace/secrets/<name>
ace activity                NOW / NEXT activity stream
ace logs [--limit N]        tail the event log
ace restart                 recover + continue
```

### Worker assignments (still disjoint)

| Worker | Owns | Phase |
| --- | --- | --- |
| bunny-1 | `ace.mjs` — new commands only | 7+8 CLI |
| bunny-2 | `lib/pkg.mjs` — compose/resolveDependencies/doctor | 7 |
| bunny-3 | `lib/runtime.mjs` — recover/trackResources/enforcePolicies/spawnWorker/healthcheck | 8 |

Do NOT rewrite existing working functions — extend them. The MVP (phases 1-6) must keep passing.

---

## 10. Phase 9 — Governance (implemented)

The orchestrator becomes a Governor → Supervisor → Worker environment. Every
module below is implemented and covered by `test/`; `npm test` runs the whole
suite with the built-in runner.

### `lib/adapters/index.mjs` — the swap points

```js
ADAPTER_KINDS              // multiplexer, workspace, agent-runtime, provider, context,
                           // handoff, tools, verification, persistence, watchdog, management-bot
ADAPTERS                   // the registry: kind → provider → adapter
resolveAdapter(kind, name) → { adapter, ok, reason }   // refuses unknown and known-unimplemented
listAdapters(kind)         → [{ name, capabilities[], requiresEnv[], describe }]
checkContract(adapter)     → { ok, missing[] }          // describe/validate/health/status + name/kind
adapterConfigs(config)     → every provider selection, with the config path that chose it
missingCredentials(config) → active providers whose env vars are unset (never values)
healthAll(config, env)     → per-capability health, never throwing
```

Every adapter object is `{ name, kind, capabilities[], requiresEnv[], describe(),
validate(cfg), health(env, cfg), status(env, cfg), ops }`. Core modules never
import a concrete product; `lib/adapters/impl.mjs` holds deterministic fakes so
tests need no credential.

### `lib/config.mjs` — the effective configuration

```js
LAYER_ORDER      // defaults < installation < environment < project < task < session
SECURITY_KEYS    // paths a lower-trust layer may not loosen
mergeOverride(target, source)   // objects merge, arrays REPLACE (unlike pkg.compose)
resolveConfig({ dir, taskId, env }) → { effective, sources, layers, warnings, security }
validateEffective(config, { env, layers }) → { ok, errors[{ code, where, message, fix }] }
parseOverridePair("a.b=6")      → { key, value, patch }
writeSessionOverride(dir, patch) / readSessionOverride(dir)
redactConfig(value)             // masks credentials before anything is printed
```

Error codes are stable: `UNSUPPORTED_SETTING`, `INVALID_MODEL`,
`INCOMPATIBLE_ADAPTER`, `MISSING_CREDENTIAL`, `SECURITY_OVERRIDE_DENIED`.

### `lib/crew.mjs` — the roster, the budget, the boundary (pure, no I/O)

```js
buildCrew(config)               → { governor, supervisors[], workers[], projects[] }
governanceRole(agent)           // governor | supervisor | worker, independent of naming
budget(config) / computeOccupancy(config, agents) / canStart(config, agents, candidate)
routeChain(config, role, project) / nextRoute(chain, current) / routeLabel(route)
checkRoute(from, to, config)    // refuses GOVERNOR_WORKER_BOUNDARY and CROSS_PROJECT_DENIED
supervisorFor(crew, workerId)   // governor → supervisor routing, or ORPHAN_WORKER
checkWriteScope(root, target, { crossProjectRoots })   // OUT_OF_SCOPE_WRITE / CROSS_PROJECT_WRITE
```

### `lib/runtime.mjs` — durable state (extended, all previous exports intact)

Heartbeats (`writeHeartbeat`, `readHeartbeats`, `isStale`), leases
(`acquireLease`, `releaseLease` — single-owner coordination), tasks
(`createTask`, `claimTask`, `setTaskStatus`, `TASK_TRANSITIONS`), checkpoints,
routes, the action journal, handoffs (`writeHandoff`, `verifyHandoff`), secret
storage and redaction (`storeSecret`, `redactSecrets`), and `reconcile(dir)` for
restart recovery.

### `lib/governance.mjs` — the two cycles

```js
governorCycle(dir, config, { apply, nowMs, crew, deliver, env }) → {
  supervisors[{ alive, responsive, heartbeatAgeSeconds, pidAlive, route, routeHealth, evidence }],
  detections[{ code, severity, subject }],      // DETECTION_CODES
  actions[{ type: "restart"|"route.replace"|"request_diagnosis"|"escalate", ok, delivered, reason }],
  escalations[{ code, needsOperator }], budget, goal, checksNotRun, ok,
}
supervisorCycle(dir, config, { project, apply, verifyChecks, nowMs, env }) → {
  workers[], assignments[], routeChanges[], verifications[], blockers[], budget, goal, ok,
}
```

`ok` means "nothing here needs an operator". A detection that was acted on
successfully is not an open problem; an unanswered one is.

### `lib/watchdog.mjs` / `lib/bots.mjs` / `lib/cli-governance.mjs`

```js
watchdogStatus(dir, config) / watchdogCycle(dir, config, { apply, deliver, nowMs })
watchdogStart(dir, config, { intervalSeconds, spawn }) / watchdogStop(dir, config)
botStatus(config, env) / intake(dir, config, request, { apply, deliver })
inbox(dir) / deliverPending(dir, config, deliverFn, opts)
run(command, args, ctx)      // the governance CLI dispatcher, registered in ace.mjs
```

### Quality gates for this phase

- `npm test` — the whole suite, built-in runner only, no credentials, no network.
- `npm run check` — `node --check` over `ace.mjs`, `lib/**` and `site/app.js`.
- A scaffolded workspace (`ace init`) must carry every module: `lib/` is copied
  recursively, and CI runs `config check` and `crew` inside the scaffold.
- No command is documented before it is implemented and tested.
