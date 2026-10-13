import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import * as rt from "../lib/runtime.mjs";
import { resolveConfig } from "../lib/config.mjs";
import { buildCrew, canStart, checkRoute } from "../lib/crew.mjs";
import { governorCycle, supervisorCycle } from "../lib/governance.mjs";

/* A workspace whose adapters are local/declarative: no terminal, no network,
 * no provider cost. The governance cycles are therefore exercised for real
 * without any commercial credential. */

const DEAD_PID = 999999; // never a live pid on this platform

function withGovernance(ace, fn) {
  const root = mkdtempSync(join(tmpdir(), "ace-gov-"));
  const dir = join(root, "ws");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "ws",
        version: "0.1.0",
        ace: {
          spec: "ace/v1",
          name: "ws",
          orchestrator: { runtime: "fake", role: "governor" },
          goal: { statement: "ship the smoke feature" },
          agents: { workers: [{ role: "backend" }, { role: "tester" }] },
          adapters: {
            multiplexer: { provider: "none" },
            "agent-runtime": { provider: "fake" },
            provider: { provider: "fake" },
            handoff: { provider: "filesystem" },
            context: { provider: "filesystem" },
          },
          models: { default: { provider: "fake", model: "fake-1" } },
          concurrency: { max_active_agents: 4 },
          ...ace,
        },
      },
      null,
      2
    )
  );
  const env = { ACE_HOME: join(root, "home") };
  const resolved = resolveConfig({ dir, env });
  rt.initState(dir);
  rt.setStatus(dir, "running");
  try {
    fn({ dir, root, env, effective: resolved.effective, crew: buildCrew(resolved.effective), resolved });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A supervisor that looks alive: fresh heartbeat and this live process. */
function liveSupervisor(dir, id = "primary-supervisor") {
  rt.writeHeartbeat(dir, { agent: id, role: "supervisor", project: "primary", status: "working", pid: process.pid });
  rt.upsertAgent(dir, { id, role: "supervisor", status: "working", project: "primary", pid: process.pid });
}

function aceFiles(dir) {
  const out = [];
  const walk = (base) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${relative(dir, full)}:${statSync(full).size}`);
    }
  };
  const ace = join(dir, ".ace");
  if (readFileSyncSafe(ace) === null) return out;
  walk(ace);
  return out.sort();
}

function readFileSyncSafe(p) {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

test("a supervisor that is not running is detected, recovery is recorded and the operator is told", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const report = governorCycle(dir, effective, { apply: true, crew, env: {} });

    assert.ok(report.detections.some((d) => d.code === "SUPERVISOR_ABSENT"));
    const action = report.actions.find((a) => a.type === "restart");
    assert.ok(action, "a silent supervisor on a healthy route needs a restart, not a route switch");
    assert.equal(action.delivered, false, "nothing may claim a restart it did not deliver");
    assert.match(action.reason, /not delivered/);
    assert.equal(report.escalations.length, 1);
    assert.equal(report.escalations[0].code, "SUPERVISOR_UNRECOVERED");
    assert.equal(report.escalations[0].needsOperator, true);
    assert.equal(report.ok, false);
    assert.ok(rt.readCheckpoint(dir, "primary-supervisor"), "recoverable state is preserved before a recovery action");
    assert.ok(report.checksNotRun.length > 0, "checks that were not run must be disclosed");
    assert.equal(report.budget.limit, 4);
    assert.equal(report.goal.statement, "ship the smoke feature");
  });
});

test("a restart that is genuinely delivered needs no operator", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const asked = [];
    const report = governorCycle(dir, effective, {
      apply: true,
      crew,
      env: {},
      deliver: ({ action }) => {
        asked.push(action.subject);
        return { ok: true, detail: "started by the fake runtime" };
      },
    });

    assert.deepEqual(asked, ["primary-supervisor"]);
    assert.equal(report.escalations.length, 0);
    assert.equal(report.ok, true, JSON.stringify(report.unresolvedDetections));
    assert.equal(report.actions.find((a) => a.type === "restart").delivered, true);
    assert.match(report.actions.find((a) => a.type === "restart").reason, /restarted/);
  });
});

test("a fresh heartbeat from a process that has died is still a failure", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    rt.writeHeartbeat(dir, { agent: "primary-supervisor", role: "supervisor", project: "primary", status: "working", pid: DEAD_PID });
    rt.upsertAgent(dir, { id: "primary-supervisor", role: "supervisor", status: "working", project: "primary", pid: DEAD_PID });

    const report = governorCycle(dir, effective, { apply: false, crew, env: {} });
    const sup = report.supervisors[0];
    assert.equal(sup.responsive, true, "the heartbeat itself is fresh");
    assert.equal(sup.alive, false, "but the process behind it is gone");
    assert.equal(sup.pidAlive, false);
    assert.ok(report.detections.some((d) => d.code === "SUPERVISOR_DEAD"));
  });
});

test("a heartbeat alone does not prove progress: no movement is reported and diagnosed", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    liveSupervisor(dir);

    const report = governorCycle(dir, effective, { apply: true, crew, env: {} });
    assert.equal(report.supervisors[0].alive, true);
    assert.equal(report.supervisors[0].evidence.advanced, false);
    assert.ok(report.detections.some((d) => d.code === "NO_PROGRESS"));

    const request = report.actions.find((a) => a.type === "request_diagnosis");
    assert.ok(request, "the governor must ask the affected supervisor, not a worker");
    assert.equal(request.subject, "primary-supervisor");
    assert.equal(request.ok, true);
    assert.ok(rt.readActions(dir).some((a) => a.type === "request_diagnosis"));
  });
});

test("task movement counts as evidence of progress", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    liveSupervisor(dir);
    const task = rt.createTask(dir, { title: "move it", project: "primary" });
    rt.claimTask(dir, task.id, { agent: "primary-backend", project: "primary" });

    const report = governorCycle(dir, effective, { apply: true, crew, env: {} });
    assert.equal(report.supervisors[0].evidence.advanced, true);
    assert.equal(report.supervisors[0].evidence.taskUpdates >= 1, true);
    assert.equal(report.detections.some((d) => d.code === "NO_PROGRESS"), false);
  });
});

// ---------------------------------------------------------------------------
// failover
// ---------------------------------------------------------------------------

test("the governor replaces an unusable supervisor route with a validated fallback", () => {
  withGovernance(
    {
      models: {
        default: { provider: "fake", model: "fake-1" },
        routes: {
          supervisor: {
            primary: { provider: "openai", model: "gpt-5" },
            fallbacks: [{ provider: "fake", model: "fallback-1" }],
          },
        },
      },
    },
    ({ dir, effective, crew }) => {
      liveSupervisor(dir);

      const report = governorCycle(dir, effective, { apply: true, crew, env: {} });
      assert.ok(report.detections.some((d) => d.code === "ROUTE_UNAVAILABLE"), "an unusable route must be reported");

      const action = report.actions.find((a) => a.type === "route.replace");
      assert.ok(action);
      assert.equal(action.ok, true, action.reason);
      assert.equal(action.to, "fake:fallback-1");

      const recorded = rt.readRoute(dir, "primary-supervisor");
      assert.equal(recorded.route.model, "fallback-1");
      assert.equal(recorded.previous.model, "gpt-5");
      assert.equal(recorded.switches, 1);
      assert.ok(rt.readCheckpoint(dir, "primary-supervisor"), "state is checkpointed before a route change");
      assert.equal(rt.readLease(dir, "route:primary-supervisor"), null, "the route lease is always released");
      assert.ok(rt.readActions(dir).some((a) => a.type === "route.replace"));
      // the credential problem is a fact the operator should still see
      assert.equal(report.supervisors[0].routeHealth.ok, false);
    }
  );
});

test("an exhausted fallback chain escalates instead of pretending to recover", () => {
  withGovernance(
    {
      models: {
        default: { provider: "fake", model: "fake-1" },
        routes: { supervisor: { primary: { provider: "openai", model: "gpt-5" } } },
      },
    },
    ({ dir, effective, crew }) => {
      liveSupervisor(dir);

      const report = governorCycle(dir, effective, { apply: true, crew, env: {} });
      assert.ok(report.detections.some((d) => d.code === "CHAIN_EXHAUSTED"));
      assert.equal(report.escalations.some((e) => e.code === "CHAIN_EXHAUSTED" && e.needsOperator), true);
      assert.equal(report.actions.some((a) => a.type === "route.replace" && a.ok), false);
      assert.equal(rt.readRoute(dir, "primary-supervisor"), null, "no route may be written when none validates");
      assert.equal(report.ok, false);
    }
  );
});

test("bounded recovery does not thrash: exhausted budget escalates", () => {
  withGovernance(
    {
      models: {
        default: { provider: "fake", model: "fake-1" },
        routes: {
          supervisor: {
            primary: { provider: "openai", model: "gpt-5" },
            fallbacks: [{ provider: "fake", model: "fallback-1" }],
          },
        },
      },
    },
    ({ dir, effective, crew }) => {
      liveSupervisor(dir);
      for (let i = 0; i < 3; i++) {
        rt.journalAction(dir, { type: "route.replace", subject: "primary-supervisor", to: `fake:attempt-${i}` });
      }

      const report = governorCycle(dir, effective, { apply: true, crew, env: {} });
      assert.equal(report.actions.some((a) => a.type === "route.replace" && a.ok), false);
      assert.equal(report.escalations.some((e) => e.needsOperator), true);
      assert.equal(rt.readRoute(dir, "primary-supervisor"), null);
    }
  );
});

test("the governor never writes a route for a worker — the boundary holds in behaviour, not just policy", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    rt.writeHeartbeat(dir, { agent: "primary-backend", role: "worker", project: "primary", status: "working", pid: DEAD_PID });
    rt.upsertAgent(dir, { id: "primary-backend", role: "worker", kind: "backend", project: "primary", status: "working", pid: DEAD_PID });
    liveSupervisor(dir);

    governorCycle(dir, effective, { apply: true, crew, env: {} });

    assert.equal(rt.readRoute(dir, "primary-backend"), null, "worker routes belong to the supervisor");
    assert.equal(checkRoute(crew.governor, crew.workers[0], effective).allowed, false);
  });
});

test("the supervisor changes its own worker's route when the worker goes unresponsive", () => {
  withGovernance(
    {
      models: {
        default: { provider: "fake", model: "fake-1" },
        routes: {
          worker: {
            primary: { provider: "fake", model: "fake-1" },
            fallbacks: [{ provider: "fake", model: "worker-fallback" }],
          },
        },
      },
    },
    ({ dir, effective, crew }) => {
      rt.writeHeartbeat(dir, { agent: "primary-backend", role: "worker", project: "primary", status: "working", pid: DEAD_PID });
      rt.upsertAgent(dir, { id: "primary-backend", role: "worker", kind: "backend", project: "primary", status: "working", pid: DEAD_PID });

      const report = supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {} });
      const change = report.routeChanges[0];
      assert.ok(change, `expected a route change (workers: ${JSON.stringify(report.workers)})`);
      assert.equal(change.to, "fake:worker-fallback");

      const recorded = rt.readRoute(dir, "primary-backend");
      assert.equal(recorded.route.model, "worker-fallback");
      assert.equal(recorded.by, "primary-supervisor");
      assert.equal(rt.readLease(dir, "route:primary-backend"), null);
      assert.ok(rt.readCheckpoint(dir, "primary-backend"));
    }
  );
});

// ---------------------------------------------------------------------------
// assignment → handoff → integration → verification
// ---------------------------------------------------------------------------

function verifiedHandoff(overrides = {}) {
  return {
    task: "placeholder",
    attempt: 1,
    from: "primary-backend",
    project: "primary",
    status: "complete",
    summary: "implemented the smoke feature",
    changed_files: ["src/smoke.mjs"],
    commands: [{ command: "npm test", exitCode: 0 }],
    checks_not_run: ["no integration suite exists for this module"],
    committed: false,
    pushed: false,
    next_action: "review and integrate",
    ...overrides,
  };
}

const passingChecks = () => ({ checks: [{ name: "test", configured: true, ok: true, exitCode: 1 - 1 }], ok: true });

test("a worker is assigned a bounded task, and only one owner can hold it", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "smoke", project: "primary", acceptance_criteria: ["npm test passes"] });

    const first = supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {} });
    assert.equal(first.assignments.length, 1);
    const assigned = rt.readTask(dir, task.id);
    assert.equal(assigned.status, "assigned");
    assert.equal(assigned.attempt, 1);
    assert.ok(assigned.owner);

    const duplicate = rt.claimTask(dir, task.id, { agent: "primary-tester", project: "primary" });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, "DUPLICATE_OWNERSHIP");
    assert.equal(rt.readTask(dir, task.id).owner, assigned.owner, "the owner never changes behind the supervisor's back");
  });
});

test("the full path runs: assign, handoff, verify, integrate, verify again, done", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "smoke feature", project: "primary" });

    supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {} });
    const owner = rt.readTask(dir, task.id).owner;
    assert.ok(owner);

    // the worker does the work and moves the task into review, then reports
    rt.setTaskStatus(dir, task.id, "in_progress", { by: owner });
    rt.writeHandoff(dir, verifiedHandoff({ task: task.id, from: owner }));
    rt.setTaskStatus(dir, task.id, "review", { by: owner });

    const report = supervisorCycle(dir, effective, {
      apply: true,
      crew,
      project: "primary",
      env: {},
      verifyChecks: passingChecks,
    });

    const verification = report.verifications.find((v) => v.task === task.id);
    assert.ok(verification, "the supervisor must verify the handoff");
    assert.equal(verification.accepted, true, JSON.stringify(verification));
    assert.equal(verification.checks.ok, true);

    const finished = rt.readTask(dir, task.id);
    assert.equal(finished.status, "done");
    assert.equal(finished.owner, null, "ownership is released when the task is finished");
    assert.equal(rt.readLease(dir, `task:${task.id}`), null);
    const statuses = finished.history.map((h) => h.type);
    for (const expected of ["created", "assigned", "in_progress", "review", "integrated", "done"]) {
      assert.ok(statuses.includes(expected), `history is missing ${expected}: ${statuses.join(", ")}`);
    }
  });
});

test("a handoff with no evidence is rejected and the task stays in review", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "unsupported claim", project: "primary" });
    supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {} });
    const owner = rt.readTask(dir, task.id).owner;
    rt.setTaskStatus(dir, task.id, "in_progress", { by: owner });
    rt.writeHandoff(dir, { task: task.id, from: owner, status: "complete", summary: "trust me" });
    rt.setTaskStatus(dir, task.id, "review", { by: owner });

    const report = supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {}, verifyChecks: passingChecks });
    assert.equal(report.verifications[0].accepted, false);
    assert.match(report.verifications[0].errors.join(" "), /verification command that exited 0/);
    assert.ok(report.blockers.some((b) => b.code === "HANDOFF_REJECTED"));
    assert.equal(rt.readTask(dir, task.id).status, "review");
    assert.equal(report.ok, false);
  });
});

test("a task whose integrated checks fail goes back to review and is reported", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "regression", project: "primary" });
    supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {} });
    const owner = rt.readTask(dir, task.id).owner;
    rt.setTaskStatus(dir, task.id, "in_progress", { by: owner });
    rt.writeHandoff(dir, verifiedHandoff({ task: task.id, from: owner }));
    rt.setTaskStatus(dir, task.id, "review", { by: owner });

    // Passing in the worker's isolated workspace does not prove the integrated
    // project passes — the supervisor re-runs the checks after integration.
    const report = supervisorCycle(dir, effective, {
      apply: true,
      crew,
      project: "primary",
      env: {},
      verifyChecks: () => ({ ok: false, checks: [{ name: "test", configured: true, ok: false, exitCode: 1 }] }),
    });

    assert.equal(report.verifications[0].accepted, true, "the handoff itself was valid");
    assert.equal(report.verifications[0].checks.ok, false, "but the integrated checks failed");
    assert.ok(report.blockers.some((b) => b.code === "INTEGRATION_CHECK_FAILED"));
    const after = rt.readTask(dir, task.id);
    assert.equal(after.status, "in_progress", "failed post-merge checks return the task to active work, not to done");
    assert.equal(after.owner, owner, "the same owner fixes it — releasing the claim would orphan the rework");
    assert.equal(after.integration.ok, false);
    assert.equal(after.history.some((h) => /rework required/.test(h.detail ?? "")), true);
    assert.equal(report.ok, false);
  });
});

test("a dry run computes a plan and writes nothing at all", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "dry", project: "primary" });
    const before = aceFiles(dir);

    const govern = governorCycle(dir, effective, { apply: false, crew, env: {} });
    const supervise = supervisorCycle(dir, effective, { apply: false, crew, project: "primary", env: {} });

    assert.equal(aceFiles(dir).join("|"), before.join("|"), "a dry run must not touch .ace/");
    assert.equal(rt.readTask(dir, task.id).status, "pending");
    assert.equal(govern.applied, false);
    assert.equal(supervise.applied, false);
    assert.equal(supervise.assignments[0].planned, true);
    assert.equal(supervise.checksNotRun.some((c) => /dry run/.test(c)), true);
  });
});

// ---------------------------------------------------------------------------
// restart, ownership conflicts, secrets
// ---------------------------------------------------------------------------

test("after a restart an interrupted agent is discovered and its task is requeued, not lost", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "half done", project: "primary" });
    supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {} });
    const owner = rt.readTask(dir, task.id).owner;
    rt.upsertAgent(dir, { id: owner, role: "worker", project: "primary", status: "working", pid: DEAD_PID });

    const report = rt.reconcile(dir);
    const agent = report.agents.find((a) => a.id === owner);
    assert.equal(agent.action, "interrupted");

    const after = rt.readTask(dir, task.id);
    assert.equal(after.status, "pending");
    assert.equal(after.owner, null);
    assert.equal(rt.readLease(dir, `task:${task.id}`), null);
    assert.equal(rt.getAgentRecords(dir).find((a) => a.id === owner).status, "interrupted");
    assert.equal(report.tasks[0].action, "requeued");
    // another worker can now take it
    assert.equal(rt.claimTask(dir, task.id, { agent: "primary-tester", project: "primary" }).ok, true);
  });
});

test("a task whose attempts are exhausted fails visibly instead of looping", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "keeps dying", project: "primary", max_attempts: 1 });
    supervisorCycle(dir, effective, { apply: true, crew, project: "primary", env: {} });
    const owner = rt.readTask(dir, task.id).owner;
    rt.upsertAgent(dir, { id: owner, role: "worker", project: "primary", status: "working", pid: DEAD_PID });

    const report = rt.reconcile(dir);
    assert.equal(report.tasks[0].action, "failed");
    assert.equal(rt.readTask(dir, task.id).status, "failed");
  });
});

test("two claimants on one task are reported as a critical ownership conflict", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    const task = rt.createTask(dir, { title: "contested", project: "primary" });
    const claimed = rt.claimTask(dir, task.id, { agent: "primary-backend", project: "primary" });
    assert.equal(claimed.ok, true);
    rt.saveTask(dir, { ...rt.readTask(dir, task.id), claimants: ["primary-backend", "primary-tester"] });
    liveSupervisor(dir);

    const report = governorCycle(dir, effective, { apply: false, crew, env: {} });
    const conflict = report.detections.find((d) => d.code === "DUPLICATE_OWNERSHIP");
    assert.ok(conflict);
    assert.equal(conflict.severity, "critical");
    assert.ok(report.escalations.some((e) => e.code === "DUPLICATE_OWNERSHIP" && e.needsOperator));
  });
});

test("a credential pasted into a handoff or an event never reaches disk", () => {
  withGovernance({}, ({ dir }) => {
    rt.storeSecret(dir, "gitbot-token", "sk-live-abcdefghijklmnopqrst");
    const leaked = "sk-live-abcdefghijklmnopqrst";

    rt.writeHandoff(dir, {
      task: "task_secret",
      from: "primary-backend",
      status: "complete",
      summary: `token = ${leaked}`,
      commands: [{ command: `curl -H "Authorization: Bearer ${leaked}"`, exitCode: 0 }],
      api_key: leaked,
    });
    rt.appendEvent(dir, {
      id: "evt_secret",
      timestamp: new Date().toISOString(),
      type: "task.status_changed",
      actor: "primary-backend",
      task: "task_secret",
      metadata: { task: "task_secret", api_key: leaked, note: `used ${leaked}` },
    });
    rt.journalAction(dir, { type: "test.leak", subject: "task_secret", token: leaked, detail: `bearer ${leaked}` });

    const handoff = readFileSync(join(dir, ".ace", "handoffs", "task_secret", "1.json"), "utf8");
    const events = readFileSync(join(dir, ".ace", "events.jsonl"), "utf8");
    const actions = readFileSync(join(dir, ".ace", "actions.jsonl"), "utf8");
    for (const [name, text] of [["handoff", handoff], ["events", events], ["actions", actions]]) {
      assert.equal(text.includes(leaked), false, `the secret leaked into ${name}`);
    }
    assert.match(handoff, /<redacted>/);
  });
});

test("the budget is visible to the governor and a full crew cannot be added to", () => {
  withGovernance({}, ({ dir, effective, crew }) => {
    for (const id of ["w1", "w2", "w3", "w4"]) {
      rt.upsertAgent(dir, { id, role: "worker", project: "primary", status: "working", runtime: "fake" });
    }
    const verdict = canStart(effective, rt.getAgentRecords(dir), { runtime: "fake" });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.code, "BUDGET_EXHAUSTED");

    const report = governorCycle(dir, effective, { apply: false, crew, env: {} });
    assert.equal(report.budget.occupied, 4);
    assert.equal(report.budget.limit, 4);
    assert.equal(report.budget.available, 0);
  });
});
