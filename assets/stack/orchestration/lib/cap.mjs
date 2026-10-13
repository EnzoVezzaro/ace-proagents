// orchestration/lib/cap.mjs — the worker cap, defined precisely, enforced, and
// adjustable from settings.
//
// THE RULE (mirrors orchestration/projects.json > cap, which is the source of
// truth; this file is the enforcement and the tests):
//
//   EVERY PROJECT TAB COMBINED holds at most `max_active_workers` active agents,
//   on every harness kind combined. The cap is global, not per project and not
//   per tab. The control plane — the governor and the project supervisors — is
//   NOT capped: it is the command surface, and a supervisor that cannot start
//   means the workers have nobody to report to.
//
// An "active worker" is a pane that (a) still has an agent attached in Herdr —
// working, blocked, done, or idle-at-prompt — and (b) whose name this file's
// config declares with role "worker". Idle-but-attached holds a slot; only the
// agent exiting or the pane closing frees it.
//
// COUNT BY CONFIG, NOT BY PREFIX. The old rule counted any name starting with a
// project prefix. That breaks now: a supervisor and its workers share the prefix
// (`exp-004-supervisor`, `exp-004-skills`), so prefix counting would drag the
// control plane into the worker cap and trim a supervisor to make room for a
// worker. lib/topology.mjs owns the role → tab map; this module asks it.
//
// THE CAP IS A SETTING (projects.json > cap.settings). Precedence, highest first:
//   1. the operator file > worker_cap              (live operator setting)
//   2. env ORCHESTRATION_WORKER_CAP
//   3. projects.json > cap.max_active_workers       (shipped default)
//   `node orchestration/tabs.mjs cap --set N` writes (1) and logs the change.
//
// SHIPPED WITH ACE, so the operator file is not assumed to live in a lab: it is
// `engine/state/run-control.json` relative to the repo root, and
// ORCHESTRATION_RUN_CONTROL relocates it. Whichever file answered is named in the
// returned source, because a cap that silently came from a path nobody can find
// is the same problem as a cap that came from an env var nobody can find.

import fs from "node:fs";
import path from "node:path";

import { listAgents, ROOT } from "./herdr.mjs";
import { CONTROL_TAB, agentIndex, controlPlaneAgents, workerAgents } from "./topology.mjs";

export const WORKER_LIMIT_DEFAULT = 4;

/**
 * Where the live operator setting lives — the same file as pause/resume by
 * default, relocatable with ORCHESTRATION_RUN_CONTROL when a repo keeps its
 * operator state somewhere else (or has no engine/ directory at all).
 */
export const RUN_CONTROL_FILE = process.env.ORCHESTRATION_RUN_CONTROL || path.join(ROOT, "engine", "state", "run-control.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * The effective worker cap and WHERE IT CAME FROM. Reporting the source is the
 * point: a cap that silently came from an env var is a cap nobody can find.
 */
export function workerCap(config, { env = process.env, runControlFile = RUN_CONTROL_FILE } = {}) {
  const fromControl = readJson(runControlFile, {})?.worker_cap;
  if (Number.isFinite(Number(fromControl)) && Number(fromControl) > 0) {
    // `file` is reported as well as the label: the path is the only thing that
    // tells an operator where to change the number back.
    return { limit: Number(fromControl), source: "run-control.json", value: Number(fromControl), file: path.resolve(runControlFile) };
  }
  const fromEnv = env.ORCHESTRATION_WORKER_CAP;
  if (Number.isFinite(Number(fromEnv)) && Number(fromEnv) > 0) {
    return { limit: Number(fromEnv), source: "env:ORCHESTRATION_WORKER_CAP", value: Number(fromEnv) };
  }
  const fromConfig = config?.cap?.max_active_workers;
  if (Number.isFinite(Number(fromConfig)) && Number(fromConfig) > 0) {
    return { limit: Number(fromConfig), source: "projects.json:cap.max_active_workers", value: Number(fromConfig) };
  }
  return { limit: WORKER_LIMIT_DEFAULT, source: "built-in default", value: WORKER_LIMIT_DEFAULT };
}

/**
 * Count active WORKERS from a live herdr agent list. Supervisors, the governor,
 * scheduler/daemon processes that are not agents, and other crews' panes are not
 * workers and are not counted — a pane the config does not declare is unknown,
 * not a worker this orchestrator placed.
 */
export function countActiveWorkers(agents, config) {
  const index = agentIndex(config);
  const mine = (agents || []).filter((a) => index.get(String(a?.name || ""))?.role === "worker");
  const byProject = {};
  const byPool = {};
  for (const project of config?.projects || []) byProject[project.id] = 0;
  for (const a of mine) {
    const row = index.get(String(a.name));
    if (!row.project) continue;
    byProject[row.project.id] = (byProject[row.project.id] || 0) + 1;
    const pool = row.agent.pool || "default";
    byPool[pool] = (byPool[pool] || 0) + 1;
  }
  return {
    total: mine.length,
    by_project: byProject,
    by_pool: byPool,
    panes: mine.map((a) => ({ name: a.name, pane: a.pane_id, harness: a.agent, status: a.agent_status, project: index.get(String(a.name))?.project?.id || null })),
  };
}

/** Live control-plane occupancy, for status and for the placement report. */
export function countControlPlane(agents, config) {
  const index = agentIndex(config);
  const declared = controlPlaneAgents(config).map((c) => c.agent.name);
  const live = (agents || []).filter((a) => index.get(String(a?.name || ""))?.role && index.get(String(a.name)).role !== "worker");
  return {
    declared,
    live: live.map((a) => ({ name: a.name, pane: a.pane_id, role: index.get(String(a.name)).role, tab: a.tab_id, status: a.agent_status })),
    missing: declared.filter((n) => !live.some((a) => a.name === n)),
  };
}

/**
 * Decide the roster that fits. Pure: same inputs, same answer.
 *
 * Order of allocation:
 *   1. the whole control plane — the governor, then one supervisor per project.
 *      Uncapped, because it is not a work queue. A control agent that is already
 *      attached does not need a second slot and is not planned again.
 *   2. then, while worker slots remain: the project with the FEWEST workers
 *      allocated so far, then that project's highest-priority remaining worker
 *      (priority ascending). Ties break by config order, so the outcome is
 *      deterministic and one project can never starve the other.
 *
 * Everything not allocated is returned as `trimmed` with a reason. The
 * orchestrator records the refusal and keeps going; it never closes another
 * agent's pane to fit and never opens a duplicate project tab.
 */
export function planRoster(config, { limit = WORKER_LIMIT_DEFAULT, active = 0, activeNames = [] } = {}) {
  const slots = Math.max(0, limit - active);
  const alreadyRunning = new Set(activeNames);
  const controlPlane = [];
  const workers = [];
  const trimmed = [];

  for (const { project, agent } of controlPlaneAgents(config)) {
    if (alreadyRunning.has(agent.name)) continue;
    controlPlane.push({
      project: project ? project.id : null,
      name: agent.name,
      role: agent.role,
      harness: agent.harness,
      tab: agent.tab || CONTROL_TAB,
      priority: agent.priority,
    });
  }

  const pending = workerAgents(config)
    .filter(({ agent }) => !alreadyRunning.has(agent.name))
    .map(({ project, agent }) => ({ project, agent }));

  const countFor = (pid) => workers.filter((w) => w.project === pid).length;
  while (workers.length < slots && pending.length) {
    let best = 0;
    for (let i = 1; i < pending.length; i++) {
      const a = pending[i];
      const b = pending[best];
      const ca = countFor(a.project.id);
      const cb = countFor(b.project.id);
      if (ca < cb || (ca === cb && (a.agent.priority ?? 99) < (b.agent.priority ?? 99))) best = i;
    }
    const pick = pending.splice(best, 1)[0];
    workers.push({
      project: pick.project.id,
      name: pick.agent.name,
      role: "worker",
      harness: pick.agent.harness,
      tab: pick.project.id,
      pool: pick.agent.pool || "default",
      priority: pick.agent.priority,
    });
  }
  for (const p of pending) {
    trimmed.push({
      project: p.project.id,
      name: p.agent.name,
      role: "worker",
      pool: p.agent.pool || "default",
      reason: `no worker slot: ${active} active worker(s) against a cap of ${limit}`,
    });
  }

  // The governor (project null) sorts first, then projects in name order, then
  // priority — so the plan is readable and byte-identical for equal inputs.
  const bySort = (a, b) => String(a.project ?? "").localeCompare(String(b.project ?? "")) || (a.priority ?? 99) - (b.priority ?? 99);
  return {
    limit,
    active,
    slots,
    control_plane: controlPlane.sort(bySort),
    workers: workers.sort(bySort),
    keep: [...controlPlane, ...workers].sort(bySort),
    trimmed: trimmed.sort(bySort),
    within_limit: workers.length + active <= limit,
  };
}

/** Live plan: reads herdr, then plans against the real occupancy. */
export async function planAgainstLive({ config, limit = null } = {}) {
  const agents = await listAgents();
  const resolved = limit == null ? workerCap(config) : { limit, source: "argument" };
  const current = countActiveWorkers(agents, config);
  const plan = planRoster(config, { limit: resolved.limit, active: current.total, activeNames: (agents || []).map((a) => a.name) });
  return { current, plan, cap: resolved, control_plane: countControlPlane(agents, config) };
}

/**
 * Change the live worker cap. Writes the operator file (engine/state/
 * run-control.json relative to the repo root, or ORCHESTRATION_RUN_CONTROL when
 * the operator has relocated it — the same file that carries pause/resume) and
 * appends the change to the given log, so a cap change is never silent. Returns
 * the before/after so the caller can print it, including which file it wrote.
 */
export function setWorkerCap(next, { config, runControlFile = RUN_CONTROL_FILE, logFile = null } = {}) {
  const value = Number(next);
  if (!Number.isFinite(value) || value < 0) throw new Error(`worker cap must be a number >= 0, got ${JSON.stringify(next)}`);
  const before = workerCap(config, { runControlFile });
  const current = readJson(runControlFile, {});
  const updated = { ...current, worker_cap: value, worker_cap_set_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(runControlFile), { recursive: true });
  const tmp = `${runControlFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`);
  fs.renameSync(tmp, runControlFile);
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), from: before.value, from_source: before.source, to: value })}\n`);
  }
  return { at: new Date().toISOString(), file: runControlFile, before: before.value, before_source: before.source, limit: value };
}
