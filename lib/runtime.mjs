/**
 * exp-007-ace — lib/runtime.mjs
 *
 * Runtime state, context, events and lifecycle for the ACE package.
 * Zero dependencies. All state lives under <dir>/.ace/.
 *
 * Specification (what should exist) is separate from state (what does exist).
 * This module only ever touches state.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

const VALID_STATUS = ["created", "installed", "ready", "running", "paused", "stopped"];

const EMPTY_STATE = () => ({
  status: "unknown",
  active: null,
  agents: [],
  tasks: [],
  updatedAt: null,
});

function aceDir(dir) {
  return join(dir, ".ace");
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

/** Run git with a timeout; return stdout trimmed, or null on any failure. */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function gitVersion() {
  const out = git(["--version"], process.cwd());
  if (!out) return "2.x";
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? `${m[1]}.${m[2]}` : "2.x";
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

export function initState(dir) {
  const ace = aceDir(dir);
  for (const sub of ["agents", "tasks", "context", "snapshots"]) {
    mkdirSync(join(ace, sub), { recursive: true });
  }
  const state = {
    status: "created",
    active: null,
    agents: [],
    tasks: [],
    updatedAt: nowIso(),
  };
  writeJsonFile(join(ace, "state.json"), state);
}

export function getState(dir) {
  const state = readJsonFile(join(aceDir(dir), "state.json"));
  if (!state) return EMPTY_STATE();
  return {
    status: state.status ?? "unknown",
    active: state.active ?? null,
    agents: Array.isArray(state.agents) ? state.agents : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    updatedAt: state.updatedAt ?? null,
  };
}

export function setStatus(dir, status) {
  if (!VALID_STATUS.includes(status)) {
    throw new Error(
      `setStatus: invalid status "${status}" — must be one of ${VALID_STATUS.join("|")}`,
    );
  }
  const ace = aceDir(dir);
  const prev = readJsonFile(join(ace, "state.json")) ?? {};
  const state = {
    status,
    active: prev.active ?? null,
    agents: Array.isArray(prev.agents) ? prev.agents : [],
    tasks: Array.isArray(prev.tasks) ? prev.tasks : [],
    updatedAt: nowIso(),
  };
  writeJsonFile(join(ace, "state.json"), state);
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export function appendEvent(dir, ev) {
  if (!ev || typeof ev !== "object") {
    throw new Error("appendEvent: ev must be an object");
  }
  for (const k of ["id", "timestamp", "type", "actor"]) {
    if (typeof ev[k] !== "string" || ev[k].length === 0) {
      throw new Error(`appendEvent: ev.${k} must be a non-empty string`);
    }
  }
  const ace = aceDir(dir);
  mkdirSync(ace, { recursive: true });
  const line = JSON.stringify(ev) + "\n";
  appendFileSync(join(ace, "events.jsonl"), line, "utf8");
}

// ---------------------------------------------------------------------------
// agents / tasks
// ---------------------------------------------------------------------------

function readRecords(dir, sub, map) {
  const base = join(aceDir(dir), sub);
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base)) {
    if (!name.endsWith(".json")) continue;
    const rec = readJsonFile(join(base, name));
    if (!rec) continue;
    out.push(map(rec));
  }
  return out;
}

export function getAgents(dir) {
  return readRecords(dir, "agents", (r) => ({
    id: r.id ?? null,
    role: r.role ?? null,
    status: r.status ?? "idle",
    task: r.task ?? null,
    startedAt: r.startedAt ?? null,
    lastActivity: r.lastActivity ?? null,
  }));
}

export function getTasks(dir) {
  return readRecords(dir, "tasks", (r) => ({
    id: r.id ?? null,
    title: r.title ?? null,
    status: r.status ?? "pending",
    assignedTo: r.assignedTo ?? null,
    priority: r.priority ?? "normal",
    createdAt: r.createdAt ?? null,
  }));
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

export function getContext(dir) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir) ?? "";
  const commit = git(["rev-parse", "HEAD"], dir) ?? "";
  const pkg = readJsonFile(join(dir, "package.json"));
  const ace = pkg?.ace ?? {};
  return {
    host: { os: process.platform, arch: process.arch },
    runtime: { provider: "local" },
    project: { languages: [], frameworks: [] },
    git: { branch, commit },
    tools: Array.isArray(ace.tools) ? ace.tools : [],
    resources: { cpu: os.cpus().length, memory: os.totalmem() },
  };
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export function snapshot(dir) {
  const ace = aceDir(dir);
  const id = "snap_" + Date.now();
  const state = readJsonFile(join(ace, "state.json")) ?? EMPTY_STATE();
  let spec = null;
  const specPath = join(dir, "package.json");
  if (existsSync(specPath)) {
    try {
      spec = JSON.parse(readFileSync(specPath, "utf8"))?.ace ?? null;
    } catch {
      spec = null;
    }
  }
  const snap = {
    id,
    at: nowIso(),
    spec,
    state,
    git: {
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"], dir) ?? "",
      commit: git(["rev-parse", "HEAD"], dir) ?? "",
    },
  };
  mkdirSync(join(ace, "snapshots"), { recursive: true });
  writeJsonFile(join(ace, "snapshots", `${id}.json`), snap);
  return snap;
}

export function restore(dir, snapshotId) {
  const path = join(aceDir(dir), "snapshots", `${snapshotId}.json`);
  if (!existsSync(path)) {
    throw new Error(`restore: snapshot not found at ${path}`);
  }
  const snap = readJsonFile(path);
  if (!snap || !snap.state) {
    throw new Error(`restore: snapshot at ${path} has no state`);
  }
  const state = {
    ...snap.state,
    updatedAt: nowIso(),
  };
  writeJsonFile(join(aceDir(dir), "state.json"), state);
}

// ---------------------------------------------------------------------------
// phase 8 — advanced runtime
// ---------------------------------------------------------------------------

function readEvents(dir) {
  const p = join(aceDir(dir), "events.jsonl");
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function getPolicies(dir) {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return {};
  try {
    return readJsonFile(p)?.ace ?? {};
  } catch {
    return {};
  }
}

// --- recover ---
export function recover(dir) {
  const ace = aceDir(dir);
  mkdirSync(join(ace, "agents"), { recursive: true });
  mkdirSync(join(ace, "tasks"), { recursive: true });
  const events = readEvents(dir);
  const agents = [];
  const tasks = [];
  let active = null;
  for (const ev of events) {
    const md = ev.metadata ?? {};
    switch (ev.type) {
      case "agent.spawned": {
        const id = md.agent ?? md.id ?? ev.id;
        agents.push({ id, role: md.role ?? "worker", status: md.status ?? "idle", task: md.task ?? null, startedAt: ev.timestamp, lastActivity: ev.timestamp });
        break;
      }
      case "task.created": {
        const id = md.task ?? md.id ?? ev.id;
        tasks.push({ id, title: md.title ?? id, status: md.status ?? "pending", assignedTo: md.assignedTo ?? null, priority: md.priority ?? "normal", createdAt: ev.timestamp });
        break;
      }
      case "agent.task_assigned": {
        const a = agents.find((x) => x.id === md.agent);
        if (a) { a.task = md.task ?? null; a.lastActivity = ev.timestamp; }
        break;
      }
      case "agent.status_changed": case "agent.stopped": {
        const a = agents.find((x) => x.id === md.agent);
        if (a) { a.status = md.status ?? a.status; a.lastActivity = ev.timestamp; }
        break;
      }
      case "task.status_changed": case "task.completed": {
        const t = tasks.find((x) => x.id === md.task);
        if (t) { t.status = md.status ?? t.status; }
        break;
      }
      case "orchestrator.started": {
        active = { agent: ev.actor ?? "orchestrator", role: "orchestrator", status: "working", task: md.task ?? null, startedAt: ev.timestamp };
        break;
      }
    }
  }
  writeJsonFile(join(ace, "state.json"), { status: "recovering", active, agents, tasks, updatedAt: nowIso() });
  setStatus(dir, "ready");
  return getState(dir);
}

// --- trackResources ---
function getDiskUsage(dir) {
  try {
    const out = execFileSync("df", ["-k", "-P", dir], { timeout: 10000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const lines = out.trim().split("\n");
    if (lines.length < 2) return null;
    const cols = lines[1].trim().split(/\s+/);
    const availKb = Number(cols[3]);
    return Number.isFinite(availKb) ? availKb * 1024 : null;
  } catch { return null; }
}

export function trackResources(dir) {
  const ace = aceDir(dir);
  mkdirSync(join(ace, "context"), { recursive: true });
  const cur = process.cpuUsage();
  const prevPath = join(ace, "context", "resources.json");
  const prev = readJsonFile(prevPath);
  const delta = prev && prev.cpu ? { user: cur.user - (prev.cpu.user || 0), system: cur.system - (prev.cpu.system || 0) } : null;
  const rec = {
    cpu: { user: cur.user, system: cur.system, total: cur.user + cur.system, delta },
    memoryUsed: os.totalmem() - os.freemem(),
    memoryTotal: os.totalmem(),
    disk: getDiskUsage(dir),
    at: nowIso(),
  };
  writeJsonFile(prevPath, rec);
  return rec;
}

// --- enforcePolicies ---
export function enforcePolicies(dir, action) {
  if (!action || typeof action.type !== "string") return { allowed: false, reason: "invalid action" };
  const ws = getPolicies(dir);
  const fsMode = ws.filesystem?.mode ?? ws.filesystem?.scope;
  const netMode = ws.network?.mode;
  const gitPush = ws.git?.push;
  const prodAccess = ws.production?.access ?? ws.policies?.production_access;
  const mergeReview = ws.merge?.require_review ?? ws.policies?.require_review_before_merge;
  switch (action.type) {
    case "filesystem.write": {
      if (fsMode === "workspace") {
        const p = action.path;
        if (!p) return { allowed: false, reason: "filesystem.write requires a path" };
        const abs = resolve(dir, p);
        const root = resolve(dir);
        if (abs !== root && !abs.startsWith(root + sep)) return { allowed: false, reason: `filesystem.write outside workspace: ${p}` };
        return { allowed: true, reason: "within workspace scope" };
      }
      return { allowed: false, reason: "filesystem policy not declared (default deny)" };
    }
    case "network.connect": {
      if (netMode === "restricted") return { allowed: false, reason: "network.mode is restricted" };
      if (netMode) return { allowed: true, reason: `network.mode=${netMode}` };
      return { allowed: false, reason: "network policy not declared (default deny)" };
    }
    case "git.push": {
      if (gitPush === false) return { allowed: false, reason: "git.push is disabled" };
      if (gitPush === true) return { allowed: true, reason: "git.push enabled" };
      return { allowed: false, reason: "git.push policy not declared (default deny)" };
    }
    case "production.access": {
      if (prodAccess === false) return { allowed: false, reason: "production.access is disabled" };
      if (prodAccess === true) return { allowed: true, reason: "production.access enabled" };
      return { allowed: false, reason: "production.access policy not declared (default deny)" };
    }
    case "merge": {
      if (mergeReview === true) {
        if (action.reviewed === true) return { allowed: true, reason: "merge reviewed" };
        return { allowed: false, reason: "merge requires review" };
      }
      if (mergeReview === false) return { allowed: true, reason: "merge review not required" };
      return { allowed: false, reason: "merge policy not declared (default deny)" };
    }
    default:
      return { allowed: false, reason: `unknown action type: ${action.type}` };
  }
}

// --- spawnWorker ---
export function spawnWorker(dir, role) {
  if (!role || typeof role !== "string") throw new Error("spawnWorker: role must be a non-empty string");
  const ace = aceDir(dir);
  const agentsDir = join(ace, "agents");
  mkdirSync(agentsDir, { recursive: true });
  let max = 0;
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) {
      const m = new RegExp(`^${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.json$`).exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  const id = `${role}-${max + 1}`;
  const rec = { id, role, status: "idle", task: null, startedAt: nowIso(), lastActivity: nowIso() };
  writeJsonFile(join(agentsDir, `${id}.json`), rec);
  appendEvent(dir, { id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: nowIso(), type: "agent.spawned", actor: "orchestrator", metadata: { agent: id, role } });
  return id;
}

// --- healthcheck ---
export function healthcheck(dir) {
  const ws = getPolicies(dir);
  const hc = ws.lifecycle?.healthcheck;
  if (!hc) return { ok: true, detail: "no healthcheck defined" };
  let cmd;
  if (typeof hc === "string") cmd = hc;
  else if (typeof hc === "object" && typeof hc.command === "string") cmd = hc.command;
  else return { ok: false, detail: "healthcheck is not a command string" };
  try {
    const out = execFileSync("sh", ["-c", cmd], { timeout: 30000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: dir });
    return { ok: true, output: out.trim() };
  } catch (e) {
    return { ok: false, output: (e?.stdout || "") + (e?.stderr || e?.message || "") };
  }
}
