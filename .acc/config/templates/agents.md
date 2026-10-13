# ace-proagents

## Purpose

One skill and one CLI that install a crew of coding agents into a repository:
the terminal spaces, one browser space per project, a governor over a global
worker budget, one supervisor and its workers per project, durable memory per
tree, and the handoff convention every mission ends with. ACE is also the
runtime that governs what it installed.

## Responsibilities

- `lib/intake.mjs` — the questions and the inspection of the target repository.
- `lib/stack.mjs` — the six parts, and the plan / apply / verify pipeline.
- `lib/cli-stack.mjs` — `ace setup` and `ace parts`.
- `lib/{config,crew,governance,watchdog,bots,runtime,pkg,registry,adapters}.mjs`
  — the governance runtime.
- `ace.mjs` — the router; `node ace.mjs --help` is authoritative for commands.
- `assets/stack/orchestration/**` — the modules copied verbatim into a target
  repo, including the proof each install runs on itself (`selftest.mjs`).

## Ownership

Owner: `ace.mjs` (CLI) and `lib/stack.mjs` (the installer). Contracts:
`docs/STACK.md` for the parts, `PLAN.md` for the runtime's module contracts.

## Inputs

- The operator's answers: goal, the outcome the work can produce, the trees the
  crew works in, harness, budget, browser need, what proves a change is done.
- The target repository: git state, `package.json` scripts, work-area roots, an
  existing `ace` key or `.acc-memory.md`.

## Outputs

- In the target repo: `orchestration/**` (copied plus a generated
  `projects.json`), the `ace` key merged into `package.json`, `.acc/**`,
  `charter/**` and `STACK.md`.
- In this repo: the package itself, and the JSON documents every command emits.

## Dependencies

- Runtime: none. Node builtins only, `engines.node >= 20`.
- Third-party capabilities sit behind the adapter contract
  (`lib/adapters/index.mjs`); nothing in the core imports a product.

## Constraints

- `project.id === its tab label === its browser space === basename(its tree)`.
  The parts are linked by that one name; a setup whose names disagree is
  refused rather than written.
- Zero runtime dependencies, and never a second crew or a second dispatch path.
- Honesty gates: never report a check that did not run (a `skip` names its
  precondition), never fall back to a paid model, never print a credential, and
  never overwrite accumulated memory.

## Architecture

`ace setup` runs five stages — interrogate, inspect, plan, apply, verify — and
`ace parts` describes what it installs. The shipped bundle under
`assets/stack/orchestration/` is the ancestor of the lab's own `orchestration/`
directory: the asset is the source, an installed copy is a copy.

## Workflows

- Work from `.acc-memory.md` before changing anything in `assets/stack/` or
  `lib/stack.mjs`; the lessons there are the ones that cost real debugging time.
