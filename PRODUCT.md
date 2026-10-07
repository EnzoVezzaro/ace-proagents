# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Primary: developers shipping orchestrator-driven agentic coding workflows —
people who already run multi-agent CLIs and CI-style task runners and want a
reproducible, shareable *environment* (not app source) the way npm packages
dependencies. They judge a tool in seconds by reading its mechanism and its
CLI surface. (Confirmed: user answer 2026-10-06.)

## Product Purpose
ACE (Agentic Compute Environment) is an open, Git-native package ecosystem
for reproducible orchestrator-driven agentic coding environments. An ACE
package describes the environment — orchestrator, workers, tools, models,
policies, memory, lifecycle — not application source. Success means a
developer understands the mechanism in one screen, trusts the honesty of the
page, and runs the quick-start commands.

## Positioning
"ACE is npm for agentic coding environments." The mechanism a neighboring
product cannot copy: Git remains the source of truth while the registry only
indexes specifications; the package manifest's `ace` key (ace/v1) describes
the whole agent environment, lockfile `ace-lock.json` resolves versions with
integrity. Status: MVP phases 1–6, zero runtime dependencies.

## Capabilities
CLI surface: ace init / install / list / info / search / run / status /
context / agents / tasks / events / stop / snapshot / restore. Git-native
install (`github:<owner>/<repo>[#ref]`). Local registry optional.

## Constraints (confirmed, must preserve)
- Zero runtime dependencies and zero external requests for the site itself:
  static HTML/CSS/JS, vendored Motion bundle only, no CDN, no fonts from the
  network.
- Honesty rules: `window.ACE_CHECKOUT_URL` stays null until a real Stripe
  payment link ships; no invented prices, customers, benchmarks, or claims.
  ACTUAL/ESTIMATE/FORECAST/SCENARIO language is never merged.
- The site deploys as-is to static hosting (Vercel project `ace`).
- Money values are integer cents wherever shown (not shown on this surface).

## Voice
Precise, technical, confident; mechanism over adjectives. Developer-native
vocabulary (manifest, lockfile, registry, runtime, snapshot).

## Open decisions
- Visual direction for the landing: open (direction round, 2026-10-06).
- Assumption labeled: platform `web` inferred from the static-site codebase;
  no native surface exists.
