# orchestration — one control plane, one tab per project

This directory is the crew's control surface. It was installed by `ace setup`;
the six parts it belongs to and how they link are described in `STACK.md` at the
repository root.

```
orchestration/
  projects.json      the topology, the budget, the rosters, the scopes, the queues, the harness policy. DATA.
  tabs.mjs           the orchestrator CLI (plan · up · status · cap · govern · brief · dispatch · verify · cycle)
  selftest.mjs       the installed setup's own proof, run offline against a scratch state dir
  lib/topology.mjs   the 1 + N tab contract: role → tab, the governor, the placement invariant
  lib/cap.mjs        the worker cap, defined, enforced, and adjustable from settings
  lib/handoff.mjs    the handoff convention with a lifecycle and an explicit failure behaviour
  lib/herdr.mjs      the only place this code talks to the multiplexer
  lib/ego.mjs        one browser space per project, named after the project's own tree
  lib/free-models.mjs free-model discovery, selection, failover, circuits, recovery
  state/<project>/   that project's missions, handoffs, dispatch ledger, cap log
  state/_global/     assignments, provider health, cap changes, the governor brief
```

Nothing here decides *what* a project should do. That is `projects.json`. Adding
a project or a task is adding data; it never means editing a branch in `tabs.mjs`.

## The shape: always 1 + N tabs

```
tab                holds                          capped?
─────────────────  ────────────────────────────   ───────
control-plane      governor + supervisors          no
<project id>       that project's workers          yes (one global budget)
```

There is always exactly **one control plane** and **one tab per project**, so
`N` projects means `N + 1` tabs. The project tabs are derived from `projects`:
a project's tab id, its label and its browser space are all its `id`, which is
also the basename of its tree.

```
project.id === project.browser_space === basename(project.root) === that project's tab id
```

That is the whole boundary system, and it is checkable rather than prose —
`lib/topology.mjs` returns the violations instead of describing them:

```
placementInvariant(config) → { ok, plan: ["control-plane", "<project>", …], violations: [] }
```

`up` refuses to act on a topology that violates the rule. So does `dispatch`,
because a mission whose project has no tab has no pane to be dispatched to.

Why the control plane holds the governor and the supervisors: the command
surface is the same job whatever the project, and splitting it per project would
leave the governor with nowhere to live. Why each project keeps its own tab: the
work surface is per project, so a project's terminal and its browser space can
carry one name.

## Roles

| Role | Where it lives | What it owns |
|---|---|---|
| `governor` | the control plane | one agent, the only one that reads across projects: checks each supervisor, checks that claims carry evidence, arbitrates when two projects want the same worker slot, mints the next task when a queue is empty, and ranks the next dollar across the portfolio |
| `supervisor` | the control plane | exactly one per project. Owns that project's queue, missions, handoffs and recovery, and never dispatches into another project |
| `worker` | its project's tab | does the work inside its own project's tree and its own browser space, and ends with a handoff artifact |

A governor authorises and ranks. It never prompts a worker directly — that
would create two dispatch paths, and then neither would be the truth.

## Commands

```bash
node orchestration/tabs.mjs plan                       # the roster, the live occupancy, the budget and its source
node orchestration/tabs.mjs up [--dry-run] [--project <id>]
node orchestration/tabs.mjs status                     # topology, cap, control plane, missions, pool, circuits
node orchestration/tabs.mjs cap                        # the effective worker cap AND where it came from
node orchestration/tabs.mjs cap --set <n>              # change it (writes the operator file, logs the change)
node orchestration/tabs.mjs govern [--dispatch]        # the governor's brief across every project
node orchestration/tabs.mjs brief  --project <id> --task <id>
node orchestration/tabs.mjs dispatch --project <id> --task <id> [--dry-run]
node orchestration/tabs.mjs verify [--project <id>] [--grace <minutes>]
node orchestration/tabs.mjs cycle [--dry-run] [--probe <n>]
```

Each one prints **one JSON document** on stdout. Read the JSON; the human
formatting is not the interface.

| Command | What it needs | What it does |
|---|---|---|
| `plan` | a running multiplexer session | reads live occupancy and prints the roster that fits: the control plane, then workers while slots remain, then what was trimmed and why |
| `up` | `HERDR_ENV=1` | creates the declared tabs by label, then starts the agents that fit. `--project <id>` initialises one project only — its supervisor and its workers — and touches no other project |
| `status` | nothing (degrades) | topology, placement verdict, cap with its source and per-project occupancy, control-plane liveness, free-pool provenance, provider circuits, per-project missions and queues |
| `cap` | nothing | the effective cap, its source, the occupancy, and the free slots |
| `govern` | nothing (degrades) | the cross-project brief, built from state: each supervisor's liveness, its queue, every mission and its last transition, and every claim that is not backed. `--dispatch` prompts the governor with it, and refuses if the governor is not running |
| `brief` | nothing | the exact prompt a task would be delivered with, without dispatching it |
| `dispatch` | a live pane for the owner | selects a verified free model, writes the mission and the brief, and prompts the owner's pane |
| `verify` | nothing | validates every open mission's artifact and applies the failure behaviour |
| `cycle` | nothing | recovery recheck → `verify` → the next pending task per project, reported |

**`--dry-run` decides and reports; it creates no tab, splits no pane, starts no
agent and writes no state.** That is enforced by short-circuiting before the
effect, not by a promise in this document.

### Exit codes

| Code | When |
|---|---|
| `0` | the command ran and reported |
| `2` | **refused**: a task with no money line; more workers active than the cap; no verified free model; no live pane assigned to the owner; `up` outside a multiplexer session (`HERDR_ENV != 1`); a topology violation; the governor is not running when `--dispatch` was asked for |
| `1` | usage error (unknown subcommand prints usage and exits 1) or an uncaught error, such as an unknown project or task id |

`verify` and `cycle` report; they exit `0` and put the per-mission verdicts in
their JSON. A refused handoff is a result, not a crash — read the document.

`plan` and `up` need a live multiplexer session, because both read live
occupancy. `status`, `cap` and `govern` read a live session when there is one and
report honestly when there is not.

## The worker cap

> Every project tab combined holds at most `max_active_workers` active agents,
> on every harness kind combined. The cap is one **global** budget — not per
> project, not per tab. The control plane is not capped.

An **active worker** is a pane that still has an agent attached in the
multiplexer (working, blocked, done, or idle-at-prompt) and whose name
`projects.json` declares with role `"worker"`. Idle-but-attached still holds its
slot; the agent exiting or the pane closing frees it.

Not counted: the governor, every supervisor, processes that are not agents, the
operator's own pane, another crew's panes, and any pane whose name is not
declared in `projects.json` — an unconfigured pane is unknown, not a worker this
orchestrator placed.

**Counted by config role, not by name prefix.** A supervisor and its workers
share a prefix (`<project>-supervisor`, `<project>-worker`), so prefix counting
would drag the control plane into the cap and trim a supervisor to make room for
a worker. `lib/cap.mjs` asks `lib/topology.mjs` instead.

The cap is a **setting**, resolved highest-first:

```
1. the operator file > worker_cap        (engine/state/run-control.json by default;
                                          ORCHESTRATION_RUN_CONTROL moves it)
2. env ORCHESTRATION_WORKER_CAP
3. projects.json > cap.max_active_workers (the value chosen at install time)
4. the built-in default, 4
```

`tabs.mjs cap` prints the effective value **and its source**: a cap that
silently came from an environment variable is a cap nobody can find.
`tabs.mjs cap --set <n>` writes the operator file and appends the change to
`state/_global/cap-settings.jsonl`, so a cap change is never silent.

On exceeding the cap the orchestrator **refuses**: it records the refusal in
`state/<project>/cap.jsonl` with its reason and continues with the roster that
fits. It never closes, steals or reassigns another agent's pane to make room,
and never opens a duplicate project tab.

## Delegation, and the handoff that closes it

A mission is created from a task, and a task **without a money line is refused**
(`lib/handoff.mjs` throws; `dispatch` exits 2). The delivered prompt is
self-contained on purpose: the receiving agent cannot see anyone's chat, so the
prompt names the project, the scope it may write, what is forbidden, the
acceptance criteria, the money line and where the handoff goes.

```
DELEGATE  supervisor → worker: ownership, scope, outputs, acceptance, money, destination
WORK      the worker works in its own tree, its own tab, its own browser space
HANDOFF   the worker writes state/<project>/handoffs/<mission>-<STATE>.md
VERIFY    exists · complete · right project · right mission · right owner · not stale · evidence
COMPLETE  the mission is closed and a ledger row is appended
```

```markdown
mission: t1-example
project: <project id>
owner: <agent name, or the pane that wrote this>
status: DONE | BLOCKED | FAILED | RETRY | ESCALATED

## Files changed
## Commands run
## Results
## Failures
## Evidence
## Next

HANDOFF: orchestration/state/<project id>/handoffs/t1-example-DONE.md
```

Field values are matched tolerantly — an agent may write
`owner: opencode (pane w5:p15)` — but the value must name the right mission, the
right project and the right owner; the pane that received the mission counts as
proof of ownership. The `HANDOFF:` marker must point at the artifact it appears
in, and `Evidence` must contain something real: a command and its output, a file
path, or a measurement. A `DONE` whose Evidence section is empty, shorter than a
few characters, or says `none` / `n/a` / `tbd` is **not** a completion.

### Failure behaviour — explicit, bounded, no loops

| Failure | Kind | Behaviour |
|---|---|---|
| no artifact, or required fields missing | `missing` / `incomplete` | the mission stays open: re-prompt the owner (bounded), then reassign to the next healthy agent, then **escalate to a human** |
| `DONE` with no usable evidence | `unverified` | one bounded attempt to produce evidence, then escalate. A claim is not a result |
| artifact written outside the project's own handoff directory | `isolation_violation` | refused. Nothing is closed by it |
| artifact older than the dispatch | `stale` | refused: re-run the mission and rewrite it |
| the owner died mid-task | `owner_died` | `failover_resume`: the mission keeps its id, its handoff path and its resume point, and continues on the next verified free model |
| provider circuit open | `blocked_provider` | parked in `interrupted` with the exact error and the resume point. Parked, not dropped |
| the agent cannot proceed at all (credentials, consent) | `denied` | `blocked`, with the exact blocker recorded |

The retry and reassignment budgets come from `projects.json > harness.failover`,
both decrement, and the terminal state is `escalated`, so a broken flow cannot
loop forever. Every transition is appended to
`state/<project>/handoff-ledger.jsonl`.

`verify` leaves a mission alone while it is still inside the grace window after
dispatch (20 minutes by default, `--grace <minutes>` to change it), so the
orchestrator's own polling cannot burn a healthy worker's retry budget.

## Free models only

A model is assigned work only when its freeness is **established for that run**.
A name containing `-free` is not evidence, and dispatch is **refused** when no
verified free model is available — nothing falls back to a paid model silently.

Discovery reports its own provenance, so a cache can never be read as a live
check. The sources, in order:

| Source | Meaning |
|---|---|
| `ACE_FREE_MODEL_COMMAND` | a command you supply that prints the free catalog as JSON on stdout |
| the opencode serve catalog | `http://127.0.0.1:$SENTINEL_PORT/api/model`, entries whose cost is zero |
| the labelled local cache | `state/_global/free-models-cache.json`, written whenever one of the above succeeded. Reported with `free_source: "cache"`, `served_live: false` and its `cached_verified_at` — previously measured is not the same as verified now |
| nothing | `discover()` returns an empty pool and `select()` throws `FreeModelUnavailable` |

`lib/free-models.mjs` adds per-model health on top: bounded retries, a cooldown,
a provider circuit after repeated hard failures, and recovery that restores a
provider **only** on a passing probe, with both outcomes written down.

## State on disk

| Path | What |
|---|---|
| `state/<project>/missions.json` | every mission: owner, scope, acceptance, model, state, attempts, retries |
| `state/<project>/missions/<id>.brief.md` | the exact prompt that was delivered |
| `state/<project>/handoffs/<id>-<STATE>.md` | the artifact |
| `state/<project>/handoff-ledger.jsonl` | every transition, with its reason |
| `state/<project>/dispatch.jsonl` | who got what, on which pane, on which model |
| `state/<project>/cap.jsonl` | refused and failed spawns, with the reason |
| `state/_global/assignments.json` | which pane holds which agent, in which tab |
| `state/_global/providers.json` | per-model health: hard/soft failures, cooldown, circuit |
| `state/_global/cap-settings.jsonl` | every worker-cap change, before → after |
| `state/_global/governor-brief.md` | the last governor brief |
| `state/_global/free-models-cache.json` | the last measured free pool, with when it was measured |

`state/` is runtime, not source: keep `.gitignore` and ignore what the agents
write into it.

## The installed setup's own proof

```bash
node orchestration/selftest.mjs
```

It drives the real code paths against a scratch state directory
(`ORCHESTRATION_STATE_DIR`), so a run never touches this repository's live state.
It checks the tab contract and the placement invariant (including planted
violations it must catch), the cap as arithmetic and as a setting with its
precedence, the browser-space invariant, the handoff lifecycle and each failure
kind, that every declared task carries a money line, and free-model selection
with an injected source — refusals included.

### What it does not cover

- No live multiplexer: it does not create a tab, split a pane or start an agent.
  `tabs.mjs plan` and `up` are the commands for that, and they need a running
  session.
- No network: it never calls a model provider, so it proves the free-model
  *policy*, not today's availability. Probe for that.
- No browser: the space invariant is checked, no page is opened.
- No profit: it proves the setup is coherent, not that the work is worth doing.
