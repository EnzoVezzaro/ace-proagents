# Application integration

## Status: the landing lives here; a separate application's source does not

`https://ace-seven-blue.vercel.app` serves the static landing in `site/`
(`index.html`, `styles.css`, `app.js`, `vendor/motion.mjs`),
built and deployed from this repository (`vercel --prod` from `site/`). Three
hosts serve that same landing:

| Host | Vercel project | How it deploys |
| --- | --- | --- |
| `ace-seven-blue.vercel.app` | `ace` | CLI only (`vercel --prod` from `site/`) — no Git link |
| `ace-enzovezzaros-projects.vercel.app` | `ace` | the project's automatic team alias |
| `ace-proagents.vercel.app` | `ace-proagents` | Git push to `main`, **Root Directory `site`** |

Both projects read the same `site/` tree. The `ace` project has **no** Git link
by choice, because it once carried one to the lab repository and every push
there deployed *that* repository's root — which has no `index.html` — silently
replacing this landing with a 404 (first observed 2026-10-13; link removed). The
`ace-proagents` project is the push-to-deploy path, and it only works because its
Root Directory is `site`; with the root directory unset it deployed this
repository's root and served the same 404 (fixed 2026-10-13). If a deploy ever
reports 404 again, check `rootDirectory` before touching the landing.

What this repository does not contain is an application's source: what such an
application would consume is the surface described below.

What this repository does provide is the machine-consumable surface such an
application needs, in two layers:

1. **`ace setup`** — the installer. It interrogates, inspects the target
   repository, plans, applies and verifies, and every stage is available as one
   JSON document. A UI can drive the whole installation without a terminal.
2. **the runtime** — `ace govern` / `crew` / `task` / `handoff` / `watchdog` /
   `adapters`, plus the orchestrator the installer writes into the target repo
   (`orchestration/tabs.mjs`). Read-only surfaces for a status view.

Both layers are on `origin/main` (pushed 2026-10-13) and in the published package
(`0.1.4`), so a UI may shell out to the installed `ace` or to a clone; npm's
`0.1.2` predates the installer.

Every command below is implemented and covered by `test/`. All are read-only
except where noted; none prints a credential.

## The installer surface

| Command | Returns |
| --- | --- |
| `ace setup --json` | One document: the answers used and where they came from, the inspected facts, the plan, what was written, and the per-part verification |
| `ace setup --dry-run --json` | The plan alone (`dry_run: true`); nothing is written |
| `ace parts --json` | The six installable parts: id, title, what each installs, what it requires, how it is verified |
| `ace parts <id> --json` | One part in full |
| `ace parts --questions --json` | The intake schema: for each question its id, prompt, kind, whether it is required, its default, the repo fact it can be detected from, and why it matters — the shape a UI renders as a form |

The document from `ace setup --json` is the one a UI reads. Its fields:

```text
command        "setup"
answers_from   "flags" | "file" | "terminal" | a combination
facts          dir, is_git, branch, manifest (name, scripts, workspaces) or null,
               has_ace_key, has_orchestration, has_acc_config, has_acc_memory,
               has_agents_md, candidate_roots[],
               detected_verification[{ name, command }], browser_work_suggested, node
plan           at, dir, force, parts[{ id, title, requires, installs, verify }],
               writes[{ path, kind, from?, part }], links[{ from, to, name, how }],
               config{ name, goal, outcome, harness, model, cap, browser, verification, projects },
               violations[]
applied        written[{ path, kind, bytes?, note? }], skipped[{ path, reason }],
               created_dirs[], at
verify         ok, passed, failed, skipped,
               checks[{ part, name, status, detail }]   status: "pass" | "fail" | "skip"
```

`plan.links` is the part-to-part contract as data: which exact name one part
hands to the next (`project.id`, `browser_space`, `cap`, `tasks[].outcome`,
`acceptance`). `plan.violations` is non-empty only when the answers would produce
a setup the rules reject — a project root that does not exist, two trees that
collide on one id, an agent name the multiplexer cannot attach. A UI should show
`verify.checks` verbatim rather than summarising it: a `skip` is a check that did
not run, and it always names its precondition.

## The runtime surface

| Command | Returns |
| --- | --- |
| `ace status --json` | The full governance snapshot: goal, crew, live agents, budget, task counts, heartbeats, watchdog, bots, adapter health, configuration validity |
| `ace config --json [--resolve]` | The effective configuration, the layer that set each key, validation errors, the security floor |
| `ace crew --json` | The declared roster plus the live budget and its per-runtime caps |
| `ace govern --json` | One governor cycle: detections, actions taken, escalations, `checksNotRun` |
| `ace supervise --json` | One supervisor cycle: assignments, route changes, verifications, blockers |
| `ace task list --json`, `ace task show <id> --json` | Task state, owner, attempt, history, handoffs |
| `ace watchdog status --json` | Governor liveness, the lease, the restart budget, escalations |
| `ace bots status --json` | Whether the experimental management-bot intake is enabled and ready, and what is missing |
| `ace adapters health --json` | Per-capability provider health and compatibility |

In an installed repository the orchestrator prints its own documents, and they
are not uniform — check before parsing:

| Command | Output |
| --- | --- |
| `node orchestration/tabs.mjs status` | one JSON document, always (topology, placement, cap with its source, per-project missions, free-model pool, circuits) |
| `node orchestration/tabs.mjs cap` | one JSON document, always (the cap, **and where it came from**) |
| `node orchestration/tabs.mjs plan --json` | the roster: control plane, workers, what the cap trimmed |
| `node orchestration/tabs.mjs up` | one JSON document of what it started, refused, or would start under `--dry-run` |
| `node orchestration/tabs.mjs dispatch --project <id> --task <id>` | one JSON document; writes nothing under `--dry-run` |
| `node orchestration/tabs.mjs govern` | the governor's brief as **prose** (no `--json`), also written to `orchestration/state/_global/governor-brief.md` — read the file, do not scrape the prose |
| `node orchestration/tabs.mjs brief --project <id> --task <id>` | the prompt text that would be delivered, verbatim |

Every command accepts `--json`, including the mutating ones (`config set`, `task
claim`, `route set`, `bots enable`, `handoff submit`), so a UI never has to
scrape prose. The stream discipline is fixed:

- **Success:** exactly one JSON document on **stdout**, stderr empty.
- **Refusal / error:** exactly one structured error document
  (`{ code, message, recoverable, suggestions }`) on **stderr**, stdout empty.
- **Loops:** `ace watchdog run --json` and `ace autopilot run --json` write one
  document **per cycle** (a stream, not one document) for as long as the loop
  runs.

Exit codes are meaningful for a UI: `0` success · `1` an operator action is
required (an escalation, a rejected handoff, a failed post-merge check, a
transition that is not legal) — and for `ace setup`, installed but a check
failed · `2` a usage, intake or plan error, and for `ace setup` **nothing was
written**. The governance commands fail closed outside an initialized workspace
(`PROJECT_NOT_INITIALIZED`, exit 1); `ace setup` is the command that initializes
one.

### What a UI must not do

- Do not scrape the human-readable output: the `--json` documents are the
  contract. Prose changes; these fields do not.
- Do not offer a control that bypasses a policy. Any control a UI exposes must
  call the same command the CLI offers, so the budget, the isolation checks, the
  verification requirement and the security floor all still apply.
- Do not drive `ace setup` interactively on behalf of a user. Supply
  `--intake` or flags: with no answers and no terminal it refuses
  (`INTAKE_INVALID`) and names every missing field, and that refusal is the
  contract, not a prompt to work around.
- Do not assume a long-running command returns once: the loop a UI shows as
  "watchdog" is `ace watchdog on` (detached), not `ace watchdog run` (foreground,
  streams a document per cycle, needs `--max-cycles` to end).
- Do not read `.ace/secrets/`, and do not echo a `secret_ref` value. Secrets are
  referenced by name (`secret:<name>`) and redacted from events, handoffs and the
  action journal.

## What is not implemented here

- **No HTTP API.** The commands are the interface; exposing them over HTTP with
  per-operation authorization is not part of this build.
- **No live management-bot transport.** `lib/bots.mjs` implements the intake
  adapter, validation and idempotency; a delivery transport for GitBot or
  OpenDots does not exist upstream as an ACE integration and is not implemented
  here. Deliveries are recorded and retried, and `ace bots status` says so
  rather than implying a connection exists.
- **No provider quota or usage API.** The governor reports it as a check it did
  not run, because no quota endpoint is integrated.

Two layers, and they are not the same thing:

- **ACE's own runtime** records a delivery request and reports `delivered:
  false`; it does not start an agent.
- **The installed stack** — the six parts, driven by `orchestration/tabs.mjs` —
  really does create tabs, split panes and start agents, and it does that
  through Herdr. What it will not do is *install* and *dispatch* in one step:
  `ace setup` starts nothing, and `tabs.mjs up` is what does, inside a running
  Herdr session.

## Minimal wiring sketch

The smallest useful integration reads two documents: one to install, one to
watch.

```bash
ace setup --dry-run --json    # a plan the user approves before anything is written
ace setup --json              # install; read applied.written and verify.checks
ace status --json             # then poll: goal, crew, budget, tasks, watchdog
```

Controls go through the same commands an operator uses — `ace govern --json` for
one cycle, `ace task claim <id> --agent <agent>` to take work, `ace watchdog
cycle --json` to ask the independent control plane to check the governor.
Anything beyond that — a server, authentication, per-action authorization, a
form that renders `ace parts --questions` — is net-new work in the application's
own repository.
