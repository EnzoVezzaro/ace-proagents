// orchestration/lib/ego.mjs — Ego Lite, one space per project.
//
// THE INVARIANT (the unit of isolation in this workspace):
//
//     project.id  ===  project.browser_space  ===  basename(project.root)
//
// A project is ONE space: its tree and the Ego Lite task space its browser work
// happens in share one name, so there is one place to look for what it touched
// and one place to look for what it did in a browser.
//
// WHAT CHANGED IN TOPOLOGY V3: a project owns its own Herdr tab again (id =
// label = project.id — see lib/topology.mjs), and it also owns its own browser
// space. The three names are one name: the project's id, its tab label, its
// browser space, and the basename of its own root directory all agree, so a
// project is one place whether you look in the terminal, in the browser, or on
// disk. Isolation between projects is enforced by PATH (owned_paths /
// forbidden_paths in every delivered prompt, and the handoff directory check in
// lib/handoff.mjs), by BROWSER SPACE, and by TAB — a worker sits in its project's
// tab and its own space, and neither is shared with another project.
//
// This module names that invariant, asserts it, and hands an agent the exact
// command to run. It deliberately does NOT proxy the browser: the tool is
// invoked by the agent, inside the agent's own turn, in its own pane — which is
// also how the installed usage works (docs/admin/OPERATING.md).
//
// VERIFIED (2026-10-13, ACTUAL):
//   ego-browser nodejs -e '…'  with a flat script, `const task = await
//   taskSpace("<project id>")` then `task.page("p1")`
//   → `{"space":92,"chars":1032}` read from https://example.com.
//   A `taskSpace(name)` call reuses the existing space with that name.
//   The autoarb adapters also drive this same driver for Copart and IAA
//   (`AUTOARB_BROWSER_DRIVER=ego-browser`).
//   NOT verified: an exec helper that builds and runs the snippet for you — an
//   earlier version of this file did that and it did not complete. The command
//   text below is what is proven; run it, do not wrap it.
//
// BOUNDARIES (hard limits, not preferences):
//   - public / robots-permitted pages only;
//   - sign in only with the operator's own existing session;
//   - never bypass a login, CAPTCHA or anti-bot control — if a human is needed,
//     the agent calls `await task.handOff()` and says so;
//   - one space per project for the whole job; never open a second space to
//     escape a stuck page, and never work in the other project's space.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

export const EGO_BIN = process.env.EGO_BROWSER_BIN || "ego-browser";

/** The task-space name for a project: its declared space, else its own id. */
export function spaceFor(project) {
  return project.browser_space || project.id;
}

/** The name a project's space is anchored to: the basename of its root tree. */
export function spaceNameFromRoot(project) {
  if (!project?.root) return null;
  return path.basename(String(project.root).replace(/[/\\]+$/, ""));
}

/**
 * The invariant, checkable. Returns the violations, so the orchestrator can
 * refuse to describe a project whose names disagree.
 */
export function spaceInvariant(project) {
  const id = project.id;
  const space = spaceFor(project);
  const root = spaceNameFromRoot(project);
  const violations = [];
  if (space !== id) violations.push(`browser_space "${space}" != project id "${id}"`);
  if (root && root !== id) violations.push(`root basename "${root}" != project id "${id}"`);
  if (!project?.root) violations.push("project declares no root tree");
  return { ok: violations.length === 0, id, space, root, violations };
}

/** Is the Ego Lite CLI installed? */
export function egoAvailable() {
  return run(EGO_BIN, ["--version"], { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * The exact command an agent runs for browser work in this project's space.
 *
 * `body` is spliced in as FLAT statements (the form that is verified to work —
 * not an IIFE) and must assign `out`. `spaceId` and `task` are already bound;
 * declare your own `page`.
 */
export function commandFor(project, body) {
  const spaceId = spaceFor(project);
  const script = [
    `const spaceId = ${JSON.stringify(spaceId)};`,
    "const task = await taskSpace(spaceId);",
    String(body).trim(),
    "console.log(JSON.stringify({ space_id: spaceId, result: out }));",
  ].join("\n");
  return { spaceId, script, shell: `${EGO_BIN} nodejs -e ${JSON.stringify(script)}` };
}

/**
 * The browser brief every mission prompt carries. Kept beside the code above so
 * the space naming and the boundaries cannot drift apart.
 */
export function browserBrief(project) {
  const { ok, space, violations } = spaceInvariant(project);
  const lines = [
    `Browser work (Ego Lite): use ONLY the space "${space}" — one space per project, named after this project's own root tree (${project.root}). Never open a second space.`,
    `Run it as a flat script: ${EGO_BIN} nodejs -e 'const task = await taskSpace("${space}"); const page = task.page("p1"); await page.goto("https://example.com"); …'`,
    "Public/robots-permitted pages only. Sign in only with the operator's existing session.",
    "Never bypass a login, CAPTCHA or anti-bot control; when a human input is unavoidable, call await task.handOff() and report it.",
    "Your project owns its own tab and its own space; another project's agents live in a different tab and a different space.",
    "The tab is not the boundary that matters — the path budget in this prompt is. Never read or write another project's tree, its state directory, or its browser space.",
  ];
  if (!ok) lines.unshift(`SPACE INVARIANT VIOLATED: ${violations.join("; ")}`);
  return lines.join("\n");
}
