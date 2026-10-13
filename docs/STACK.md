# The stack ACE installs

`ace setup` turns a repository into one where a crew of coding agents can work
several areas at once without a human holding it together. It installs six
parts, and none of them is usable alone.

```
herdr-spaces        one tab per project, plus one control plane
ego-lite-spaces     one browser space per project, named after the project
govern              one governor over a global worker budget, with failover
supervisors-workers one supervisor and its workers per project, priced tasks
acc                 durable memory per tree
proagents           the layer on top: the money contract and the handoff convention
```

## The invariant that makes it a system

```
project.id === its tab label === its browser space === basename(its tree)
```

A project is one name in the terminal, in the browser, on disk and in the
governor's report. `orchestration/projects.json` is the data behind that, and
adding a project is adding data — never editing the installer or a tab list.

## The parts

| Part | Installs | Requires | Verified by |
|---|---|---|---|
| `herdr-spaces` | `orchestration/tabs.mjs`, `lib/herdr.mjs`, `lib/topology.mjs`, `lib/cap.mjs`, `orchestration/projects.json`, `orchestration/state/.gitignore`, `orchestration/README.md`, `orchestration/selftest.mjs` | — | every declared agent resolves to a tab that allows its role, and the tab count is 1 + projects |
| `ego-lite-spaces` | `orchestration/lib/ego.mjs` | `herdr-spaces` | every project's space name equals its id and the basename of its tree |
| `govern` | `orchestration/lib/free-models.mjs`, the `ace` key in `package.json` | `herdr-spaces`, `supervisors-workers` | the `ace` configuration validates, and its active-agent budget equals the stack's worker cap |
| `supervisors-workers` | `orchestration/projects.json`, `orchestration/lib/handoff.mjs`, the `ace` key in `package.json` | `govern` | exactly one supervisor per project, at least one worker each, and every task carries a money line |
| `acc` | `.acc/config/config.yaml`, `.acc/config/templates/agents.md`, `.acc-memory.md`, one `<tree>/.acc-memory.md` per project | `herdr-spaces` | the control file exists, and every project tree has its own memory file |
| `proagents` | `proagents/MONEY-CONTRACT.md`, `proagents/knowledge/CREW-PROTOCOL.md`, `proagents/registry/experts.json`, `STACK.md` | `supervisors-workers` | the contract, the convention and the registry are present and parseable |

`ace parts` prints this catalogue; `ace parts <id>` prints one part.

## How the parts link

Each link hands one exact name to another part. That is what makes it a system
rather than six adjacent tools:

| From | To | Carries |
|---|---|---|
| `herdr-spaces` | `ego-lite-spaces` | `project.id` — the tab label and the browser space are the same string |
| `ego-lite-spaces` | `herdr-spaces` | `browser_space` — the space name is the project id, which is also its tab label |
| `govern` | `supervisors-workers` | `cap` — the budget a supervisor must respect when it starts a worker |
| `supervisors-workers` | `proagents` | `tasks[].money` — the money contract the supervisor enforces at dispatch |
| `acc` | `govern` | `memory` — the governor reports against what the memory records as decided |
| `proagents` | `supervisors-workers` | `acceptance` — a handoff that claims DONE without evidence is not accepted |

The same projects therefore appear twice, in two shapes that must agree: as
`projects.json` (what the orchestrator reads) and as the `ace` key in
`package.json` (what ACE's governance runtime reads). Install sets both from one
answer set, and the `govern` verification fails if the two budgets disagree.

## What `ace setup` runs

```
interrogate → inspect → plan → apply → verify
```

| Stage | What happens |
|---|---|
| interrogate | `ace setup` asks the questions in `lib/intake.mjs` — the goal, the money line, the project trees, the harness, the worker cap, whether browser work is needed, and what proves a change is done. On a terminal it prompts, printing *why* each question matters; an agent answers with `--intake <file>` or with flags |
| inspect | `lib/intake.mjs` reads the repository: its git state, its manifest and scripts, its candidate work areas, and any existing `orchestration/`, `ace` key or `.acc-memory.md`. Detected values become the defaults, and they are reported as detected rather than assumed |
| plan | `lib/stack.mjs` computes every write and every link. It refuses (exit 2, nothing written) when a project root does not exist, when two trees produce the same project id, when an agent name would not be attachable, or when a shipped asset is missing |
| apply | copies the vendored modules, generates the per-repo files, and merges the `ace` key into `package.json`. An existing generated file that differs is reported and left alone unless `--force` is passed |
| verify | `lib/stack.mjs` checks the written setup part by part, importing the installed `lib/topology.mjs` and `lib/ego.mjs` and running ACE's own configuration validation. Checks that need a live multiplexer are reported as `skip` with the reason, never as a pass |

```
ace setup                                  # prompt on a terminal
ace setup --intake intake.json             # answers from a file (the agent path)
ace setup --goal "…" --money "…" --projects path/a,path/b
ace setup --dry-run                        # print the plan; write nothing
ace setup --parts herdr-spaces,govern      # a subset; required parts come with it
ace setup --force                          # overwrite generated files that differ
ace setup --json                           # one document: facts, plan, applied, verify
ace parts --questions                      # the intake schema, with defaults and reasons
```

Exit codes: `0` installed and verified · `1` installed but a check failed, or the
command failed · `2` a usage, intake or plan error — in which case **nothing was
written**.

## What the installer deliberately never does

- It starts no agent, creates no tab and opens no browser space. No session is
  driven from outside a multiplexer; `node orchestration/tabs.mjs up` does that
  inside one.
- It invents no model route. Unless a model is supplied, no `models.default` is
  written, and work is refused rather than silently billed when no free model is
  verified.
- It writes nothing outside the repository, and it never publishes, pushes or
  deploys.
- It never clobbers a generated file that already exists and differs. A repo
  that already has a `projects.json` has decisions in it that an installer
  cannot re-derive.
- It does not claim a check passed when the check could not run.

## Vendored versus generated

| Kind | Files | Note |
|---|---|---|
| **Vendored** (byte-copied from `assets/stack/`) | `orchestration/tabs.mjs`, `orchestration/selftest.mjs`, `orchestration/README.md`, `orchestration/lib/{topology,cap,herdr,ego,handoff,free-models}.mjs` | the proven modules; a fix belongs upstream in `assets/stack/orchestration/`, not in an installed copy |
| **Generated** (per repo) | `orchestration/projects.json`, `orchestration/state/.gitignore`, `.acc/config/config.yaml`, `.acc/config/templates/agents.md`, `.acc-memory.md`, one `<tree>/.acc-memory.md` per project, `proagents/MONEY-CONTRACT.md`, `proagents/knowledge/CREW-PROTOCOL.md`, `proagents/registry/experts.json`, `STACK.md` | every field comes from the intake and the inspection |
| **Merged** | the `ace` key in `package.json` | added, never replacing the file; all other keys are left exactly as they were |

The shipped assets are `assets/stack/orchestration/` in this package. The
installer reads them from disk at apply time; a package missing one refuses the
plan instead of writing a partial setup.

## Which copy is which (maintainers)

| | `show-me-the-money/orchestration/` | `ace-proagents/assets/stack/orchestration/` |
|---|---|---|
| What it is | the lab's **running** copy | the **shipped**, generic copy installed into other repos |
| `projects.json` | the lab's own projects, with their live missions and state | generated per repo from the intake — never shipped |
| `lib/free-models.mjs` | imports the lab's `engine/model-index.mjs` and `proagents/core/free-models.mjs` for discovery, scoring and blocker classification | self-contained: sources are `ACE_FREE_MODEL_COMMAND`, the opencode serve catalog, then a labelled cache, with the blocker classifier inlined |
| `lib/cap.mjs` | reads `engine/state/run-control.json` for the operator's cap | the same file by default, overridable with `ORCHESTRATION_RUN_CONTROL` |
| `selftest.mjs` | asserts the lab's own topology and measurements | asserts whatever `projects.json` was installed, against a scratch state dir |
| `README.md` | the lab's account of its own cutover, with dated measurements | the manual for an installed repo |
| State | the lab's live `state/` | never shipped; each repo writes its own |

The two copies are kept in sync by hand. When a file changes in the lab, the
portable copy must be re-synced and re-verified — the bundle is what other people
install, so a fix that only lands in the lab copy does not reach anyone.
