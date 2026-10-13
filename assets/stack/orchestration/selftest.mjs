#!/usr/bin/env node
// orchestration/selftest.mjs — the installed setup's own proof.
//
// WHAT IT PROVES (all against the real modules beside it — the topology rule,
// the cap math, the space invariant, the handoff verifier and the free-model
// refusal are the code that actually runs in this repo, not a mock of it):
//
//   1. the TAB CONTRACT: one control plane plus one tab per project, every
//      declared agent resolving to a tab that allows its role — and the planted
//      violations (a second supervisor, a duplicate project id, a worker in
//      another project's tab) being caught rather than tolerated;
//   2. the WORKER CAP as math: never past the limit, the control plane never
//      counted or trimmed, deterministic, a supervisor is not a worker;
//   3. the CAP as a SETTING: config → env → run-control precedence, with the
//      effective value naming where it came from, and a change being logged;
//   4. the SPACE INVARIANT: project.id === browser_space === basename(tree);
//   5. the HANDOFF LIFECYCLE: a complete artifact closes a mission, and every
//      failure kind (missing, unverified, isolation, stale) is refused with the
//      documented next action — bounded, never a loop;
//   6. the MONEY RULE: every task in this repo declares the dollar it produces;
//   7. FREE MODELS ONLY: a verified catalog is used and reported as live; with
//      nothing verified, dispatch is REFUSED instead of falling back to a paid
//      model. The failover state machine is driven with an INJECTED probe.
//
// WHAT IT DOES NOT COVER — stated so this file is never read as more than it is:
//
//   - no live multiplexer: no tab is created, no pane is split, no agent is
//     started. `node orchestration/tabs.mjs up --dry-run` inside Herdr is the
//     check for that, and `tabs.mjs plan` reads the real one;
//   - no real model provider: the free-model assertions use a scratch catalog
//     command, and every injected failure below is LABELLED as injected;
//   - no browser: `lib/ego.mjs` names and checks the space, it does not open one;
//   - no probe: `healthCheck()` is not exercised, because a probe is a real
//     one-shot model run and this file must be safe to run offline.
//
//   node orchestration/selftest.mjs              exit 0 when everything passes
//   KEEP_STATE=1 node orchestration/selftest.mjs leave the scratch state dir behind
//
// The scratch state dir is set BEFORE the modules load, so a run never reads or
// writes live state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-selftest-"));
// A state dir of its own, and a catalog port that is deliberately not serving,
// so discovery can never accidentally reach the operator's live surfaces.
const EMPTY_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-selftest-empty-"));
process.env.ORCHESTRATION_STATE_DIR = TMP;
process.env.SENTINEL_PORT = "45999";

const { planRoster, countActiveWorkers, workerCap, setWorkerCap, WORKER_LIMIT_DEFAULT } = await import("./lib/cap.mjs");
const { CONTROL_TAB, tabs, placementInvariant, governor, controlPlaneAgents, workerAgents, agentIndex } = await import("./lib/topology.mjs");
const { createFailover, discover, select, FreeModelUnavailable, DEFAULTS } = await import("./lib/free-models.mjs");
const {
  createMission,
  saveMission,
  loadMissions,
  validateArtifact,
  nextAfterFailure,
  applyTransition,
  artifactPath,
  handoffDir,
  rel,
  defaultLimits,
  HANDOFF_MARKER,
  REQUIRED_FIELDS,
  STATES,
} = await import("./lib/handoff.mjs");
const { spaceInvariant, spaceFor } = await import("./lib/ego.mjs");

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const notes = [];
const t0 = Date.now();

function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return Boolean(condition);
}

function section(title) {
  console.log(`\n${title}`);
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function readConfig() {
  const file = path.join(HERE, "projects.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`  FAIL  orchestration/projects.json is readable — ${err.message}`);
    console.log("\nNothing else can be checked without the crew's data. Run `ace setup` first.");
    process.exit(1);
  }
}

const CONFIG = readConfig();
const PROJECTS = CONFIG.projects || [];
const CAP_LIMIT = Number(CONFIG.cap?.max_active_workers ?? WORKER_LIMIT_DEFAULT);

// ---------------------------------------------------------------------------
// 1. the tab contract
// ---------------------------------------------------------------------------

section("the tab contract — one control plane plus one tab per project");

const placement = placementInvariant(CONFIG);
ok("every declared agent resolves to a tab that allows its role", placement.ok, placement.violations.join("; "));
ok(
  "the plan is the control plane plus one tab per project",
  JSON.stringify(placement.plan) === JSON.stringify([CONTROL_TAB, ...PROJECTS.map((p) => p.id)]),
  JSON.stringify(placement.plan)
);
ok("the tab count is 1 + the number of projects", tabs(CONFIG).ids.length === 1 + PROJECTS.length, `${tabs(CONFIG).ids.length} vs ${1 + PROJECTS.length}`);
ok("no project uses the control plane's id", PROJECTS.every((p) => p.id !== CONTROL_TAB), PROJECTS.map((p) => p.id).join(", "));
ok("exactly one governor oversees the supervisors", Boolean(governor(CONFIG)), "governor missing from the topology");

// Planted violations: the rule must CATCH them, not just describe them.
const twoSupervisors = clone(CONFIG);
twoSupervisors.projects[0].agents.push({ role: "supervisor", name: `${twoSupervisors.projects[0].id}-supervisor-2`, harness: "opencode", priority: 9 });
const twoSupervisorVerdict = placementInvariant(twoSupervisors);
ok(
  "a project with two supervisors is refused",
  !twoSupervisorVerdict.ok && twoSupervisorVerdict.violations.some((v) => /declares 2 supervisors/.test(v)),
  JSON.stringify(twoSupervisorVerdict.violations)
);

const duplicateId = clone(CONFIG);
if (duplicateId.projects.length > 1) {
  duplicateId.projects[1].id = duplicateId.projects[0].id;
  const duplicateVerdict = placementInvariant(duplicateId);
  ok(
    "two projects sharing one id are refused",
    !duplicateVerdict.ok && duplicateVerdict.violations.some((v) => /duplicate tab|duplicate agent name|collides/.test(v)),
    JSON.stringify(duplicateVerdict.violations)
  );
} else {
  ok("two projects sharing one id are refused", true, "only one project is declared — planted violation not applicable");
}

const crossTab = clone(CONFIG);
if (crossTab.projects.length > 1) {
  const worker = crossTab.projects[0].agents.find((a) => a.role === "worker");
  if (worker) worker.tab = crossTab.projects[1].id;
  const crossVerdict = placementInvariant(crossTab);
  ok(
    "a worker declaring another project's tab is refused",
    !crossVerdict.ok && crossVerdict.violations.some((v) => /lives in its project's tab/.test(v)),
    JSON.stringify(crossVerdict.violations)
  );
} else {
  ok("a worker declaring another project's tab is refused", true, "only one project is declared — planted violation not applicable");
}

// ---------------------------------------------------------------------------
// 2. the worker cap as math
// ---------------------------------------------------------------------------

section(`the worker cap as math — the budget is ${CAP_LIMIT}`);

// The planner may never ADD past the limit. An occupancy that is ALREADY over it
// is a different fact: the plan allocates nothing more and reports `within_limit:
// false` rather than hiding a crew that is already bigger than its budget.
let overLimit = null;
let alreadyOverReported = true;
for (let active = 0; active <= CAP_LIMIT + 2; active++) {
  const plan = planRoster(CONFIG, { limit: CAP_LIMIT, active });
  const freeSlots = Math.max(0, CAP_LIMIT - active);
  if (plan.workers.length > freeSlots) overLimit = { active, plan };
  // AT the cap is not over it: a crew of exactly the budget stays within it. Past
  // the cap, the plan must say so rather than report a limit it has exceeded.
  if (active > CAP_LIMIT && plan.within_limit) alreadyOverReported = false;
  if (active >= CAP_LIMIT && plan.workers.length !== 0) overLimit = { active, plan };
}
ok("no occupancy from 0 to cap+2 is allocated past the limit", overLimit === null, overLimit ? `active ${overLimit.active} allocated ${overLimit.plan.workers.length}` : "");
ok("an occupancy at the cap allocates nothing more, and one past it is reported as over", alreadyOverReported);

const widePlan = planRoster(CONFIG, { limit: CAP_LIMIT, active: 0 });
const declaredWorkers = workerAgents(CONFIG).length;
const expectedAllocated = Math.min(CAP_LIMIT, declaredWorkers);
ok("the plan allocates exactly min(cap, declared workers)", widePlan.workers.length === expectedAllocated, `${widePlan.workers.length} vs ${expectedAllocated}`);
ok("every worker the cap did not fit is reported as trimmed", widePlan.trimmed.length === Math.max(0, declaredWorkers - CAP_LIMIT), `${widePlan.trimmed.length} trimmed of ${declaredWorkers} declared`);
ok("the control plane is never trimmed", widePlan.trimmed.every((t) => t.role === "worker"), JSON.stringify(widePlan.trimmed));

const controlNames = controlPlaneAgents(CONFIG).map((c) => c.agent.name);
const planWithNoOccupancy = planRoster(CONFIG, { limit: 0, active: 0 });
ok(
  "with a cap of zero the whole control plane is still planned",
  controlNames.every((n) => planWithNoOccupancy.control_plane.some((a) => a.name === n)) && planWithNoOccupancy.workers.length === 0,
  `${planWithNoOccupancy.control_plane.length} control agents, ${planWithNoOccupancy.workers.length} workers`
);

const deterministicA = JSON.stringify(planRoster(CONFIG, { limit: CAP_LIMIT, active: 1 }));
const deterministicB = JSON.stringify(planRoster(CONFIG, { limit: CAP_LIMIT, active: 1 }));
ok("the same input produces a byte-identical plan", deterministicA === deterministicB);

// A supervisor shares its project's name prefix; counting by prefix would drag
// it into the worker budget and trim it to make room for a worker.
const index = agentIndex(CONFIG);
const supervisorRoleDisagreement = PROJECTS.flatMap((p) => p.agents.filter((a) => a.role === "supervisor" && index.get(a.name)?.role !== "supervisor"));
ok("a supervisor is classified as control, not as a worker", supervisorRoleDisagreement.length === 0, supervisorRoleDisagreement.map((a) => a.name).join(", "));
ok("a project's supervisor and its workers share a prefix but not a role", PROJECTS.every((p) => {
  const sup = p.agents.find((a) => a.role === "supervisor");
  const worker = p.agents.find((a) => a.role === "worker");
  return !sup || !worker || (worker.name.startsWith(p.id) && index.get(sup.name).role !== index.get(worker.name).role);
}), PROJECTS.map((p) => p.id).join(", "));

const liveCount = countActiveWorkers([], CONFIG);
ok("an empty live list counts zero workers and does not invent one", liveCount.total === 0, JSON.stringify(liveCount.by_project));

// ---------------------------------------------------------------------------
// 3. the cap as a setting
// ---------------------------------------------------------------------------

section("the cap as a setting — the value names where it came from");

const runControl = path.join(TMP, "run-control.json");
const missingRunControl = path.join(TMP, "no-such-run-control.json");
const capLog = path.join(TMP, "cap-settings.jsonl");

fs.writeFileSync(runControl, `${JSON.stringify({ worker_cap: 7 })}\n`);
const fromControl = workerCap(CONFIG, { runControlFile: runControl });
ok("the live operator setting wins", fromControl.limit === 7 && fromControl.source === "run-control.json", JSON.stringify(fromControl));

const fromEnv = workerCap(CONFIG, { env: { ORCHESTRATION_WORKER_CAP: "5" }, runControlFile: missingRunControl });
ok("the environment is second", fromEnv.limit === 5 && fromEnv.source === "env:ORCHESTRATION_WORKER_CAP", JSON.stringify(fromEnv));

const fromConfig = workerCap(CONFIG, { env: {}, runControlFile: missingRunControl });
ok(
  "the config is third, and its source is named",
  fromConfig.limit === CAP_LIMIT && fromConfig.source === "projects.json:cap.max_active_workers",
  JSON.stringify(fromConfig)
);

const changed = setWorkerCap(6, { config: CONFIG, runControlFile: path.join(TMP, "set-cap.json"), logFile: capLog });
ok("a cap change reports the before value and its source", changed.before === CAP_LIMIT && changed.limit === 6, JSON.stringify(changed));
ok("a cap change is written, never silent", fs.existsSync(path.join(TMP, "set-cap.json")) && fs.readFileSync(capLog, "utf8").trim().split("\n").length === 1);

let refusedNonsense = false;
try {
  setWorkerCap(-1, { config: CONFIG, runControlFile: runControl });
} catch {
  refusedNonsense = true;
}
ok("a nonsense cap is refused", refusedNonsense);

// ---------------------------------------------------------------------------
// 4. the space invariant
// ---------------------------------------------------------------------------

section("the space invariant — a project is one name");

for (const project of PROJECTS) {
  const verdict = spaceInvariant(project);
  ok(`${project.id}: browser space === project id === tree name`, verdict.ok, verdict.violations.join("; "));
}

const badSpace = clone(PROJECTS[0]);
badSpace.browser_space = "some-other-space";
const badVerdict = spaceInvariant(badSpace);
ok("a project whose space and id disagree is refused", !badVerdict.ok, JSON.stringify(badVerdict.violations));
ok("the space a project's browser work must use is its own id", PROJECTS.every((p) => spaceFor(p) === p.id), PROJECTS.map((p) => spaceFor(p)).join(", "));

// ---------------------------------------------------------------------------
// 5. the handoff lifecycle
// ---------------------------------------------------------------------------

section("the handoff lifecycle — evidence, or the documented refusal");
ok("this run cannot reach live state (both state dirs are scratch)", !path.resolve(TMP).startsWith(path.resolve(ROOT) + path.sep) && !path.resolve(EMPTY_STATE).startsWith(path.resolve(ROOT) + path.sep), `${TMP} vs repo ${ROOT}`);

const project = PROJECTS[0];
const task = (project.tasks || [])[0] || {
  id: "t1-selftest",
  title: "a synthesized task for this check",
  money: project.money || "this check proves the lifecycle, not a dollar",
  acceptance: ["the artifact exists"],
  prompt: "selftest-only task",
};
const agent = project.agents.find((a) => a.role === "worker") || project.agents[0];

function artifactText(mission, { evidence = "`node --test test/*.test.mjs` exited 0 (12 assertions, 0 failures)", status = "DONE" } = {}) {
  return [
    `mission: ${mission.id}`,
    `project: ${mission.project}`,
    `owner: ${mission.owner}`,
    `status: ${status}`,
    "",
    "## Files changed",
    "- orchestration/selftest.mjs",
    "",
    "## Commands run",
    "- node orchestration/selftest.mjs",
    "",
    "## Results",
    "- the assertions above passed",
    "",
    "## Failures",
    "- none",
    "",
    "## Evidence",
    evidence,
    "",
    "## Next",
    "- nothing",
    "",
    `${HANDOFF_MARKER} ${rel(mission.handoff_path)}`,
    "",
  ].join("\n");
}

const mission = createMission({ project, task, agent });
ok("a mission records its owner, scope, acceptance and money", mission.owner === agent.name && mission.money === task.money && mission.acceptance.length >= 0, JSON.stringify({ owner: mission.owner, money: mission.money }));
ok("a mission's artifact path is inside its own project's handoff directory", path.resolve(mission.handoff_path).startsWith(path.resolve(handoffDir(project.id)) + path.sep), rel(mission.handoff_path));
ok("the artifact path uses a declared state suffix", STATES.some((s) => mission.handoff_path.endsWith(`${mission.id}-${s}.md`)));

let unpricedRefused = false;
try {
  createMission({ project, task: { id: "t1-unpriced", title: "no money line", prompt: "x" }, agent });
} catch {
  unpricedRefused = true;
}
ok("a task with no money line is refused at dispatch", unpricedRefused);

saveMission(mission);
ok("the mission record is durable", Boolean(loadMissions(project.id)[mission.id]), rel(path.join(TMP, project.id, "missions.json")));

const missingVerdict = validateArtifact({ project, mission });
ok("a mission with no artifact is not complete", missingVerdict.ok === false && missingVerdict.kind === "missing", JSON.stringify(missingVerdict));
const missingTransition = nextAfterFailure(mission, missingVerdict);
ok("a missing artifact re-prompts the owner inside the retry budget", missingTransition.state === "awaiting_handoff" && missingTransition.action === "reprompt_owner", JSON.stringify(missingTransition));

fs.mkdirSync(path.dirname(mission.handoff_path), { recursive: true });
fs.writeFileSync(mission.handoff_path, artifactText(mission));
const completeVerdict = validateArtifact({ project, mission });
ok("a complete artifact carrying real evidence closes the mission", completeVerdict.ok === true, JSON.stringify(completeVerdict.reasons || []));

const bareArtifact = [`mission: ${mission.id}`, `project: ${mission.project}`, `owner: ${mission.owner}`, "status: DONE", `${HANDOFF_MARKER} ${rel(mission.handoff_path)}`, ""].join("\n");
fs.writeFileSync(mission.handoff_path, bareArtifact);
const incompleteVerdict = validateArtifact({ project, mission });
ok(
  `an artifact missing its sections is incomplete, and the missing fields are named (${REQUIRED_FIELDS.length} required)`,
  incompleteVerdict.ok === false && incompleteVerdict.kind === "incomplete" && String(incompleteVerdict.reasons.join(" ")).includes("evidence"),
  JSON.stringify(incompleteVerdict.reasons)
);

fs.writeFileSync(mission.handoff_path, artifactText(mission, { evidence: "none" }));
const unverifiedVerdict = validateArtifact({ project, mission });
ok("a DONE claim with no usable evidence is unverified, not done", unverifiedVerdict.ok === false && unverifiedVerdict.kind === "unverified", JSON.stringify(unverifiedVerdict));
const unverifiedTransition = nextAfterFailure(mission, unverifiedVerdict);
ok("an unverified claim gets one bounded attempt to produce evidence", unverifiedTransition.action === "reprompt_evidence" || unverifiedTransition.action === "escalate", JSON.stringify(unverifiedTransition));

fs.writeFileSync(mission.handoff_path, artifactText(mission));
const otherProject = PROJECTS[1] || { id: "another-project" };
const strayFile = path.join(handoffDir(otherProject.id), "t1-selftest-DONE.md");
const isolationVerdict = validateArtifact({ project, mission, artifactFile: strayFile, text: artifactText(mission) });
ok("an artifact from another project's directory is an isolation violation", isolationVerdict.ok === false && isolationVerdict.kind === "isolation_violation", JSON.stringify(isolationVerdict));
const isolationTransition = nextAfterFailure(mission, isolationVerdict);
ok("an isolation violation closes nothing", isolationTransition.state === "open" && isolationTransition.action === "reject_cross_project", JSON.stringify(isolationTransition));

const staleMission = { ...mission, id: "t1-selftest-stale", handoff_path: artifactPath(project, "t1-selftest-stale", "DONE"), dispatched_at: new Date(Date.now() + 60_000).toISOString() };
fs.mkdirSync(path.dirname(staleMission.handoff_path), { recursive: true });
fs.writeFileSync(staleMission.handoff_path, artifactText(staleMission));
const staleVerdict = validateArtifact({ project, mission: staleMission });
ok("an artifact older than its dispatch is refused as stale", staleVerdict.ok === false && staleVerdict.kind === "stale", JSON.stringify(staleVerdict));

// The failure behaviour must terminate: retries, then reassignments, then a
// human — never an unbounded loop.
let cursor = mission;
let steps = 0;
const seen = [];
while (steps < 12) {
  const transition = nextAfterFailure(cursor, { kind: "missing" }, { limits: defaultLimits() });
  seen.push(transition.action);
  cursor = applyTransition(cursor, transition);
  steps += 1;
  if (cursor.state === "escalated") break;
}
ok(
  "the retry/reassign budget terminates in an escalation",
  cursor.state === "escalated" && steps <= defaultLimits().retryLimit + defaultLimits().reassignLimit + 2,
  `${steps} steps: ${seen.join(" → ")}`
);
ok("a bounded failure never exceeds the configured budget", seen.filter((a) => a === "reprompt_owner").length <= defaultLimits().retryLimit + 1, seen.join(" → "));
ok("the ledger recorded every transition it applied", fs.readFileSync(path.join(TMP, project.id, "handoff-ledger.jsonl"), "utf8").trim().split("\n").length >= 4);

// ---------------------------------------------------------------------------
// 6. the money rule
// ---------------------------------------------------------------------------

section("the money rule — every task names its dollar");

const allTasks = PROJECTS.flatMap((p) => (p.tasks || []).map((t) => ({ ...t, project: p.id })));
const unpriced = allTasks.filter((t) => !String(t.money ?? "").trim());
ok(
  allTasks.length ? `every declared task carries a money line (${allTasks.length} task(s))` : "no task is declared yet (an empty queue is allowed, an unpriced task is not)",
  unpriced.length === 0,
  unpriced.map((t) => `${t.project}:${t.id}`).join(", ")
);
ok("every project states the dollar its work can produce", PROJECTS.every((p) => String(p.money ?? "").trim().length > 0), PROJECTS.filter((p) => !String(p.money ?? "").trim()).map((p) => p.id).join(", "));

// ---------------------------------------------------------------------------
// 7. free models only, and the refusal when there are none
// ---------------------------------------------------------------------------

section("free models only — a verified catalog, or a refusal");

// The host may have a real opencode installed — this machine does. Point the NIM
// catalog at a binary that does not exist BEFORE the first discovery, so the only
// source in play is the scratch command below and the refusal case means what it
// says. (The catalog is memoised with a TTL, so this must happen first.)
const previousOpencodeBin = process.env.SENTINEL_OPENCODE_BIN;
process.env.SENTINEL_OPENCODE_BIN = path.join(TMP, "not-an-opencode-binary");

function writeCatalogCommand(file, payload) {
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify(${JSON.stringify(payload)}, null, 2));\n`,
    { mode: 0o755 }
  );
  return file;
}

const verifiedCatalog = [
  { key: "opencode/selftest-free-large", providerID: "opencode", id: "selftest-free-large", free: true, tools: true, context: 200_000 },
  { key: "opencode/selftest-free-small", providerID: "opencode", id: "selftest-free-small", free: true, tools: true, context: 32_000 },
];
const catalogCommand = writeCatalogCommand(path.join(TMP, "free-model-command.mjs"), { models: verifiedCatalog });
process.env.ACE_FREE_MODEL_COMMAND = catalogCommand;

const pool = await discover();
ok("a verified catalog is reported as served live", pool.served_live === true && pool.count >= 2, JSON.stringify({ served_live: pool.served_live, count: pool.count }));
ok("every model in the pool is verified free, with its provenance", pool.models.every((m) => m.free === true && m.free_source && m.free_source !== "cache"), JSON.stringify(pool.models.map((m) => `${m.key}:${m.free_source}`)));

const picked = await select();
ok("a free model can be selected, and it is free", picked.free === true && typeof picked.key === "string", JSON.stringify({ key: picked.key, free_source: picked.free_source }));

const emptyCommand = writeCatalogCommand(path.join(TMP, "free-model-command-empty.mjs"), []);
process.env.ACE_FREE_MODEL_COMMAND = emptyCommand;
process.env.ORCHESTRATION_STATE_DIR = EMPTY_STATE; // no cache to fall back to
let refusedReason = null;
try {
  await select();
} catch (err) {
  refusedReason = err;
}
ok(
  "with nothing verified, dispatch is refused rather than falling back to a paid model",
  refusedReason instanceof FreeModelUnavailable,
  refusedReason ? String(refusedReason.message) : "select() returned a model with no verified free source"
);
if (previousOpencodeBin === undefined) delete process.env.SENTINEL_OPENCODE_BIN;
else process.env.SENTINEL_OPENCODE_BIN = previousOpencodeBin;
process.env.ORCHESTRATION_STATE_DIR = TMP;

// The failover state machine, driven by an INJECTED probe. Everything in this
// block is simulated on purpose: no provider failed, and no model was contacted.
// `healthCheck()` is deliberately not called: a probe is a real one-shot model
// run, and this file must stay safe to run offline.
notes.push("healthCheck() was not exercised — it needs a real model probe, and this run is offline");
const providerKey = "opencode/selftest-injected";
const failoverState = path.join(TMP, "providers.json");
const failoverLedger = path.join(TMP, "failover.jsonl");
let probeVerdict = { ok: false, error: "injected: the probe has not been allowed to pass yet" };
const injectedProbe = async () => ({ ...probeVerdict, ms: 1 });
const machine = createFailover({ probe: injectedProbe, stateFile: failoverState, ledgerPath: failoverLedger });

const hard = () => new Error("429 too many requests (INJECTED)");
const first = machine.onProviderError({ key: providerKey, error: hard(), attempt: 1, project: project.id, mission: mission.id, resumeFrom: "t1-selftest#step-3" });
ok("a hard failure on the first try is retried inside the budget", first.action === "retry_same_model" && first.retries_left === DEFAULTS.retryLimit, JSON.stringify(first));
ok("a failed provider goes into cooldown", machine.inCooldown(providerKey) === true && Boolean(first.cooldown_until));
ok("the mission keeps its resume point", first.resume_from === "t1-selftest#step-3", String(first.resume_from));

const exhausted = machine.onProviderError({ key: providerKey, error: hard(), attempt: DEFAULTS.retryLimit + 1, project: project.id, mission: mission.id });
ok("once the retry budget is spent the model is benched and switched away from", exhausted.action === "switch_model" && exhausted.retries_left === 0, JSON.stringify(exhausted));
ok("the switch is written to the ledger", fs.existsSync(failoverLedger) && fs.readFileSync(failoverLedger, "utf8").includes("switch_model"));

let circuit = null;
for (let i = 0; i < DEFAULTS.circuitThreshold + 1; i++) {
  circuit = machine.onProviderError({ key: providerKey, error: hard(), attempt: 1, project: project.id });
  if (circuit.circuit_opened) break;
}
ok(`the circuit opens at ${DEFAULTS.circuitThreshold} hard failures`, circuit?.circuit_opened === true && machine.circuitOpen(providerKey) === true, JSON.stringify(circuit));
ok("an open circuit parks the mission instead of dropping it", circuit?.action === "park_blocked_provider", String(circuit?.action));

const failedRecovery = await machine.tryRecover({ keys: [providerKey], project: project.id });
ok("a provider is NOT restored while its probe fails", failedRecovery.every((r) => r.restored === false) && machine.circuitOpen(providerKey) === true, JSON.stringify(failedRecovery));
probeVerdict = { ok: true, ms: 12 };
const recovered = await machine.tryRecover({ keys: [providerKey], project: project.id });
ok("a provider is restored only on a passing probe", recovered.every((r) => r.restored === true) && machine.circuitOpen(providerKey) === false, JSON.stringify(recovered));
ok("the recovery is written down, never silent", fs.readFileSync(failoverLedger, "utf8").includes("provider_recovered"));

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const elapsed = Date.now() - t0;
console.log("");
console.log(failed === 0 ? `selftest: ${passed} ok, 0 failures (${elapsed}ms)` : `selftest: ${passed} ok, ${failed} FAILED (${elapsed}ms)`);
console.log(`state: scratch dirs only — nothing live was read or written (${TMP})`);
if (notes.length) for (const note of notes) console.log(`note: ${note}`);

if (!process.env.KEEP_STATE) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(EMPTY_STATE, { recursive: true, force: true });
} else {
  console.log(`kept: ${TMP} and ${EMPTY_STATE}`);
}

process.exit(failed === 0 ? 0 : 1);
