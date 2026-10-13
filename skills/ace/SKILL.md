---
name: ace
description: Build and drive an agent workspace with ACE — the CLI that installs a governed crew of coding agents into a repository, and the runtime that governs it. Use when the work is setting up autonomous agents in a repo, installing the crew stack, answering the setup intake, driving an installed orchestration (tabs, cap, govern, dispatch, handoffs), or when the user mentions ace setup, agent workspace, crew, governor, supervisor, worker, or agent orchestration.
license: MIT
metadata:
  opencode/slash: "true"
---

# ACE — build the workspace, then drive it

ACE turns an ordinary repository into a workspace where autonomous coding
agents operate: one terminal tab per project plus a control plane, one browser
space per project, a governor over a **global** worker budget, one supervisor
and its workers per project, durable memory per tree, and the task contract
every mission ends with.

You build it with the CLI alone. No terminal prompt is needed — every command
accepts its answers as flags or a JSON file, prints one JSON document with
`--json`, and refuses with a structured error that names the fix.

## 0. Get the CLI, wherever this skill came from

Run ACE from any directory — nothing needs to be cloned first:

```bash
npx ace-proagents@latest --help
```

Every example below reads `ace <command>`; substitute
`npx ace-proagents@latest` when the CLI is not installed. If a checkout of the
repository is present, `node <checkout>/ace.mjs` is equivalent.

When you are working **inside a repository that already has ACE installed**
(`orchestration/projects.json` exists), skip to section 4 — the workspace's
own decisions live there, not in this skill.

## The one rule that holds it together

```
project.id === its tab label === its browser space === basename(its tree)
```

A project is one name in the terminal, in the browser, on disk and in the
governor's report. Every command below reads and enforces that name.

## 1. Inspect before you answer

```bash
ace inspect --json
```

This prints the repository's facts: candidate work-area roots, detected
verification scripts (only what the manifest actually declares), whether
browser work is suggested, git state, node version. **Answer the intake from
these facts, never from invention.** If `candidate_roots` is empty, create or
confirm the trees first — a project is a real directory, not a name.

## 2. Answer the intake

```bash
ace parts --questions --json     # the schema: id, kind, required, default, why
```

Three required answers, plus what you choose:

| Answer | Required | How to decide |
|---|---|---|
| `goal` | yes | one sentence: what must this crew produce |
| `outcome` | yes | the checkable outcome the work produces |
| `projects` | yes | the trees from `ace inspect` the crew works in |
| `harness` | no | `opencode` (default), `claude`, `codex`, `gemini`, `freebuff` |
| `model` | no | `provider/model`, only when one is pinned; no answer = no route written |
| `cap` | no | global worker budget, default 4 |
| `workers_per_project` | no | default 1 |
| `browser` | no | yes only when the work needs a browser |
| `verification` | no | commands that prove a change is done; defaults to detected scripts |
| `first_task` | no | one line; it must carry an outcome to be dispatched |
| `deadline` | no | recorded in the goal |

Pass the answers as a file (preferred — one document, reviewable):

```bash
ace setup --intake intake.json --json
```

or as flags:

```bash
ace setup --goal "…" --outcome "…" --projects path/a,path/b --json
```

## 3. Plan, then apply

Always dry-run first, and read the plan — it lists every write and which part
causes it:

```bash
ace setup --intake intake.json --dry-run --json
ace setup --intake intake.json --json
```

The verdict reports `passed / failed / skipped`. A `skip` is a check that could
not run, with its reason — live tab creation needs a running multiplexer, a
governor cycle needs live state. Never report a skipped check as a pass.

Refusals are structured documents on stderr (`INTAKE_INVALID`,
`PLAN_INVALID`, exit 2) with per-field `errors` and `fix` entries: repair the
named fields and re-run. Nothing is written until the plan is valid.

Exit codes: `0` installed and verified · `1` installed but a check failed or an
operator must act · `2` usage, intake or plan error — nothing written.

## 4. What was installed

```text
orchestration/projects.json   the data: topology, budget, harness policy, projects, tasks
orchestration/tabs.mjs        the orchestrator: plan · up · status · cap · govern · brief · dispatch · verify · cycle
orchestration/state/          per-project missions, handoffs, dispatch and cap logs (private)
.agents/skills/ace/SKILL.md   this skill (cross-harness location)
.claude/skills/ace/SKILL.md   same skill, where Claude Code looks
.opencode/skills/ace/SKILL.md same skill, where OpenCode looks
STACK.md                      the map of what was installed, and how to drive it
.acc-memory.md                durable memory, and one beside each project tree
charter/                      the task contract, the handoff convention, the tool registry
```

The three skill copies are byte-identical, written from one shipped source in
one apply — the installer verifies their equality, so they cannot drift. Other
harnesses (Codex, Copilot, Cursor, Gemini CLI…) read `AGENTS.md`: point them at
`.agents/skills/ace/SKILL.md`, or paste its frontmatter description into the
repo's own `AGENTS.md` so the skill triggers.

Read the installed `STACK.md` and `orchestration/projects.json` before driving
anything — they are this workspace's actual decisions, not defaults.

## 5. Drive the installed crew

Outside a multiplexer (planning, reading state, the cap):

```bash
node orchestration/tabs.mjs plan        # the roster, and the budget with its source
node orchestration/tabs.mjs cap         # the effective cap AND where it came from
node orchestration/selftest.mjs         # the installed setup's own proof, offline
```

Inside a running multiplexer (Herdr session):

```bash
node orchestration/tabs.mjs up          # create the tabs, start the agents that fit
node orchestration/tabs.mjs status      # topology, cap, control plane, missions
node orchestration/tabs.mjs govern      # the governor's brief across every project
node orchestration/tabs.mjs brief --project <id> --task <task-id>
node orchestration/tabs.mjs dispatch --project <id> --task <task-id>
node orchestration/tabs.mjs verify      # validate handoffs, apply the failure behaviour
node orchestration/tabs.mjs cycle       # recovery recheck → verify → next task
```

From ACE's own runtime, the same crew from the governance layer:

```bash
ace crew --json                  # the roster, the live budget, the boundary rule
ace govern --dry-run             # one governor cycle, predicted
ace task add "<title>" --outcome "…"   # a task with no outcome line is refused
ace task claim <id> --agent <a>  # single-owner, lease-backed
ace handoff submit <task> --file handoff.json
ace handoff verify <task>        # refuses a DONE claim with no command that exited 0
ace adapters health              # the adapter registry at runtime
```

## 6. The rules you are governed by

- **One name per project.** If id, tab label, browser space or tree basename
  disagree, the selftest fails — fix the data, never the check.
- **Always 1 + N tabs.** One control plane, one tab per project. Adding a
  project adds one tab of data, never a second control plane.
- **One global worker budget.** Every project, every harness; the control plane
  is never counted, never trimmed. The cap is a setting — `tabs.mjs cap --set N`.
- **Free models only.** A model runs work only when its freeness is established
  this run (`ACE_FREE_MODEL_COMMAND`, or the opencode catalog). A name
  containing `-free` is not evidence. Nothing verified → dispatch refused, never
  silently billed.
- **Evidence or silence.** A handoff that claims `DONE` without a command, a
  path or a measurement is recorded `unverified`, not done. Passing in a
  worker's own pane does not prove the integrated tree passes — the checks are
  re-run after integration.
- **The governor talks to supervisors only.** A governor → worker message is
  refused in code; go through that worker's supervisor.
- **Recovery is bounded and audited.** Checkpoint first, hold the lease, respect
  the restart budget, journal to `.ace/actions.jsonl`, never report a restart
  that was not delivered.
- **Memory is seeded once.** `.acc-memory.md` is never overwritten — not even
  with `--force`. Read it before working; add what you learned.
- **Report honestly.** A round that produced no movement says so. `checksNotRun`
  exists so you can name what you did not verify.

## 7. When something refuses

Refusals are the product working. `INTAKE_INVALID` and `PLAN_INVALID` name the
fields; `NO_VERIFIED_FREE_MODEL` names the missing evidence; a cap refusal names
the budget and its source. Repair the named thing and re-run — never weaken a
check, never fake a timestamp, never write outside the project tree you own.
