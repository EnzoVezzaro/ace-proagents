# ACE

ACE — Agentic Compute Environment. The CLI for reproducible orchestrator-driven agentic coding environments.

**Zero runtime dependencies.** Node ESM only (`ace.mjs`). Spec `ace/v1`. MIT.

**Git stays the source of truth.** An ACE package describes the *environment* — orchestrator, workers, tools, models, policies, memory, lifecycle — not application source. The local registry indexes specifications; it is optional.

**Specification is not state.** `package.json` (the `ace` key) + `ace-lock.json` describe what should exist. Runtime state under `.ace/` describes what does exist.

## Install

Install from npm (published, free):

```bash
npm i ace-proagents
```

Or clone this repository and run it with Node (18+):

```bash
git clone https://github.com/EnzoVezzaro/ace-proagents.git
cd ace-proagents
node ace.mjs --help
```

`package.json` declares `"bin": { "ace": "./ace.mjs" }`, the npm package installs the `ace` command (or run `node ace.mjs` from a clone).

## ACE Pro

ACE core is free and stays free (MIT). ACE Pro is an optional **$9.00 USD/month** support subscription, billed through Stripe: **[buy.stripe.com/9B6dRaclLgbjbqx1bB28800](https://buy.stripe.com/9B6dRaclLgbjbqx1bB28800)**. Cancel any time. The product site — spec, design, and live demo — is at **[ace-seven-blue.vercel.app](https://ace-seven-blue.vercel.app)**.

## Quickstart

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

## Commands

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

## How It Works

### Workflow

```
ace init --name my-workspace   → scaffold package + lockfile + self-contained CLI
ace install                    → resolve lockfile / local registry, or clone a git ref
ace run                        → init .ace/ state, set status running
ace status / context / agents  → inspect runtime
ace stop                       → graceful stop (state preserved)
ace snapshot / restore         → checkpoint and roll back
ace verify                     → run configured verification scripts
ace autopilot on               → 24/7 loop: verify + checkpoint every cycle
```

### What Gets Generated

```
my-workspace/
├── package.json      # npm-style manifest + ace key (ace/v1 environment spec)
├── ace-lock.json     # resolved versions + integrity
├── ace.mjs           # copied CLI entry
├── lib/              # pkg / runtime / registry modules
├── README.md
└── .ace/             # runtime state (created on run; private, not published)
    ├── state.json
    ├── events.jsonl
    ├── agents/
    ├── tasks/
    ├── context/
    └── snapshots/
```

Public package files (`package.json`, `ace-lock.json`, `README.md`) are publishable. Runtime state under `.ace/` is private and never published.

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

All environment shape lives in the `ace` key. Minimal example (fields match what `ace init` scaffolds):

```json
{
  "name": "my-workspace",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "engines": { "ace": ">=1.0.0" },
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
ACE REGISTRY  →  package metadata / specifications / versions / integrity
      │
ACE PACKAGE   →  package.json (manifest + ace spec) + ace-lock.json
      │
ACE RUNTIME   →  orchestrator + workers + tools + state + events
      │
ACE STATE     →  .ace/state.json, events.jsonl, agents/, tasks/, context/
```

Status: MVP (phases 1–6). See [PLAN.md](./PLAN.md) for module contracts and worker assignments. Product framing: [PRODUCT.md](./PRODUCT.md).

## License

MIT — see [LICENSE](./LICENSE).
