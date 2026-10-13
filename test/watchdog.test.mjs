import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  watchdogCycle,
  watchdogStart,
  watchdogStatus,
  watchdogStop,
} from "../lib/watchdog.mjs";
import * as rt from "../lib/runtime.mjs";

/* Deterministic watchdog tests: explicit clocks, no spawned processes, no
 * credentials, no network. Provider health is probed against an EMPTY env, so
 * a provider that requires a credential is unusable in these tests by design —
 * which is exactly how the "skip an unusable fallback" case is exercised. */

const STALE_NOW = () => Date.now() + 10 * 60 * 1000;

function makeConfig(overrides = {}) {
  return {
    spec: "ace/v1",
    roles: {
      governor: { role: "governor", scope: "environment" },
      supervisors: [{ role: "supervisor", project: "primary", workspace: "." }],
      workers: [],
    },
    concurrency: { max_active_agents: 4 },
    models: {
      default: { provider: "opencode", model: "fleet-1" },
      routes: {
        governor: {
          primary: { provider: "opencode", model: "fleet-1" },
          fallbacks: [{ provider: "fake", model: "fake-1" }],
        },
      },
    },
    adapters: { "agent-runtime": { provider: "local" }, provider: { provider: "opencode" } },
    recovery: { stale_heartbeat_seconds: 90, lease_seconds: 120, cooldown_seconds: 60, max_restarts: 3 },
    watchdog: { enabled: true, interval_seconds: 60, restarts_allowed: 3, cooldown_seconds: 120 },
    ...overrides,
  };
}

function withWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ace-watchdog-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** File list + size + mtime, so "wrote nothing" is provable rather than assumed. */
function treeSnapshot(root) {
  const out = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) {
        out.push(`${full}/`);
        walk(full);
      } else {
        const st = statSync(full);
        out.push(`${full} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

function healthyGovernor(dir, extra = {}) {
  return rt.writeHeartbeat(dir, { agent: "governor", role: "governor", status: "working", ...extra });
}

/** Write the watchdog state file directly, to stand in for a running loop. */
function writeWatchdogState(dir, state) {
  mkdirSync(join(dir, ".ace"), { recursive: true });
  writeFileSync(join(dir, ".ace", "watchdog.json"), JSON.stringify(state, null, 2));
}

test("a healthy governor produces no action and writes nothing", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    healthyGovernor(dir);
    const before = treeSnapshot(join(dir, ".ace"));

    const report = watchdogCycle(dir, config, { nowMs: Date.now(), env: {} });

    assert.equal(report.governor.alive, true);
    assert.equal(report.action, null);
    assert.equal(report.ok, true);
    assert.equal(rt.readRoute(dir, "governor"), null);
    assert.equal(rt.readLease(dir, "watchdog:governor"), null);
    assert.deepEqual(treeSnapshot(join(dir, ".ace")), before, "a healthy cycle must not touch the workspace");
  });
});

test("a stale governor is failed over to the next validated route", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    healthyGovernor(dir);

    const report = watchdogCycle(dir, config, { nowMs: STALE_NOW(), env: {} });

    assert.equal(report.governor.alive, false);
    assert.equal(report.governor.routeLabel, "opencode:fleet-1");
    assert.equal(report.action.type, "route.replace");
    assert.equal(report.action.ok, true);
    assert.equal(report.action.to, "fake:fake-1");

    const written = rt.readRoute(dir, "governor").route;
    assert.equal(written.provider, "fake");
    assert.equal(written.model, "fake-1");
    assert.notEqual(rt.readCheckpoint(dir, "governor"), null, "state is preserved before the route changes");
    assert.equal(rt.readLease(dir, "watchdog:governor"), null, "the lease is released");
    assert.equal(report.action.delivered, false, "no delivery function was configured");
  });
});

test("a dead governor pid is detected even when its heartbeat file is fresh", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    healthyGovernor(dir, { pid: 999_999_999 });

    const report = watchdogCycle(dir, config, { nowMs: Date.now(), env: {} });

    assert.equal(report.governor.stale, false, "the heartbeat itself is not stale");
    assert.equal(report.governor.pidAlive, false);
    assert.equal(report.governor.alive, false, "a heartbeat without a process is not liveness");
    assert.equal(report.action.type, "route.replace");
    assert.match(report.note, /is gone/);
  });
});

test("the governor is treated as absent when it has never run here", () => {
  withWorkspace((dir) => {
    const report = watchdogCycle(dir, makeConfig(), { nowMs: Date.now(), env: {} });
    assert.equal(report.governor.alive, false);
    assert.match(report.note, /has never run here/);
  });
});

test("an exhausted route chain escalates instead of writing a route", () => {
  withWorkspace((dir) => {
    const config = makeConfig({
      models: { default: { provider: "opencode", model: "fleet-1" }, routes: {} },
    });
    healthyGovernor(dir);

    const report = watchdogCycle(dir, config, { nowMs: STALE_NOW(), env: {} });

    assert.equal(report.action.type, "escalate");
    assert.equal(report.action.code, "CHAIN_EXHAUSTED");
    assert.equal(report.ok, false);
    assert.equal(report.escalations.length, 1);
    assert.equal(report.escalations[0].needsOperator, true);
    assert.equal(rt.readRoute(dir, "governor"), null);
    assert.equal(rt.readLease(dir, "watchdog:governor"), null);
  });
});

test("an unusable fallback is skipped in favour of a validated one", () => {
  withWorkspace((dir) => {
    const config = makeConfig({
      models: {
        default: { provider: "opencode", model: "fleet-1" },
        routes: {
          governor: {
            primary: { provider: "opencode", model: "fleet-1" },
            fallbacks: [
              { provider: "anthropic", model: "claude-x" },
              { provider: "fake", model: "fake-1" },
            ],
          },
        },
      },
    });
    healthyGovernor(dir);

    const report = watchdogCycle(dir, config, { nowMs: STALE_NOW(), env: {} });

    assert.equal(report.action.to, "fake:fake-1");
    assert.deepEqual(report.action.checks.map((c) => c.ok), [false, true], "the credential-less candidate was checked and rejected");
  });
});

test("the lease makes the watchdog a single owner", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    const nowMs = Date.now();
    const held = rt.acquireLease(dir, "watchdog:governor", { owner: "another-watchdog", ttlSeconds: 3600, nowMs });
    assert.equal(held.ok, true);
    healthyGovernor(dir);

    const report = watchdogCycle(dir, config, { nowMs: STALE_NOW(), env: {} });

    assert.equal(report.action.ok, false);
    assert.equal(report.action.code, "LEASE_HELD");
    assert.match(report.action.reason, /LEASE_HELD/);
    assert.equal(rt.readRoute(dir, "governor"), null, "a competing recovery must not switch the route");
  });
});

test("recovery is bounded: the restart budget escalates instead of thrashing", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    const nowMs = STALE_NOW();
    healthyGovernor(dir);
    for (let i = 0; i < 3; i += 1) {
      rt.journalAction(dir, {
        type: "watchdog.route.replace",
        subject: "governor",
        from: "opencode:fleet-1",
        to: "fake:fake-1",
        at: new Date(nowMs - 10_000).toISOString(),
      });
    }

    const report = watchdogCycle(dir, config, { nowMs, env: {} });

    assert.equal(report.bounded.ok, false);
    assert.equal(report.action.type, "escalate");
    assert.ok(
      ["RESTART_BUDGET_EXHAUSTED", "COOLDOWN_ACTIVE"].includes(report.action.code),
      `expected a bounding escalation, got ${report.action.code}`,
    );
    assert.equal(report.escalations[0].needsOperator, true);
    assert.equal(rt.readRoute(dir, "governor"), null, "nothing new was written");
  });
});

test("a dry run reports the plan and writes nothing", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    healthyGovernor(dir);
    const before = treeSnapshot(join(dir, ".ace"));

    const report = watchdogCycle(dir, config, { nowMs: STALE_NOW(), env: {}, apply: false });

    assert.equal(report.applied, false);
    assert.equal(report.action.type, "route.replace");
    assert.equal(report.action.planned, true);
    assert.equal(report.action.to, "fake:fake-1");
    assert.equal(report.action.ok, true);
    assert.deepEqual(treeSnapshot(join(dir, ".ace")), before, "a dry run must not write state");
  });
});

test("recovery never claims a restart that did not happen", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    healthyGovernor(dir);

    const recorded = watchdogCycle(dir, config, { nowMs: STALE_NOW(), env: {} });
    assert.equal(recorded.action.delivered, false);
    assert.match(recorded.action.delivery, /no process was restarted/);
    assert.ok(recorded.checksNotRun.some((c) => /no delivery function/i.test(c)));
  });

  withWorkspace((dir) => {
    const config = makeConfig();
    healthyGovernor(dir);
    let asked = null;
    const report = watchdogCycle(dir, config, {
      nowMs: STALE_NOW(),
      env: {},
      deliver: ({ action, governor }) => {
        asked = { type: action.type, governor: governor.agent };
        return { ok: true, detail: "restart delivered by the test harness" };
      },
    });
    assert.equal(asked.type, "route.replace");
    assert.equal(asked.governor, "governor");
    assert.equal(report.action.delivered, true);
    assert.match(report.action.delivery, /delivered by the test harness/);
  });
});

test("the loop is started, reported and stopped without spawning in tests", () => {
  withWorkspace((dir) => {
    const config = makeConfig();

    const started = watchdogStart(dir, config, { spawn: false });
    assert.equal(started.started, true);
    assert.equal(started.spawned, false);
    assert.equal(started.state, "RUNNING");

    const status = watchdogStatus(dir, config);
    assert.equal(status.state, "RUNNING");
    assert.equal(status.running, false, "nothing was actually spawned");
    assert.match(status.note, /has never run here/);
    assert.equal(status.restarts, 0);
    assert.equal(status.maxRestarts, 3);
    assert.equal(status.cooldownSeconds, 120);

    const stopped = watchdogStop(dir, config);
    assert.equal(stopped.wasRunning, false);
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.state, "IDLE");
    assert.equal(watchdogStatus(dir, config).state, "IDLE");
  });
});

test("starting twice does not create a second loop", () => {
  withWorkspace((dir) => {
    const config = makeConfig();
    // A live process THIS TEST OWNS stands in for an already-running loop. Using
    // an arbitrary live pid would risk signalling something that matters, so the
    // only pid in play is a child the test started and then cleans up.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      writeWatchdogState(dir, {
        version: 1,
        state: "RUNNING",
        pid: child.pid,
        intervalSeconds: 60,
        cycleCount: 0,
        history: [],
      });

      const second = watchdogStart(dir, config, { spawn: false });
      assert.equal(second.started, false, "a running loop must not be duplicated");
      assert.equal(second.alreadyRunning, true);
      assert.equal(second.pid, child.pid);
      assert.equal(watchdogStatus(dir, config).running, true);

      const stopped = watchdogStop(dir, config);
      assert.equal(stopped.wasRunning, true);
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.state, "IDLE");
      // Liveness right after SIGTERM is racy, so assert the recorded state.
      assert.equal(watchdogStatus(dir, config).pid, null);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
