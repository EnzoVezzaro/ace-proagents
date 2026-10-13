// orchestration/lib/handoff.mjs — the installed handoff framework, reused.
//
// THE FRAMEWORK THAT EXISTS (do not replace it, do not build a parallel one):
// proagents/knowledge/CREW-PROTOCOL.md rule 3 — "Every mission ends with a
// <MISSION>-DONE.md handoff (commands run, trimmed outputs, failures)", the
// supervisor dispatches a self-contained prompt, and every worker reply ends
// with a `HANDOFF: <path>` marker. That convention, plus the mission prompt as
// the delegation contract, is the whole framework. This module gives it an API
// and a lifecycle instead of leaving it to prose.
//
// WHAT THIS ADDS — nothing about ownership or delivery (the herdr/supervisor
// path owns that), only:
//   - a mission record: ownership, scope, expected outputs, acceptance criteria,
//     money line, dispatch time, handoff destination (the delegation contract);
//   - artifact PARSING and VALIDATION, so "done" is a checked fact and not a claim;
//   - the explicit failure behavior from projects.json > handoff.failure_behavior.
//
// PROJECT ISOLATION is enforced by path: a mission's artifact must live in that
// project's own handoff directory. An artifact written anywhere else — or a
// handoff for tab1 found in tab2's state — is an isolation violation and does
// not close anything. Cross-project handoffs are prohibited.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

/** Runtime state root. Overridable so a test run cannot touch live state. */
export function stateRoot() {
  return process.env.ORCHESTRATION_STATE_DIR || path.join(ROOT, "orchestration", "state");
}

export const HANDOFF_MARKER = "HANDOFF:";
export const STATES = ["DONE", "BLOCKED", "FAILED", "RETRY", "ESCALATED"];

/** Required sections/bullets of an accepted artifact. */
export const REQUIRED_FIELDS = ["mission", "project", "owner", "status", "files_changed", "commands_run", "results", "failures", "evidence", "next"];

/** A DONE artifact with no evidence cannot close a mission. */
export function defaultLimits() {
  return { retryLimit: 2, reassignLimit: 2, staleGraceMs: 0 };
}

const now = () => Date.now();
const iso = () => new Date().toISOString();

export function projectDir(projectId) {
  return path.join(stateRoot(), projectId);
}

export function handoffDir(projectId) {
  return path.join(projectDir(projectId), "handoffs");
}

export function missionsFile(projectId) {
  return path.join(projectDir(projectId), "missions.json");
}

export function ledgerFile(projectId) {
  return path.join(projectDir(projectId), "handoff-ledger.jsonl");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function ledger(projectId, row) {
  const file = ledgerFile(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: iso(), ...row })}\n`);
}

/** The delegation contract. A task without a money line is refused. */
export function createMission({ project, task, agent, dispatchedAt = iso() }) {
  if (!task?.money || !String(task.money).trim()) {
    throw new Error(`task ${task?.id || "?"} has no money line — the orchestrator refuses to dispatch it`);
  }
  const id = `${task.id}`;
  return {
    id,
    project: project.id,
    title: task.title,
    money: task.money,
    owner: agent?.name || null,
    role: agent?.role || "worker",
    harness: agent?.harness || project.agents?.[0]?.harness || "opencode",
    // The agent's own scope when it declares one (a pro agent owns a proagents
    // subtree, not the whole experiment), else its project's.
    scope: agent?.owned_paths || project.owned_paths || [],
    forbidden: project.forbidden_paths || [],
    expected_outputs: task.acceptance || [],
    acceptance: task.acceptance || [],
    prompt: task.prompt,
    dispatched_at: dispatchedAt,
    attempts: 1,
    retries: 0,
    state: "dispatched",
    handoff_path: path.join(handoffDir(project.id), `${id}-DONE.md`),
  };
}

/** The artifact path a given mission+state must be written to, repo-relative. */
export function artifactPath(project, missionId, state = "DONE") {
  if (!STATES.includes(state)) throw new Error(`unknown handoff state ${state}`);
  return path.join(handoffDir(project.id), `${missionId}-${state}.md`);
}

export function rel(p) {
  return path.relative(ROOT, p);
}

/** Persist the mission record (the durable "what was delegated to whom"). */
export function saveMission(mission) {
  const file = missionsFile(mission.project);
  const all = readJson(file, {});
  all[mission.id] = { ...all[mission.id], ...mission };
  writeJson(file, all);
  return all[mission.id];
}

export function loadMissions(projectId) {
  return readJson(missionsFile(projectId), {});
}

/**
 * Parse an artifact written to the installed convention.
 * Returns the bullet fields, the sections present, and the `HANDOFF:` marker path.
 */
export function parseArtifact(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/);
  const fields = {};
  for (const line of lines) {
    const m = line.match(/^\s*[-*]?\s*([A-Za-z_ ]+):\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    if (REQUIRED_FIELDS.includes(key) && !fields[key]) fields[key] = m[2].trim();
  }
  const sections = {};
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.+?)\s*$/);
    if (!h) continue;
    const key = h[1].trim().toLowerCase().replace(/\s+/g, "_");
    sections[key] = true;
  }
  const markerLine = [...lines].reverse().find((l) => l.trim().startsWith(HANDOFF_MARKER));
  const marker = markerLine ? markerLine.trim().slice(HANDOFF_MARKER.length).trim() : null;
  const missing = REQUIRED_FIELDS.filter((f) => {
    if (f === "files_changed" || f === "commands_run" || f === "results" || f === "failures" || f === "evidence" || f === "next") {
      return !(sections[f] || fields[f]);
    }
    return !fields[f];
  });
  return { fields, sections, marker, present: Object.keys(fields), missing, ok: missing.length === 0 };
}

/** The text under a `## Heading`, used to read the Evidence section alone. */
export function sectionText(text, name) {
  const key = String(name).toLowerCase().replace(/\s+/g, "_");
  const out = [];
  let capturing = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const h = line.match(/^#{1,4}\s+(.+?)\s*$/);
    if (h) {
      capturing = h[1].trim().toLowerCase().replace(/\s+/g, "_") === key;
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Validate an artifact as evidence for THIS mission run.
 * Every failure carries a machine-readable kind so the caller can apply the
 * failure behavior instead of guessing.
 */
export function validateArtifact({ project, mission, text = null, artifactFile = null }) {
  const file = artifactFile || mission.handoff_path;
  const reasons = [];
  let content = text;

  if (content == null) {
    if (!fs.existsSync(file)) return { ok: false, kind: "missing", reasons: [`no handoff artifact at ${rel(file)}`] };
    content = fs.readFileSync(file, "utf8");
  }

  const inProject = path.resolve(file).startsWith(path.resolve(handoffDir(project.id)) + path.sep);
  if (!inProject) {
    return { ok: false, kind: "isolation_violation", reasons: [`artifact ${rel(file)} is outside ${rel(handoffDir(project.id))} — cross-project handoffs are prohibited`] };
  }

  const parsed = parseArtifact(content);
  if (!parsed.ok) reasons.push(`missing required field(s): ${parsed.missing.join(", ")}`);

  // Fields are matched tolerantly, because a real agent writes
  // `mission: t2-normalize — <the title>` or `owner: opencode (pane w5:p15)`
  // and a strict equality check rejects a correct handoff over punctuation.
  // The value must still name the expected mission/project, and for the owner it
  // may name the pane that wrote the artifact instead of the agent's name — the
  // pane is stronger evidence than a self-declared name.
  const names = (value, ...needles) => needles.filter(Boolean).some((n) => String(value || "").includes(n));
  if (parsed.fields.project && !names(parsed.fields.project, project.id)) reasons.push(`artifact claims project ${parsed.fields.project}, not ${project.id}`);
  if (parsed.fields.mission && !names(parsed.fields.mission, mission.id)) reasons.push(`artifact claims mission ${parsed.fields.mission}, not ${mission.id}`);
  if (parsed.fields.owner && !names(parsed.fields.owner, mission.owner, mission.pane)) reasons.push(`artifact owner ${parsed.fields.owner} is neither the assigned owner ${mission.owner} nor its pane ${mission.pane || "(unrecorded)"}`);
  if (!parsed.marker) reasons.push(`missing ${HANDOFF_MARKER} marker`);
  else if (path.resolve(ROOT, parsed.marker) !== path.resolve(file)) reasons.push(`${HANDOFF_MARKER} points at ${parsed.marker}, not at this artifact`);

  const status = (parsed.fields.status || "").toUpperCase();
  if (status && !STATES.includes(status)) reasons.push(`status ${status} is not one of ${STATES.join("|")}`);

  const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  const dispatched = mission.dispatched_at ? new Date(mission.dispatched_at).getTime() : 0;
  if (mtime && dispatched && mtime + 1000 < dispatched) reasons.push(`stale artifact: written ${new Date(mtime).toISOString()} before dispatch ${mission.dispatched_at}`);

  if (reasons.length) {
    const kind = reasons.some((r) => r.startsWith("stale")) ? "stale" : "incomplete";
    return { ok: false, kind, reasons, parsed, status };
  }

  // A completion claim needs evidence; otherwise it is 'unverified', not done.
  // Read the Evidence section ALONE — passing the whole artifact here would let
  // the artifact's own headings count as proof of itself.
  const evidence = String(parsed.fields.evidence || sectionText(content, "evidence"))
    .replace(/^[\s>*\-`#]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const evidenceThin = !evidence || evidence.length < 12 || /^(none|n\/a|tbd|todo|-)+( none| n\/a| tbd| todo| -)*$/i.test(evidence);
  if (status === "DONE" && evidenceThin) {
    return { ok: false, kind: "unverified", reasons: ["status DONE with no usable evidence — a claim is not a result"], parsed, status };
  }
  return { ok: true, kind: null, reasons: [], parsed, status: status || "DONE" };
}

/**
 * The explicit failure behavior. Given a mission and a failure kind, decide the
 * next state, the action, and — with the limits in projects.json — when to stop
 * retrying and escalate instead.
 *
 * Bounded by construction: retries and reassignments both decrease and the
 * terminal state is `escalated`, so a broken flow cannot loop forever.
 */
export function nextAfterFailure(mission, failure, { limits = {} } = {}) {
  const cfg = { ...defaultLimits(), ...limits };
  const retries = mission.retries || 0;
  const attempts = mission.attempts || 1;
  const retriesLeft = Math.max(0, cfg.retryLimit - retries);
  const reassignLeft = Math.max(0, cfg.reassignLimit - (attempts - 1));

  const base = { at: iso(), mission: mission.id, project: mission.project, kind: failure.kind, detail: failure.detail || null, retries_left: retriesLeft, reassignments_left: reassignLeft };

  switch (failure.kind) {
    case "missing":
    case "incomplete":
      if (retriesLeft > 0) {
        return { ...base, state: "awaiting_handoff", action: "reprompt_owner", instruction: `rewrite ${rel(mission.handoff_path)} with every required field (${REQUIRED_FIELDS.join(", ")}) and the ${HANDOFF_MARKER} marker` };
      }
      if (reassignLeft > 0) {
        return { ...base, state: "awaiting_handoff", action: "reassign", instruction: "the owner did not produce a usable handoff — hand the mission, with its state and resume point, to the next healthy free-model agent" };
      }
      return { ...base, state: "escalated", action: "escalate", instruction: "handoff missing after the retry and reassignment budget — a human must look at this mission" };

    case "unverified":
      if (retriesLeft > 0) {
        return { ...base, state: "awaiting_handoff", action: "reprompt_evidence", instruction: "the DONE claim carries no evidence — re-run the acceptance command and paste its real output into the Evidence section" };
      }
      return { ...base, state: "escalated", action: "escalate", instruction: "a completion claim that cannot be backed by evidence is not a completion — escalate for review" };

    case "isolation_violation":
      return { ...base, state: "open", action: "reject_cross_project", instruction: `refused: the artifact must be written inside ${rel(handoffDir(mission.project))}. Nothing was closed by it.` };

    case "stale":
      return { ...base, state: "awaiting_handoff", action: "reprompt_owner", instruction: `the artifact predates this dispatch — re-run the mission and rewrite ${rel(mission.handoff_path)}` };

    case "owner_died":
    case "blocked_provider":
      return { ...base, state: "interrupted", action: "failover_resume", instruction: "preserve the mission id and its resume point; resume it on the next verified free model. The task is never dropped and never restarted from scratch." };

    case "denied":
      return { ...base, state: "blocked", action: "block", instruction: "the mission is blocked on something the agent cannot do (credentials, operator consent) — record the exact blocker and stop" };

    default:
      return { ...base, state: "failed", action: "requeue", instruction: `unclassified failure (${failure.kind || "unknown"}) — requeue within the retry budget` };
  }
}

/** Apply a transition to the mission record and write the ledger row. */
export function applyTransition(mission, transition) {
  const updated = {
    ...mission,
    state: transition.state,
    last_transition: transition,
    retries: transition.action === "reprompt_owner" || transition.action === "reprompt_evidence" ? (mission.retries || 0) + 1 : mission.retries || 0,
    attempts: transition.action === "reassign" || transition.action === "failover_resume" ? (mission.attempts || 1) + 1 : mission.attempts || 1,
  };
  saveMission(updated);
  ledger(mission.project, transition);
  return updated;
}
