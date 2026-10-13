# Application integration

## Status: the deployed app's source is not in this repository

`https://ace-seven-blue.vercel.app` is deployed from a separate workspace. This
repository contains the CLI package and the static landing under `site/`
(`index.html`, `donate.html`, `styles.css`, `app.js`, `vendor/motion.mjs`) — it
does not contain the application's source. **No frontend change was made as part
of the governance work, and nothing here should be read as having modified the
deployed app.**

What this repository does provide is the read-only, machine-consumable surface
such an application needs. Wiring it up is a separate piece of work.

## The surface a UI should consume

Every command below is implemented and covered by `test/`. All of them are
read-only except where noted; none of them prints a credential.

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

Every governance command accepts `--json`, including the mutating ones
(`config set`, `task claim`, `route set`, `bots enable`, `handoff submit`), so a
UI never has to scrape prose. The stream discipline is fixed:

- **Success:** exactly one JSON document on **stdout**, stderr empty.
- **Refusal / configuration error:** exactly one structured error document
  (`{ code, message, recoverable, suggestions }`) on **stderr**, stdout empty.
- **Loops:** `ace watchdog run --json` writes one document **per cycle** (a
  stream, not one document) for as long as the loop runs.

Exit codes are meaningful for a UI: `0` success, `1` an operator action is
required (an escalation, a rejected handoff, a failed post-merge check, an
task transition that is not legal), `2` a usage or configuration error. The
governance commands fail closed outside an initialized workspace
(`PROJECT_NOT_INITIALIZED`, exit 1).

### What a UI must not do

- Do not scrape the human-readable output: the `--json` documents are the
  contract. Prose changes; these fields do not.
- Do not assume a long-running command returns once: start the loop a UI shows
  as "watchdog" is `ace watchdog on` (detached), not `ace watchdog run`
  (foreground, streams a document per cycle, needs `--max-cycles` to end).
- Do not read `.ace/secrets/`, and do not echo a `secret_ref` value. Secrets are
  referenced by name (`secret:<name>`) and redacted from events, handoffs and the
  action journal.
- Do not offer a control that bypasses a policy. Any control a UI exposes must
  call the same command the CLI offers, so the budget, the isolation checks, the
  verification requirement and the security floor all still apply.

## What is not implemented here

- **No HTTP API.** The commands are the interface; exposing them over HTTP with
  per-operation authorization is not part of this build.
- **No live management-bot transport.** `lib/bots.mjs` implements the intake
  adapter, validation and idempotency; a delivery transport for GitBot or
  OpenDots does not exist upstream as an ACE integration and is not implemented
  here. Deliveries are recorded and retried, and `ace bots status` says so
  rather than implying a connection exists.
- **No live multiplexer delivery.** The adapter registry declares Herdr, but no
  live agent dispatch is wired: governance records the request and reports
  `delivered: false` instead of claiming an agent was started.
- **No provider quota or usage API.** The governor reports it as a check it did
  not run, because no quota endpoint is integrated.

## Minimal wiring sketch

The smallest useful integration reads one document per refresh:

```bash
ace status --json        # goal, crew, budget, tasks, watchdog, bots, adapters
```

and drives controls through the same commands an operator uses, for example
`ace govern --json` for one cycle, `ace task claim <id> --agent <agent>` to take
work, or `ace watchdog cycle --json` to ask the independent control plane to
check the governor. Anything beyond that — a server, authentication, per-action
authorization — is net-new work in the application's own repository.
