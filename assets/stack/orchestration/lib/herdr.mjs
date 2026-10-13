// orchestration/lib/herdr.mjs — the ONLY place the orchestrator talks to Herdr.
//
// Herdr is the control plane (AGENTS.md §8, requirement 8). Everything the
// orchestrator does to the terminal — create a tab, split a pane, start an
// agent, deliver a prompt, read a screen — goes through here, so every terminal
// effect is one auditable call site instead of scattered `exec` strings.
//
// Two harnesses are allowed (OpenCode, Freebuff) and they do NOT take the same
// delivery path, which is a measured fact, not a preference:
//
//   opencode  — `herdr agent start <name> --kind opencode --pane <id>` works,
//               `herdr agent prompt` delivers, and a live session can have its
//               model switched over the opencode serve API (context preserved).
//   freebuff  — `herdr agent start --kind` has NO freebuff value, so a freebuff
//               pane is attached by running the binary in the pane; prompts must
//               be submitted with scripts/freebuff-dispatch.mjs because
//               Freebuff's focus hook swallows a plain CR from an unfocused pane.
//
// Session pinning: when HERDR_SESSION is set every call carries `--session`, the
// same convention engine/supervisor.mjs uses.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

const HERDR_CANDIDATES = [
  "/opt/homebrew/bin/herdr",
  "/usr/local/bin/herdr",
  path.join(process.env.HOME || "", ".local/bin/herdr"),
];

export function herdrBin() {
  return process.env.HERDR_BIN || HERDR_CANDIDATES.find((p) => p && fs.existsSync(p)) || "herdr";
}

/** `--session <name>` pins every call to one session when the operator sets it. */
export function sessionArgs() {
  return process.env.HERDR_SESSION ? ["--session", process.env.HERDR_SESSION] : [];
}

export function inHerdr() {
  return process.env.HERDR_ENV === "1";
}

/**
 * Run one herdr call and unwrap its envelope.
 * herdr replies `{ id, type, result: {...} }`; a call that fails to reach the
 * socket throws the underlying error rather than returning a fake empty result.
 */
export async function herdr(args, { timeout = 25_000 } = {}) {
  const { stdout } = await run(herdrBin(), [...sessionArgs(), ...args], { timeout, maxBuffer: 8 << 20 });
  const text = String(stdout).trim();
  if (!text.startsWith("{")) return { raw: text };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function listTabs(workspaceId) {
  const env = await herdr(["tab", "list"]);
  const tabs = env?.result?.tabs || [];
  return workspaceId ? tabs.filter((t) => t.workspace_id === workspaceId) : tabs;
}

export async function listWorkspaces() {
  const env = await herdr(["workspace", "list"]);
  return env?.result?.workspaces || [];
}

export async function listAgents() {
  const env = await herdr(["agent", "list"]);
  return env?.result?.agents || [];
}

/** The focused workspace's id — where the control plane and the project tabs are created. */
export async function currentWorkspaceId() {
  const workspaces = await listWorkspaces();
  const active = workspaces.find((w) => w.focused) || workspaces[0];
  return active?.workspace_id || null;
}

/**
 * The workspace's tabs by LABEL. Labels are how the topology names a tab
 * (`control-plane`, then one label per project = the project id); the tab ids
 * are dynamic, so nothing may pin one.
 */
export async function tabsByLabel(workspaceId) {
  const list = await listTabs(workspaceId);
  const map = new Map();
  for (const t of list) map.set(t.label || t.tab_id, t);
  return map;
}

/** Panes in one tab. A tab is the unit a role is placed into. */
export async function listPanesInTab(tabId) {
  const panes = await listPanes();
  return panes.filter((p) => p.tab_id === tabId);
}

export async function listPanes(workspaceId) {
  const env = await herdr(["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])]);
  return env?.result?.panes || [];
}

export async function createTab({ workspaceId, label, cwd, focus = false }) {
  const args = ["tab", "create"];
  if (workspaceId) args.push("--workspace", workspaceId);
  if (label) args.push("--label", label);
  if (cwd) args.push("--cwd", cwd);
  if (focus) args.push("--focus");
  const env = await herdr(args);
  return env?.result?.tab || env?.result || null;
}

export async function splitPane({ paneId, direction = "right", cwd, noFocus = true }) {
  const args = ["pane", "split", paneId, "--direction", direction];
  if (cwd) args.push("--cwd", cwd);
  if (noFocus) args.push("--no-focus");
  const env = await herdr(args);
  return env?.result?.pane?.pane_id || null;
}

export async function startAgent({ name, kind, paneId, argv = [], timeoutMs = 60_000 }) {
  const args = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs)];
  if (argv.length) args.push("--", ...argv);
  return herdr(args, { timeout: timeoutMs + 15_000 });
}

export async function renameAgent(target, name) {
  return herdr(["agent", "rename", target, name]);
}

export async function promptAgent({ target, message, wait = false, timeoutMs = 120_000 }) {
  const args = ["agent", "prompt", target, message];
  if (wait) args.push("--wait", "--timeout", String(timeoutMs));
  return herdr(args, { timeout: wait ? timeoutMs + 20_000 : 30_000 });
}

export async function paneRead(paneId, lines = 120) {
  const env = await herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
  return env?.result?.text || env?.raw || "";
}

export async function closePane(paneId) {
  return herdr(["pane", "close", paneId]);
}

/**
 * Deliver a prompt into a Freebuff pane. Freebuff swallows a plain CR from an
 * unfocused pane, so the repo's installed dispatcher reproduces what a focused
 * terminal does (focus-in -> ctrl+u -> bracketed paste -> CR). Reused verbatim.
 */
export async function dispatchFreebuff({ paneId, prompt, dryRun = false }) {
  const script = path.join(ROOT, "scripts", "freebuff-dispatch.mjs");
  if (!fs.existsSync(script)) throw new Error(`freebuff dispatcher missing: ${script}`);
  const env = { ...process.env };
  if (dryRun) env.FREEBUFF_DISPATCH_DRYRUN = "1";
  const { stdout } = await run(process.execPath, [script, paneId, "--", prompt], { timeout: 45_000, env, maxBuffer: 1 << 20 });
  return String(stdout).trim();
}

/** The opencode session API lives on the sentinel's serve port. */
export function opencodeBase() {
  return `http://127.0.0.1:${Number(process.env.SENTINEL_PORT || 4199)}`;
}

export async function opencodeServeUp() {
  try {
    const res = await fetch(`${opencodeBase()}/api/model`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Switch the model of a LIVE opencode session; context is preserved (204). */
export async function switchOpencodeSessionModel(sessionId, key) {
  const i = String(key).indexOf("/");
  if (i <= 0) throw new Error(`model key must be <provider>/<id>: ${key}`);
  const res = await fetch(`${opencodeBase()}/api/session/${encodeURIComponent(sessionId)}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: key.slice(0, i), id: key.slice(i + 1) } }),
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, ok: res.ok, body: await res.text().catch(() => "") };
}
