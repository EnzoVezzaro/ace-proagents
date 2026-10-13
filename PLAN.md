# ACE — rebuild plan, v0.2.0

**Status: the working plan for this rebuild.** Written before the work, updated
as phases land.

## 0. The product, restated

ACE is an **agent skill + CLI** for building workspaces that autonomous coding
agents can operate in. One command turns an ordinary repository into a governed
agent workspace: terminal spaces, browser spaces, a governor over a global
worker budget, one supervisor and its workers per project, durable memory, and
the task contract every mission ends with.

Two surfaces, one product:

- **The CLI (`ace`)** — the only thing that acts. `ace setup` interrogates →
  inspects → plans → applies → verifies; `ace inspect` shows the facts a plan
  can be built from; the governance commands (`govern`, `crew`, `task`,
  `handoff`, `watchdog`, `adapters`) drive what was installed. Everything is
  machine-readable (`--json`), every refusal names the fix.
- **The skill (`ace`)** — the manual an agent loads before running any of it.
  It ships inside the package and is installed into the target repository, so
  the agent that will live in the workspace carries its own operating manual.

The customer is an agent acting for an operator. A human can run every command
from a terminal; nothing requires one.

## 1. What stays (the structure)

- **The linked parts.** The stack is parts, not a template dump, and each part
  hands an exact name to the next. Six crew parts — `herdr-spaces`,
  `ego-lite-spaces`, `govern`, `supervisors-workers`, `acc`, `charter` — plus
  the new `agent-skill` part (below).
- **One name.** `project.id === its tab label === its browser space ===
  basename(its tree)` — enforced in code, not by prompt.
- **Plan → apply → verify.** `--dry-run` writes nothing; an existing file is
  never clobbered without `--force`; memory is seeded once and never
  overwritten; every check that cannot run is reported `skip` with its reason.
- **The governance runtime.** Governor → supervisors → workers over one global
  budget; free-model-or-refuse; evidence-or-`unverified` handoffs; bounded,
  audited recovery; the watchdog; adapters everywhere; the layered config.
- **Zero dependencies.** Node builtins only, builtin `node:test` runner,
  Node 20+. MIT.

## 2. What changes in this rebuild

| # | Change | Why |
|---|---|---|
| A | **The skill ships in the package** (`skills/ace/SKILL.md`, repo-root layout) and a seventh part, `agent-skill`, installs it into the target repo at `.agents/skills/ace/SKILL.md` + `.claude/skills/` + `.opencode/skills/` (three copies of one source, verified equal) | the skill used to live only beside the workspace that uses ACE; now it travels with the product that builds them, in the layout skill managers (`npx skills add`) and Claude plugin marketplaces (`.claude-plugin/`) discover |
| B | **`ace inspect [--json]`** — prints the repo facts (candidate roots, detected verification, browser suggestion, git, node) an agent needs to build the intake | the agent path was "read the error, guess again"; now the facts are a first-class command |
| C | **Structured intake refusals** — `INTAKE_INVALID` keeps per-field `field` / `fix` entries in the error document | an agent must be able to repair its intake programmatically |
| D | **Copy updated everywhere** — six parts → seven; the product line is now "agent skill + CLI" | the docs were written for the v0.1.x framing |
| E | **Landing page redo** — same phosphor terminal world, rebuilt around the skill + CLI loop, improved typography, grid and motion | the landing still sells the v0.1.x framing |
| F | **Tests and CI** — the seventh part is verified like the others; the smoke run checks the skill file | the verifier's rule: a part exists only if it is checked |
| G | **Release 0.2.0** — version bump, npm publish, tag | the registry must match the repository |

## 3. The `agent-skill` part

- Source of truth: `assets/skill/ace/SKILL.md` (vendored — copied verbatim,
  never generated). A shipped asset is fixed at its source; fix it there, then
  re-run `ace setup --force` where it must land.
- Installs: `.agents/skills/ace/SKILL.md`.
- Requires nothing; it is the driver's manual, usable before any other part.
- Verify: the file exists, carries valid skill frontmatter (`name: ace`), and
  names the setup command it documents.
- Idempotency: like every vendored non-`.mjs` file, an existing copy is kept
  unless `--force`.

## 4. The skill's contract (what SKILL.md must teach)

1. **Inspect before answering.** `ace inspect --json` first; answer intake from
   evidence, never invention.
2. **Answer the intake.** `ace parts --questions --json` is the schema;
   `--intake file.json` or flags are the answer formats.
3. **Plan, then apply.** `--dry-run` first; read the plan; then apply and read
   the verify verdict — including its `skip`s.
4. **Drive what was installed.** `orchestration/tabs.mjs` (plan · up · status ·
   cap · govern · brief · dispatch · verify · cycle) inside the multiplexer;
   `ace crew` / `ace govern` / `ace task` / `ace handoff` from the runtime.
5. **The honesty rules.** One name per project; 1 + N tabs; one global budget;
   free models only; evidence or silence; governor talks to supervisors only;
   memory is seeded once.

## 5. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| 1 | `assets/skill/ace/SKILL.md` | the manual is complete and accurate against the real CLI surface |
| 2 | `lib/stack.mjs` + `lib/cli-stack.mjs` | seven parts; `ace inspect`; structured refusals; `--help` updated |
| 3 | tests | `npm test` green, including the new part, `inspect`, and skill assertions |
| 4 | docs | README, AGENTS.md, docs/STACK.md, PRODUCT.md tell the same story as the code |
| 5 | landing | `site/` rebuilt; `npm run check` clean; no external assets |
| 6 | release | version 0.2.0 published; repo pushed; landing/README state the registry version as it is |

## 6. Non-goals

- No rename, no new package name, no rewrite of the governance runtime.
- No new dependency, ever.
- No weakening of a check, an assertion or a refusal to make this pass.
- No invented claim on the landing or in the docs.
