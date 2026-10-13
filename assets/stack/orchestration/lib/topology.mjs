// orchestration/lib/topology.mjs — the role-tab contract (v3: 1 + N tabs).
//
// THE SHAPE (data: orchestration/projects.json > topology — this file is the
// enforcement, that file is the source of truth):
//
//   tab "control-plane"    the command surface: the governor + one supervisor per project
//   tab "<project.id>"     that project's workers — one tab per project
//
// There is ALWAYS EXACTLY ONE control plane and ONE TAB PER PROJECT, so the
// number of tabs is 1 + (number of projects). The project tabs are DERIVED from
// `projects` — adding a project adds exactly one tab by data, never by editing a
// static tab list here or in projects.json.
//
// A TAB IS A SURFACE, A PROJECT IS A SPACE. They are not the same thing:
//
//   - a project owns its own tab (id = label = project.id) AND its own browser
//     space (lib/ego.mjs), and both carry the same name as the project's tree
//     (basename of its root). project.id === browser_space === basename(root)
//     === its tab id.
//   - a tab carries a ROLE, so the control plane holds the governor and the
//     supervisors and every other tab holds workers.
//
// WHO OVERSEES WHAT:
//
//   governor     (control-plane)  reads across every project: it checks the
//                                 supervisors, checks that a worker's claim is
//                                 backed by evidence, arbitrates, and ranks the
//                                 next dollar across the portfolio.
//   supervisor   (control-plane)  owns ONE project's queue, missions, handoffs
//                                 and recovery. It never dispatches into, reads
//                                 or recovers another project.
//   worker       (a project tab)  does the work in its own project's tree, in
//                                 its own browser space, and writes a handoff.
//
// DO NOT CONFUSE the two levels of "governor" in this repo. engine/governor.mjs
// is the PAW Economic Governor — an in-process POLICY module that ranks the
// engine's own task queue (consulted by engine/supervisor.mjs every cycle). The
// `governor` AGENT named here is a coding agent in the control-plane tab that
// oversees the project supervisors. Neither replaces the other, and the agent
// does not execute engine policy.

/** The single control-plane tab id. A project may never take this id. */
export const CONTROL_TAB = "control-plane";

/** The roles that live in the control plane. */
export const CONTROL_ROLES = ["governor", "supervisor", "orchestrator"];

/** The one role that lives in a project tab. */
export const WORKER_ROLE = "worker";

/** Role → tab, when a project's own data does not say otherwise. A worker's
 *  tab is its project's tab, so its default is null (it needs the project). */
export const DEFAULT_ROLE_TABS = {
  governor: CONTROL_TAB,
  supervisor: CONTROL_TAB,
  orchestrator: CONTROL_TAB,
  worker: null,
};

/** The two role families, for callers that only need to know which side of the wall a role is on. */
export function isControlRole(role) {
  return CONTROL_ROLES.includes(String(role || ""));
}

export function isWorkerRole(role) {
  return String(role || "") === WORKER_ROLE;
}

/** The control-plane tab, from config. */
export function controlTab(config) {
  const t = config?.topology?.control_plane_tab || {};
  return {
    id: t.id || CONTROL_TAB,
    label: t.label || t.id || CONTROL_TAB,
    role: t.role || "control",
    cwd: t.cwd || ".",
    holds_roles: t.holds_roles || CONTROL_ROLES.slice(),
    capped: false,
    project: null,
  };
}

/** A project's own tab, derived from the project (id = label = project.id). */
export function projectTab(config, project) {
  const tpl = config?.topology?.project_tab_template || {};
  return {
    id: project.id,
    label: project.id,
    role: tpl.role || "work",
    cwd: project.cwd || tpl.cwd || ".",
    holds_roles: tpl.holds_roles || [WORKER_ROLE],
    capped: tpl.capped !== false,
    project: project.id,
  };
}

/** The declared tabs, derived: [control-plane, ...one per project], with the
 *  structural rule checked (no duplicate ids/labels, every tab holds something). */
export function tabs(config) {
  const declared = [controlTab(config), ...(config?.projects || []).map((p) => projectTab(config, p))];
  const ids = declared.map((t) => t.id);
  const labels = declared.map((t) => t.label || t.id);
  const violations = [];

  const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupIds.length) violations.push(`duplicate tab id(s): ${dupIds.join(", ")} — a project id collides with another tab`);
  const dupLabels = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))];
  if (dupLabels.length) violations.push(`duplicate tab label(s): ${dupLabels.join(", ")}`);
  for (const t of declared) {
    if (!(t.holds_roles || []).length) violations.push(`tab "${t.id}" declares no holds_roles`);
  }

  return { declared, ids, labels, violations };
}

/** The merged role → tab map (config wins, the defaults fill the gaps). */
export function roleToTab(config) {
  const out = { ...DEFAULT_ROLE_TABS };
  for (const [role, tab] of Object.entries(config?.topology?.role_to_tab || {})) out[role] = tab;
  return out;
}

function roleToTabOf(config, role) {
  const key = String(role || "");
  return config?.topology?.role_to_tab?.[key] ?? DEFAULT_ROLE_TABS[key] ?? null;
}

/** The tab a role belongs in, from the shipped defaults alone. A worker's tab is
 *  its project's tab, so it needs the project: pass it as the second argument. */
export function tabForRole(role, project = null) {
  if (isWorkerRole(role)) return project ? project.id : null;
  return roleToTabOf({}, role);
}

/** Which tab an agent belongs in. A worker's tab is its project's tab (id =
 *  project.id); a control agent's tab is its own declaration or its role's. */
export function tabForAgent(config, agent, project = null) {
  const role = String(agent?.role || "");
  if (isWorkerRole(role)) {
    if (project?.id) return project.id;
    if (agent?.tab) return agent.tab;
    throw new Error(`worker ${agent?.name || "?"} has no project — a worker's tab is its project's tab`);
  }
  const tab = agent?.tab || roleToTabOf(config, role);
  if (!tab) throw new Error(`agent ${agent?.name || "?"} has role "${role || "?"}" which maps to no tab`);
  return tab;
}

/** The governor entry, shaped like a project agent but with no project. */
export function governor(config) {
  const g = config?.topology?.governor || null;
  if (!g) return null;
  return { project: null, agent: { role: "governor", ...g, tab: g.tab || controlTab(config).id } };
}

/** Every control-plane agent: the governor, then one supervisor per project, in config order. */
export function controlPlaneAgents(config) {
  const out = [];
  const g = governor(config);
  if (g) out.push(g);
  for (const project of config?.projects || []) {
    for (const agent of project.agents || []) {
      if (isControlRole(agent.role)) out.push({ project, agent });
    }
  }
  return out;
}

/** Every worker agent, across every project and pool, in config order. */
export function workerAgents(config) {
  const out = [];
  for (const project of config?.projects || []) {
    for (const agent of project.agents || []) {
      if (isWorkerRole(agent.role)) out.push({ project, agent });
    }
  }
  return out;
}

/** Distinct pool names for a project, in declaration order. */
export function poolsOf(project) {
  const seen = [];
  for (const agent of project?.agents || []) {
    const pool = agent.pool || "default";
    if (!seen.includes(pool)) seen.push(pool);
  }
  return seen;
}

/**
 * name → { project, agent, role, tab }. One lookup, so a live pane can be
 * classified by the config instead of by its name's prefix: a supervisor now
 * shares its project's prefix (`exp-004-supervisor`), so counting by prefix
 * would put the control plane inside the workers cap. A worker's tab is its
 * project's tab.
 */
export function agentIndex(config) {
  const map = new Map();
  const g = governor(config);
  if (g) map.set(g.agent.name, { project: null, agent: g.agent, role: "governor", tab: controlTab(config).id });
  for (const project of config?.projects || []) {
    for (const agent of project.agents || []) {
      map.set(agent.name, { project, agent, role: agent.role, tab: tabForAgent(config, agent, project) });
    }
  }
  return map;
}

/**
 * The placement rule, checkable: every declared agent resolves to a tab, that
 * tab is one of the declared tabs, and its role is allowed to be there. A worker
 * that declares a tab other than its own project's is a violation. Returns the
 * violations instead of throwing, so a caller can report them.
 */
export function placementInvariant(config) {
  const t = tabs(config);
  const violations = [...t.violations];
  const allowed = new Map(t.declared.map((tab) => [tab.id, tab.holds_roles || []]));
  const seen = new Set();

  const check = (label, role, agent, project = null) => {
    const name = agent?.name || "(unnamed)";
    if (seen.has(name)) violations.push(`${label} declares duplicate agent name "${name}"`);
    seen.add(name);
    let tab;
    try {
      tab = tabForAgent(config, { ...agent, role }, project);
    } catch (e) {
      violations.push(`${label} ${name}: ${e.message}`);
      return;
    }
    if (!t.ids.includes(tab)) {
      violations.push(`${label} ${name}: tab "${tab}" is not one of the declared tabs (${t.ids.join(", ")})`);
      return;
    }
    const holds = allowed.get(tab) || [];
    if (!holds.includes(role)) violations.push(`${label} ${name}: role "${role}" is not allowed in tab "${tab}" (allows: ${holds.join(", ") || "nothing"})`);
  };

  const g = governor(config);
  if (!g) violations.push("topology declares no governor — nobody oversees the supervisors");
  else check("governor", "governor", g.agent);

  for (const project of config?.projects || []) {
    const supervisors = (project.agents || []).filter((a) => isControlRole(a.role));
    if (supervisors.length !== 1) violations.push(`${project.id} declares ${supervisors.length} supervisors; the contract is exactly 1`);
    for (const agent of project.agents || []) {
      if (isWorkerRole(agent.role) && agent.tab && agent.tab !== project.id) {
        violations.push(`worker ${agent.name} declares tab "${agent.tab}" but its project tab is "${project.id}" — a worker lives in its project's tab`);
      }
      check(project.id, agent.role, agent, project);
    }
  }

  return { ok: violations.length === 0, plan: t.ids, violations };
}

/** Same check, but a violation stops the caller (used before creating tabs). */
export function assertPlacement(config) {
  const verdict = placementInvariant(config);
  if (!verdict.ok) throw new Error(`topology violation: ${verdict.violations.join("; ")}`);
  return verdict;
}
