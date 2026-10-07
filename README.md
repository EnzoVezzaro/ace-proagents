# ACE — Agentic Compute Environment

> **ACE is npm for agentic coding environments.**

An open, Git-native package ecosystem for **reproducible orchestrator-driven
agentic coding environments**. An ACE package describes the *environment* —
orchestrator, workers, tools, models, policies, memory, lifecycle — not
application source. Git remains the source of truth; the registry indexes
specifications.

Status: MVP (phases 1–6). Spec `ace/v1`. Zero runtime dependencies.

## Quick start

```bash
node ace-proagents/ace.mjs init --name my-workspace
cd my-workspace
node ../ace-proagents/ace.mjs install
node ../ace-proagents/ace.mjs run
node ../ace-proagents/ace.mjs status
node ../ace-proagents/ace.mjs context --json
```

## CLI

```text
ace init [--name <n>]        scaffold a package
ace install [<pkg>]          install from local registry, or a git ref
ace list                    installed packages
ace info <pkg>              package detail
ace search <q>              search the local registry
ace run                     start the runtime
ace status                  human overview
ace context [--json]        environment context
ace agents                  list agents
ace tasks                   list tasks
ace events [--limit N]      event stream
ace stop                    graceful stop
ace snapshot                create a snapshot
ace restore <id>            restore a snapshot
```

Git-native install (registry optional):

```bash
node ace-proagents/ace.mjs install github:EnzoVezzaro/fullstack-team
node ace-proagents/ace.mjs install github:EnzoVezzaro/fullstack-team#v1.2.0
```

## Package format

```text
my-workspace/
├── package.json      # npm-style manifest (name, version, dependencies, engines.ace)
├── package.json (ace key)    # the environment specification (ace/v1)
├── ace-lock.json     # resolved versions + integrity
├── schemas/          # ace/v1 JSON Schema
└── README.md
```

`package.json (ace key)` defines the orchestrator, worker topology, tools, models,
runtime, network, filesystem, memory, git, policies, and lifecycle.

## Runtime state

```text
.ace/
├── state.json        # status, active agent, agents[], tasks[]
├── events.jsonl      # append-only event stream
├── agents/<id>.json
├── tasks/<id>.json
├── context/context.json
└── snapshots/<id>.json
```

Public package files (`package.json`, `package.json (ace key)`, `README.md`) are
publishable. Runtime state under `.ace/` is private and never published.

## Workspace entry points

Like npm's `main`/`bin`/`scripts`, the `ace` key declares the workspace document entry points:

```json
"ace": {
  "entry": {
    "manifest": "package.json",
    "readme": "README.md",
    "main": "ace.mjs",
    "lockfile": "ace-lock.json"
  }
}
```

`validateWorkspace` checks that every value is a non-empty relative path.

## Architecture

See [PLAN.md](./PLAN.md) for the full specification, module contracts, and
worker assignments.

## The killer experience

```bash
npm install -g ace
ace install @ace/fullstack
ace run
ace status
```

The user did not configure five agents, five terminals, Docker, MCP, Git
worktrees, tools, permissions, and runtime state. They installed a package.