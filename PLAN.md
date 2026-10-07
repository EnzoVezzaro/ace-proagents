# exp-007 — ACE (Agentic Compute Environment)

> **ACE is npm for agentic coding environments.**

An open, Git-native package ecosystem for **reproducible orchestrator-driven
agentic coding environments**. The package describes the *environment*
(orchestrator, workers, tools, models, policies, memory, lifecycle) — not
application source. Git remains the source of truth; the registry indexes
specifications.

Status: MVP build. Spec `ace/v1`. Primary interface: `ace` CLI. Zero runtime
dependencies (Node >= 18), matching the repo's engine conventions.

---

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
