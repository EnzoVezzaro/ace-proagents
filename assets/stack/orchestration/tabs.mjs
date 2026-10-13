#!/usr/bin/env node
// orchestration/tabs.mjs — the 1 + N tab orchestrator.
//
// ALWAYS 1 + N TABS (data: orchestration/projects.json > topology):
//
//   control-plane   the governor + one supervisor per project. Not capped.
//   <project id>    one tab per project, holding that project's workers. Capped (global).
//
// The orchestrator owns exactly six things:
//   1. the tabs               (lib/topology.mjs — one control plane + one per project)
//   2. the worker cap         (lib/cap.mjs — a SETTING, read from run-control/env/config)
//   3. free-model assignment  (lib/free-models.mjs, engine/model-index.mjs)
//   4. mission delegation     (lib/handoff.mjs, the installed convention)
//   5. delivery               (lib/herdr.mjs — herdr or freebuff dispatch)
//   6. per-project state      (orchestration/state/<project>/, isolated by path)
//
// It does NOT decide what the projects should do; that is data in
// orchestration/projects.json. Add a project or a task there, not a branch here.
//
//   node orchestration/tabs.mjs plan
//   node orchestration/tabs.mjs up [--dry-run] [--project exp-005-autoarb]
//   node orchestration/tabs.mjs status
//   node orchestration/tabs.mjs cap                  # the effective worker cap and where it came from
//   node orchestration/tabs.mjs cap --set 6          # change it (writes run-control.json, logs it)
//   node orchestration/tabs.mjs govern [--dispatch]  # the governor's brief over every project
//   node orchestration/tabs.mjs brief  --project exp-005-autoarb --task t2-adapters
//   node orchestration/tabs.mjs dispatch --project exp-005-autoarb --task t2-adapters [--dry-run]
//   node orchestration/tabs.mjs verify [--project exp-005-autoarb]
//   node orchestration/tabs.mjs cycle [--dry-run]
//
// Exit codes: 0 ok · 2 refused (cap / no verified free model / no outcome line)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROOT,
  inHerdr,
  listAgents,
  listPanesInTab,
  currentWorkspaceId,
  tabsByLabel,
  createTab,
  splitPane,
  startAgent,
  promptAgent,
  renameAgent,
  dispatchFreebuff,
} from "./lib/herdr.mjs";
import { planAgainstLive, countActiveWorkers, countControlPlane, workerCap, setWorkerCap } from "./lib/cap.mjs";
import { CONTROL_TAB, tabs, tabForAgent, governor, controlPlaneAgents, workerAgents, placementInvariant, poolsOf } from "./lib/topology.mjs";
import { discover, select, failover, healthCheck, FreeModelUnavailable, globalStateDir, projectStateDir, readJson, writeJson, appendJsonl } from "./lib/free-models.mjs";
import { createMission, saveMission, loadMissions, missionsFile, validateArtifact, nextAfterFailure, applyTransition, artifactPath, rel, HANDOFF_MARKER, REQUIRED_FIELDS, STATES as HANDOFF_STATES } from "./lib/handoff.mjs";
import { browserBrief, spaceFor } from "./lib/ego.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, "projects.json");
const ASSIGNMENTS_FILE = path.join(globalStateDir(), "assignments.json");
const CAP_SETTINGS_LOG = path.join(globalStateDir(), "cap-settings.jsonl");

const iso = () => new Date().toISOString();

export function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

export function projectById(config, id) {
  const p = config.projects.find((x) => x.id === id);
  if (!p) throw new Error(`unknown project ${id} (known: ${config.projects.map((c) => c.id).join(", ")})`);
  return p;
}

// ---------- argv ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) out[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------- assignments ----------
function loadAssignments() {
  return readJson(ASSIGNMENTS_FILE, { updated_at: null, agents: {} });
}

function saveAssignments(state) {
  state.updated_at = iso();
  writeJson(ASSIGNMENTS_FILE, state);
  return state;
}

/**
 * The assignment map is a LOOKUP TABLE (which pane holds which agent, in which
 * tab), not an occupancy ledger: occupancy is counted from live Herdr state,
 * because a pane whose agent exited must free its slot immediately. A record for
 * an agent that is no longer running is stale and is dropped, so it can neither
 * block a spawn nor send a prompt to a dead pane.
 */
function pruneAssignments(state, agents) {
  const live = new Set((agents || []).map((a) => a.name));
  let pruned = 0;
  for (const key of Object.keys(state.agents)) {
    if (!live.has(state.agents[key].name)) {
      delete state.agents[key];
      pruned++;
    }
  }
  if (pruned) state.pruned_at = iso();
  return { state, pruned };
}

export function assignmentFor(projectId, name) {
  return loadAssignments().agents[`${projectId}:${name}`] || null;
}

// ---------- mission prompt ----------
/**
 * The delivered prompt. Self-contained on purpose: the receiving agent cannot
 * see this conversation, only the repo and this message (AGENTS.md §6).
 */
export function buildPrompt({ project, mission, model = null, agent = null, config = null }) {
  const owner = agent || (project?.agents || []).find((a) => a.name === mission.owner) || null;
  const role = owner?.role || mission.role || "worker";
  const tab = config ? tabForAgent(config, { ...owner, role }, project) : owner?.tab || project.id;
  const scope = owner?.owned_paths || mission.scope || project?.owned_paths || [];
  const lines = [];
  lines.push(`TASK ${mission.id} — ${mission.title}`);
  lines.push(`PROJECT ${project.id} (${project.title}). Space: ${spaceFor(project)} (its own tree, its own browser space).`);
  if (owner?.pool) lines.push(`POOL ${owner.pool} — its own scope is narrower than the project's:`);
  lines.push(`YOUR SCOPE (write only here): ${scope.join(", ") || "—"}`);
  lines.push(`FORBIDDEN: ${(project.forbidden_paths || []).join(", ")} — never read or write another project's tree, state directory or browser space.`);
  lines.push(`YOU WORK IN THE "${tab}" TAB — your project's own tab. Another project's agents sit in a different tab; the path budget above, not the tab, is the boundary that matters.`);
  if (model) lines.push(`MODEL ${model.key} (verified free: ${model.free_source}). If this model is unavailable or rate-limited, say so in your handoff instead of switching to a paid model.`);
  lines.push("");
  lines.push(mission.prompt.trim());
  lines.push("");
  lines.push("ACCEPTANCE CRITERIA (each must be true, with the evidence to prove it):");
  for (const a of mission.acceptance || []) lines.push(`  - ${a}`);
  lines.push("");
  lines.push(`OUTCOME: ${mission.outcome}`);
  lines.push("");
  lines.push("HANDOFF CONTRACT (the installed convention — charter/CREW-PROTOCOL.md rule 3):");
  lines.push(`  Write your handoff to ${rel(mission.handoff_path)} starting with these exact field values:`);
  lines.push(`  mission: ${mission.id}`);
  lines.push(`  project: ${project.id}`);
  lines.push(`  owner: ${mission.owner}`);
  lines.push(`  status: ${HANDOFF_STATES.join(" | ")}`);
  lines.push(`  (also required as headings: ${REQUIRED_FIELDS.filter((f) => !["mission", "project", "owner", "status"].includes(f)).join(", ")})`);
  lines.push("  Use these headings: Files changed / Commands run / Results / Failures / Evidence / Next.");
  lines.push("  'Evidence' must be real: a command and its output, a file path, or a measurement. A claim is not evidence.");
  lines.push(`  End the file with exactly: ${HANDOFF_MARKER} ${rel(mission.handoff_path)}`);
  lines.push(`  If you cannot finish, write the same file as ${rel(artifactPath(project, mission.id, "BLOCKED"))} and state the exact blocker.`);
  lines.push("");
  lines.push(browserBrief(project));
  lines.push("");
  lines.push("Definition of done: the handoff artifact exists, every acceptance line above is backed by evidence, and you report the outcome this round produced — or state plainly that it produced none.");
  return lines.join("\n");
}

/**
 * The work this project can still dispatch: a task that has no mission record, or
 * one whose mission can be retried, and that is not already closed outside the
 * delegated flow (`status: "done_by_coordinator"`, e.g. work the coordinator did
 * itself). Pure, so the queue rule is testable.
 */
export function pendingTasks(project, missions) {
  return (project.tasks || []).filter((t) => {
    if (t.status === "done_by_coordinator") return false;
    const m = missions[t.id];
    return !m || ["awaiting_handoff", "failed", "interrupted"].includes(m.state);
  });
}

export function briefPath(project, missionId) {
  return path.join(projectStateDir(project.id), "missions", `${missionId}.brief.md`);
}

function writeBrief({ project, mission, model, agent, config }) {
  const file = briefPath(project, mission.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${buildPrompt({ project, mission, model, agent, config })}\n`);
  return file;
}

// ---------- the two role tabs ----------
/**
 * The tabs the topology declares, with their live tab ids. A missing tab is
 * reported, not invented: `up` creates it, every read-only command just says so.
 */
export async function tabState(config) {
  const wanted = tabs(config);
  if (!wanted.violations.length) {
    try {
      const workspaceId = await currentWorkspaceId();
      const byLabel = await tabsByLabel(workspaceId);
      return {
        workspace_id: workspaceId,
        tabs: wanted.declared.map((t) => {
          const live = byLabel.get(t.label || t.id) || null;
          return { id: t.id, label: t.label || t.id, role: t.role, capped: Boolean(t.capped), holds_roles: t.holds_roles || [], tab_id: live?.tab_id || null, pane_count: live?.pane_count ?? null, exists: Boolean(live) };
        }),
        violations: [],
      };
    } catch (e) {
      return { workspace_id: null, tabs: wanted.declared.map((t) => ({ id: t.id, label: t.label || t.id, role: t.role, capped: Boolean(t.capped), holds_roles: t.holds_roles || [], tab_id: null, pane_count: null, exists: false })), violations: [], error: String(e.message || e).slice(0, 200) };
    }
  }
  return { workspace_id: null, tabs: [], violations: wanted.violations };
}

/** Wait until herdr reports an agent with this name attached. */
async function waitForAgent(name, { tries = 5, delayMs = 1200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const agents = await listAgents().catch(() => []);
    if (agents.some((a) => a.name === name)) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/** The first pane in a tab that holds no agent — the only pane that can take one. */
async function freePaneInTab(tabId, agents) {
  const panes = await listPanesInTab(tabId);
  const held = new Set((agents || []).map((a) => a.pane_id));
  return panes.find((p) => !held.has(p.pane_id))?.pane_id || null;
}

// ---------- commands ----------
async function cmdPlan(config, args) {
  const { current, plan, cap, control_plane } = await planAgainstLive({ config });
  const topo = await tabState(config);
  const out = { at: iso(), in_herdr: inHerdr(), topology: topo, cap, workers_active: current.total, control_plane, plan };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`topology: ${tabs(config).ids.join(" + ")}   tabs live: ${topo.tabs.filter((t) => t.exists).length}/${topo.tabs.length}`);
    console.log(`cap: ${plan.limit} active workers (source: ${cap.source}); workers occupied ${current.total}`);
    if (current.panes.length) for (const p of current.panes) console.log(`  occupied  ${p.name}  ${p.pane}  ${p.harness}  ${p.status}`);
    for (const k of plan.control_plane) console.log(`  control   ${k.name}  (${k.role}, tab ${k.tab})  ${k.project || "all projects"}`);
    for (const w of plan.workers) console.log(`  worker    ${w.name}  (${w.project}, pool ${w.pool}, tab ${w.tab})`);
    for (const t of plan.trimmed) console.log(`  trim      ${t.project}  ${t.name}  ${t.reason}`);
    console.log(`control plane live: ${control_plane.live.length}/${control_plane.declared.length}${control_plane.missing.length ? ` — missing ${control_plane.missing.join(", ")}` : ""}`);
  }
  return 0;
}

async function cmdUp(config, args) {
  if (!inHerdr()) {
    console.error("refused: not inside Herdr (HERDR_ENV != 1). Herdr is the control plane; never drive it from outside.");
    return 2;
  }
  const verdict = placementInvariant(config);
  if (!verdict.ok) {
    console.error(`refused: topology violation — ${verdict.violations.join("; ")}`);
    return 2;
  }

  const only = args.project ? projectById(config, args.project) : null;
  const { current, plan, cap } = await planAgainstLive({ config });
  const agents = await listAgents();
  const assignments = loadAssignments();
  pruneAssignments(assignments, agents);
  const started = [];
  const refused = [];

  if (current.total > plan.limit) {
    console.error(`refused: ${current.total} workers are already active and the cap is ${plan.limit}. Free a slot (or raise the cap: \`tabs.mjs cap --set N\`) instead of opening a duplicate project tab.`);
    return 2;
  }

  // A scoped `up --project <id>` initialises ONE project — its supervisor (in the
  // control plane) and its workers. The governor is never placed by a scoped run,
  // and no other project's agents are touched (isolation, enforced not requested).
  const controlToPlace = only ? controlPlaneAgents(config).filter((c) => c.project?.id === only.id) : controlPlaneAgents(config);
  const workerPlan = only ? plan.workers.filter((w) => w.project === only.id) : plan.workers;
  const trimmedPlan = only ? plan.trimmed.filter((t) => t.project === only.id) : plan.trimmed;

  for (const t of trimmedPlan) {
    refused.push({ ...t, at: iso() });
    // A dry run must not write state — the refusal log is part of the run.
    if (!args["dry-run"]) appendJsonl(path.join(projectStateDir(t.project), "cap.jsonl"), { at: iso(), kind: "refused_spawn", name: t.name, reason: t.reason });
  }

  // 1 + N tabs, created lazily by LABEL. Nothing here ever creates a duplicate control plane.
  const workspaceId = await currentWorkspaceId();
  const labelToId = new Map();

  const ensureTab = async (label) => {
    if (labelToId.get(label)) return labelToId.get(label);
    if (args["dry-run"]) return null;
    const tab = await createTab({ workspaceId, label, cwd: ROOT, focus: false });
    const id = tab?.tab_id || null;
    if (id) labelToId.set(label, id);
    return id;
  };

  // Materialise the whole 1 + N topology first: a declared tab exists even when
  // every agent that belongs to it is already running. An already-running worker
  // is excluded from the plan (no free slot for it), so nothing in the place()
  // loop below would create its project tab — the tab would silently never
  // appear. ensureTab is idempotent: a tab that already exists is returned as-is.
  const existing = await tabsByLabel(workspaceId);
  for (const t of tabs(config).declared) labelToId.set(t.label || t.id, existing.get(t.label || t.id)?.tab_id || null);
  for (const t of tabs(config).declared) await ensureTab(t.label || t.id);

  // Adopt every DECLARED agent that is already live into assignments, with the
  // tab it is actually in. `up` is the reconciliation point between the roster and
  // reality: an agent that `dispatch` must be able to prompt may have been moved
  // or started by hand, and a worker that is already running is excluded from the
  // plan — so nothing in the place() loop below would ever record its pane.
  const labelsByTab = new Map();
  for (const t of tabs(config).declared) {
    const id = labelToId.get(t.label || t.id);
    if (id) labelsByTab.set(id, t.label || t.id);
  }
  const adopt = (project, agent) => {
    const live = agents.find((a) => a.name === agent.name);
    if (!live) return;
    const pid = project ? project.id : "_governor";
    assignments.agents[`${pid}:${agent.name}`] = { project: pid, name: agent.name, pane: live.pane_id, tab: live.tab_id, tab_label: labelsByTab.get(live.tab_id) || tabForAgent(config, agent, project), harness: agent.harness || live.agent || null, role: agent.role, started_at: iso() };
  };
  if (!args["dry-run"]) {
    for (const { project, agent } of controlPlaneAgents(config)) adopt(project, agent);
    for (const { project, agent } of workerAgents(config)) adopt(project, agent);
    saveAssignments(assignments);
  }

  const place = async (project, agent, role) => {
    const projectId = project ? project.id : "_governor";
    const tabLabel = tabForAgent(config, agent, project);
    const agentsNow = await listAgents();
    const existing = agentsNow.find((a) => a.name === agent.name);
    if (existing) {
      started.push({ project: projectId, name: agent.name, pane: existing.pane_id, action: "already_running", tab: existing.tab_id });
      return;
    }
    // A dry run decides and reports; it never creates a tab, splits a pane or
    // starts an agent. Short-circuiting HERE (not after the pane work below) is
    // what makes that true.
    if (args["dry-run"]) {
      started.push({ project: projectId, name: agent.name, action: "would_start", harness: agent.harness, tab_label: tabLabel });
      return;
    }

    const tabId = await ensureTab(tabLabel);
    if (!tabId) {
      refused.push({ project: projectId, name: agent.name, reason: `herdr did not return a tab id for "${tabLabel}"` });
      appendJsonl(path.join(projectStateDir(projectId), "cap.jsonl"), { at: iso(), kind: "spawn_failed", name: agent.name, reason: `no tab id for ${tabLabel}` });
      return;
    }

    // A pane that already holds an agent rejects `agent start` with
    // agent_pane_busy, so take the first pane in the ROLE tab that holds none,
    // and only split when the tab has no free pane left.
    let paneId = await freePaneInTab(tabId, agentsNow);
    if (!paneId) {
      const panesInTab = await listPanesInTab(tabId);
      const last = panesInTab[panesInTab.length - 1];
      if (!last) {
        refused.push({ project: projectId, name: agent.name, reason: `no pane in tab "${tabLabel}" (${tabId})` });
        return;
      }
      paneId = await splitPane({ paneId: last.pane_id, cwd: ROOT });
      if (!paneId) {
        refused.push({ project: projectId, name: agent.name, reason: `herdr returned no pane id for the split in "${tabLabel}"` });
        return;
      }
    }

    if (agent.harness !== "opencode") {
      refused.push({ project: projectId, name: agent.name, reason: "freebuff has no `herdr agent start --kind` value — attach it by running the binary in the pane; the orchestrator will not fake it" });
      return;
    }
    try {
      await startAgent({ name: agent.name, kind: "opencode", paneId });
    } catch (e) {
      const msg = String(e.stderr || e.message || e).slice(0, 300);
      refused.push({ project: projectId, name: agent.name, pane: paneId, reason: `herdr agent start failed: ${msg}` });
      appendJsonl(path.join(projectStateDir(projectId), "cap.jsonl"), { at: iso(), kind: "spawn_failed", name: agent.name, pane: paneId, reason: msg });
      return;
    }
    await renameAgent(agent.name, agent.name).catch(() => {});

    // `agent start` returning is not the agent running: the harness can exit
    // before it takes the pane (a real case — one worker started, reported OK and
    // was gone by the next count). Verify the name is attached before recording
    // it as started, otherwise the roster lies for a whole cycle.
    const confirmed = await waitForAgent(agent.name, { tries: 5, delayMs: 1200 });
    if (!confirmed) {
      const reason = `agent start returned but ${agent.name} is not attached in pane ${paneId} — the harness exited before it took the pane`;
      refused.push({ project: projectId, name: agent.name, pane: paneId, reason });
      appendJsonl(path.join(projectStateDir(projectId), "cap.jsonl"), { at: iso(), kind: "spawn_failed", name: agent.name, pane: paneId, reason });
      return;
    }
    assignments.agents[`${projectId}:${agent.name}`] = { project: projectId, name: agent.name, pane: paneId, tab: tabId, tab_label: tabLabel, harness: agent.harness, role, started_at: iso() };
    saveAssignments(assignments);
    started.push({ project: projectId, name: agent.name, pane: paneId, tab: tabId, tab_label: tabLabel, role, action: "started" });
  };

  for (const { project, agent } of controlToPlace) await place(project, agent, agent.role);
  for (const w of workerPlan) {
    const project = projectById(config, w.project);
    const agent = (project.agents || []).find((a) => a.name === w.name);
    if (agent) await place(project, agent, "worker");
  }

  console.log(
    JSON.stringify({ at: iso(), topology: tabs(config).ids, project: only ? only.id : null, cap: { limit: plan.limit, source: cap.source }, workers_active_before: current.total, started, refused }, null, 2),
  );
  return 0;
}

async function cmdStatus(config) {
  const agents = await listAgents().catch(() => []);
  const cap = workerCap(config);
  const current = countActiveWorkers(agents, config);
  const control = countControlPlane(agents, config);
  const topo = await tabState(config);
  const placement = placementInvariant(config);
  const pool = await discover().catch((e) => ({ count: 0, error: e.message, models: [] }));
  const perProject = {};
  for (const project of config.projects) {
    const missions = loadMissions(project.id);
    const list = Object.values(missions);
    perProject[project.id] = {
      space: spaceFor(project),
      root: project.root,
      pools: poolsOf(project),
      supervisor: (project.agents || []).find((a) => a.role === "supervisor")?.name || null,
      agents_active: agents.filter((a) => String(a.name || "").startsWith(project.agent_prefix)).map((a) => ({ name: a.name, pane: a.pane_id, status: a.agent_status, tab: a.tab_id })),
      missions: list.map((m) => ({ id: m.id, state: m.state, owner: m.owner, attempts: m.attempts, retries: m.retries, handoff: rel(m.handoff_path) })),
      tasks_pending: pendingTasks(project, missions).map((t) => t.id),
      tasks_closed_outside_flow: (project.tasks || []).filter((t) => t.status === "done_by_coordinator").map((t) => t.id),
    };
  }
  const bench = { circuits_open: [] };
  for (const m of pool.models || []) if (m.circuit_until) bench.circuits_open.push({ key: m.key, until: m.circuit_until });
  console.log(
    JSON.stringify(
      {
        at: iso(),
        in_herdr: inHerdr(),
        topology: topo,
        placement,
        cap: { limit: cap.limit, source: cap.source, occupied: current.total, by_project: current.by_project, by_pool: current.by_pool, panes: current.panes, control_plane_live: control.live.map((c) => c.name), control_plane_missing: control.missing },
        free_models: { count: pool.count ?? 0, served_live: pool.served_live ?? false, cache_age_ms: pool.cache_age_ms ?? null },
        provider_circuits: bench,
        projects: perProject,
        recovery_due: failover.recoveryDue(),
      },
      null,
      2,
    ),
  );
  return 0;
}

async function cmdCap(config, args) {
  if (args.set === undefined) {
    const resolved = workerCap(config);
    const current = countActiveWorkers(await listAgents().catch(() => []), config);
    console.log(JSON.stringify({ at: iso(), cap: resolved.limit, source: resolved.source, occupied: current.total, free: Math.max(0, resolved.limit - current.total), declared_workers: workerAgents(config).length, change: "node orchestration/tabs.mjs cap --set <n>" }, null, 2));
    return 0;
  }
  const result = setWorkerCap(args.set, { config, logFile: CAP_SETTINGS_LOG });
  // Name the file that was ACTUALLY written: it is ORCHESTRATION_RUN_CONTROL when
  // the operator set one, so a hardcoded path here would be a lie about a file the
  // operator has to go and edit.
  console.log(JSON.stringify({ ...result, note: `written to ${path.relative(ROOT, result.file)} (the same operator file as pause/resume) and logged to orchestration/state/_global/cap-settings.jsonl` }, null, 2));
  return 0;
}

/**
 * The governor's brief: the only view that reads across every project. It is
 * built from state, not from prose — each supervisor's live agents, open
 * missions, queue, and whether its claims are backed.
 */
export async function buildGovernorBrief(config) {
  const agents = await listAgents().catch(() => []);
  const cap = workerCap(config);
  const current = countActiveWorkers(agents, config);
  const control = countControlPlane(agents, config);
  const projects = [];
  for (const project of config.projects) {
    // `loadMissions` returns the record keyed by mission id; `pendingTasks`
    // needs THAT (not Object.values) or every task looks undispatched and a
    // completed mission is re-offered forever.
    const byId = loadMissions(project.id);
    const missions = Object.values(byId);
    const supervisor = (project.agents || []).find((a) => a.role === "supervisor");
    const violations = missions.filter((m) => (m.last_transition?.kind || "").includes("isolation") || (m.last_transition?.kind || "").includes("unverified"));
    projects.push({
      id: project.id,
      space: spaceFor(project),
      supervisor: supervisor?.name || null,
      supervisor_live: agents.some((a) => a.name === supervisor?.name),
      outcome: project.outcome,
      workers: (project.agents || []).filter((a) => a.role === "worker").map((a) => ({ name: a.name, pool: a.pool || "default", live: agents.some((x) => x.name === a.name) })),
      missions: missions.map((m) => ({ id: m.id, state: m.state, owner: m.owner, status: m.handoff_status || null, attempts: m.attempts, retries: m.retries, last_action: m.last_transition?.action || null })),
      queue_pending: pendingTasks(project, byId).map((t) => ({ id: t.id, priority: t.priority, outcome: t.outcome })),
      unbacked_or_refused: violations.map((m) => ({ id: m.id, kind: m.last_transition?.kind, action: m.last_transition?.action })),
    });
  }
  return {
    at: iso(),
    governor: governor(config)?.agent?.name || null,
    governor_live: agents.some((a) => a.name === governor(config)?.agent?.name),
    cap: { limit: cap.limit, source: cap.source, occupied: current.total, free: Math.max(0, cap.limit - current.total) },
    control_plane_missing: control.missing,
    projects,
    empty_queues: projects.flatMap((p) => (p.queue_pending.length === 0 ? [p.id] : [])),
    unverified_claims: projects.flatMap((p) => p.unbacked_or_refused.map((v) => ({ project: p.id, ...v }))),
    next: "for every project with an empty queue, mint exactly one task with an outcome line (AGENTS.md standing rule); for every unverified claim, re-prompt the owner for evidence before accepting it",
  };
}

export function renderGovernorBrief(brief) {
  const lines = [];
  // Self-contained (AGENTS.md §6): the receiving agent cannot see the chat that
  // produced this, and its pane may hold an earlier session. Say who it is and
  // what scopes it, before any of the state.
  lines.push(`You are \`${brief.governor}\`, the governor of this workspace. Work ONLY from this brief and the repo. If this pane carries an earlier conversation, it is not your task: do not continue it.`);
  lines.push(`Your job: check each supervisor below, check that every claim is backed by evidence, arbitrate between the projects, and for every project whose queue is EMPTY mint exactly one task with an outcome line (AGENTS.md standing rule). Report what you did and what it changed — or state plainly that nothing changed. You rank and authorise; a supervisor dispatches to its own workers.`);
  lines.push("");
  lines.push(`GOVERNOR BRIEF — ${brief.at}`);
  lines.push(`cap: ${brief.cap.limit} workers (${brief.cap.source}); occupied ${brief.cap.occupied}; free ${brief.cap.free}`);
  if (brief.control_plane_missing.length) lines.push(`CONTROL PLANE INCOMPLETE: ${brief.control_plane_missing.join(", ")} — a supervisor that is not running cannot be reporting.`);
  for (const p of brief.projects) {
    lines.push("");
    lines.push(`PROJECT ${p.id} (space ${p.space})`);
    lines.push(`  supervisor ${p.supervisor}${p.supervisor_live ? " (live)" : " (NOT RUNNING)"}`);
    lines.push(`  outcome: ${p.outcome}`);
    lines.push(`  workers: ${p.workers.map((w) => `${w.name}${w.live ? "" : " (not running)"}[${w.pool}]`).join(", ") || "none"}`);
    lines.push(`  queue pending: ${p.queue_pending.map((t) => t.id).join(", ") || "EMPTY — mint one task with an outcome line"}`);
    for (const m of p.missions) lines.push(`  mission ${m.id}: ${m.state}${m.status ? `/${m.status}` : ""} owner ${m.owner} attempts ${m.attempts} retries ${m.retries}${m.last_action ? ` last ${m.last_action}` : ""}`);
    for (const v of p.unbacked_or_refused) lines.push(`  CLAIM NOT BACKED: ${v.id} (${v.kind} → ${v.action}) — re-prompt for evidence before accepting`);
  }
  lines.push("");
  lines.push(`NEXT: ${brief.next}`);
  return lines.join("\n");
}

async function cmdGovern(config, args) {
  const brief = await buildGovernorBrief(config);
  const rendered = renderGovernorBrief(brief);
  const file = path.join(globalStateDir(), "governor-brief.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rendered}\n`);
  console.log(rendered);
  if (args.dispatch) {
    const target = assignmentFor("_governor", brief.governor) || assignmentFor(null, brief.governor) || null;
    if (!brief.governor_live) {
      console.error(`refused: the governor (${brief.governor}) is not running — \`node orchestration/tabs.mjs up\` first.`);
      return 2;
    }
    await promptAgent({ target: target?.name || brief.governor, message: rendered });
    console.log(JSON.stringify({ at: iso(), dispatched_to: brief.governor, brief: rel(file) }, null, 2));
  }
  return 0;
}

async function cmdBrief(config, args) {
  const project = projectById(config, args.project);
  const task = (project.tasks || []).find((t) => t.id === args.task);
  if (!task) throw new Error(`unknown task ${args.task} in ${project.id}`);
  const owner = (project.agents || []).find((a) => a.role === "worker") || project.agents[0];
  const mission = createMission({ project, task, agent: owner });
  console.log(buildPrompt({ project, mission, agent: owner, config }));
  return 0;
}

async function cmdDispatch(config, args) {
  const project = projectById(config, args.project);
  const task = (project.tasks || []).find((t) => t.id === args.task);
  if (!task) throw new Error(`unknown task ${args.task} in ${project.id}`);
  if (!task.outcome) {
    console.error(`refused: task ${task.id} has no outcome line`);
    return 2;
  }
  const cap = workerCap(config);
  const agents = await listAgents();
  const current = countActiveWorkers(agents, config);
  if (current.total > cap.limit) {
    console.error(`refused: ${current.total} workers active, cap ${cap.limit}`);
    return 2;
  }

  const prior = loadMissions(project.id)[task.id];
  const owner = (project.agents || []).find((a) => a.role === "worker") || project.agents[0];
  const mission = prior && prior.state !== "complete" ? { ...prior, attempts: (prior.attempts || 1) + 1 } : createMission({ project, task, agent: owner });

  const exclude = mission.model ? [mission.model] : [];
  let model;
  try {
    model = await select({ exclude, failover });
  } catch (e) {
    if (e instanceof FreeModelUnavailable) {
      console.error(`refused: ${e.message} (${JSON.stringify(e.detail)})`);
      const t = nextAfterFailure(mission, { kind: "blocked_provider", detail: e.message }, { limits: config.harness.failover });
      applyTransition(mission, t);
      return 2;
    }
    throw e;
  }

  // A dry run decides and reports and writes NOTHING. Saving the mission here
  // would record it as dispatched with no dispatch — which also drops it out of
  // `pendingTasks`, wedging the task for the next cycle. Report what WOULD be
  // written instead.
  if (args["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          at: iso(),
          dry_run: true,
          mission: mission.id,
          project: project.id,
          would: mission.attempts > 1 && prior ? "re-run the open mission" : "create a new mission",
          model: model.key,
          model_free_source: model.free_source,
          tab: tabForAgent(config, owner, project),
          would_write: { mission: rel(missionsFile(project.id)), brief: rel(briefPath(project, mission.id)) },
          note: "nothing was written and no agent was prompted",
        },
        null,
        2,
      ),
    );
    return 0;
  }

  mission.model = model.key;
  mission.model_source = model.free_source;
  saveMission(mission);
  const briefFile = writeBrief({ project, mission, model, agent: owner, config });

  const assignments = loadAssignments();
  pruneAssignments(assignments, agents);
  saveAssignments(assignments);
  const target = assignmentFor(project.id, mission.owner) || assignmentFor(project.id, owner.name);
  if (!target) {
    console.error(`refused: no live pane is assigned to ${project.id}/${owner.name}. Run \`node orchestration/tabs.mjs up\` first (or start it by hand) — the orchestrator will not prompt a pane it did not place.`);
    return 2;
  }

  const text = buildPrompt({ project, mission, model, agent: owner, config });
  if (String(target.harness) === "freebuff") await dispatchFreebuff({ paneId: target.pane, prompt: text });
  else await promptAgent({ target: target.name, message: text });

  mission.state = "dispatched";
  mission.dispatched_at = iso();
  // The pane that received the mission is recorded so a handoff can be matched
  // to it later — the pane is evidence of who wrote the artifact.
  mission.pane = target.pane;
  saveMission(mission);
  appendJsonl(path.join(projectStateDir(project.id), "dispatch.jsonl"), { at: iso(), mission: mission.id, owner: mission.owner, pane: target.pane, tab: target.tab_label || target.tab, model: model.key, free_source: model.free_source });
  console.log(JSON.stringify({ at: iso(), dispatched: mission.id, to: target.name, pane: target.pane, model: model.key, handoff: rel(mission.handoff_path) }, null, 2));
  return 0;
}

async function cmdVerify(config, args) {
  const projects = args.project ? [projectById(config, args.project)] : config.projects;
  const results = [];
  // An agent that is still working is not a failed handoff. A mission that was
  // dispatched inside the grace window and has produced no artifact yet is
  // reported as pending and left alone — otherwise a healthy worker gets its
  // retry budget burned by the orchestrator's own polling.
  const graceMs = Number(args.grace ?? process.env.VERIFY_GRACE_MIN ?? 20) * 60_000;
  for (const project of projects) {
    const missions = loadMissions(project.id);
    for (const mission of Object.values(missions)) {
      if (["complete", "escalated"].includes(mission.state)) continue;
      const age = mission.dispatched_at ? Date.now() - new Date(mission.dispatched_at).getTime() : Infinity;
      if (!fs.existsSync(mission.handoff_path) && age < graceMs) {
        results.push({ project: project.id, mission: mission.id, verified: false, kind: "pending", state: mission.state, action: "wait", reasons: [`dispatched ${Math.round(age / 1000)}s ago, inside the ${Math.round(graceMs / 60_000)}min grace window`] });
        continue;
      }
      const verdict = validateArtifact({ project, mission });
      let transition = null;
      let state = mission.state;
      if (verdict.ok) {
        state = "complete";
        transition = { at: iso(), mission: mission.id, project: project.id, kind: "verified", action: "complete", state: "complete", status: verdict.status, detail: `artifact ${rel(mission.handoff_path)} accepted` };
        // The accept path is the one place the ledger row is written here, since
        // a verified mission does not go through applyTransition.
        appendJsonl(path.join(projectStateDir(project.id), "handoff-ledger.jsonl"), transition);
        saveMission({ ...mission, state: "complete", completed_at: iso(), handoff_status: verdict.status });
      } else {
        transition = nextAfterFailure(mission, { kind: verdict.kind, detail: verdict.reasons.join("; ") }, { limits: config.harness.failover });
        // applyTransition writes the ledger row itself — writing it again here
        // would double every failure row and corrupt the audit trail.
        const updated = applyTransition(mission, transition);
        state = updated.state;
      }
      results.push({ project: project.id, mission: mission.id, verified: verdict.ok, kind: verdict.kind, state, action: transition.action, reasons: verdict.reasons });
    }
  }
  console.log(JSON.stringify({ at: iso(), checked: results.length, results }, null, 2));
  return 0;
}

async function cmdCycle(config, args) {
  const recovered = await failover.tryRecover().catch(() => []);
  const health = [];
  if (args.probe) {
    const pool = await discover();
    for (const m of pool.models.slice(0, Number(args.probe) || 2)) health.push(await healthCheck(m.key));
  }
  const verifyCode = await cmdVerify(config, {});
  const pending = [];
  for (const project of config.projects) {
    const next = pendingTasks(project, loadMissions(project.id))[0];
    if (next) pending.push({ project: project.id, task: next.id, action: args["dry-run"] ? "would_dispatch" : "dispatch_next" });
  }
  console.log(JSON.stringify({ at: iso(), recovered, health, verify_exit: verifyCode, pending }, null, 2));
  return 0;
}

// ---------- main ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const config = loadConfig();
  switch (cmd) {
    case "plan":
      return cmdPlan(config, args);
    case "up":
      return cmdUp(config, args);
    case "status":
      return cmdStatus(config);
    case "cap":
      return cmdCap(config, args);
    case "govern":
      return cmdGovern(config, args);
    case "brief":
      return cmdBrief(config, args);
    case "dispatch":
      return cmdDispatch(config, args);
    case "verify":
      return cmdVerify(config, args);
    case "cycle":
      return cmdCycle(config, args);
    default:
      console.log("usage: node orchestration/tabs.mjs <plan|up|status|cap|govern|brief|dispatch|verify|cycle> [--project id] [--task id] [--set n] [--dispatch] [--dry-run]");
      return 1;
  }
}

// "Was I run, or was I imported?" A plain path comparison is not enough: an
// absolute path that goes through a symlink (macOS /tmp and /var/folders both
// are) resolves differently for the ESM loader than it does for argv, so
// `node /tmp/x/orchestration/tabs.mjs cap` would load, decide it had been
// imported, and exit 0 printing nothing. Compare real paths as well.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const from = process.argv[1];
  if (path.resolve(from) === path.resolve(self)) return true;
  try {
    return fs.realpathSync(from) === fs.realpathSync(self);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      console.error(`tabs: ${e.message}`);
      process.exit(1);
    });
}
