import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, mergeLayers } from "../lib/config.mjs";
import * as rt from "../lib/runtime.mjs";
import { botStatus, intake, inbox, deliveries, deliverPending } from "../lib/bots.mjs";

/* Management bots are an experimental sidecar: off by default, and unable to
 * bypass ACE's budget, permissions or audit. These tests use no network, no
 * credentials and no process spawning. */

const SECRET = "sk-live-abcdefghijklmnop";

const BOT_COMPLETE = {
  enabled: true,
  provider: "gitbot",
  // Loopback, because upstream documents no authentication of its own: a
  // remote endpoint needs HTTPS, a credential and an explicit opt-in.
  endpoint: "http://127.0.0.1:8787/hook",
  identity: "ace-gitbot",
  secret_ref: "gitbot_token",
  projects: { "gitbot:repo-1": "primary" },
  permissions: ["gitbot"],
  delivery: { max_attempts: 3, backoff_seconds: 0 },
};

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ace-bots-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bots-ws", ace: aceKey({}) }, null, 2));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function aceKey(overrides) {
  return {
    spec: "ace/v1",
    name: "bots-ws",
    orchestrator: { runtime: "local", role: "governor" },
    agents: { workers: [{ role: "backend" }] },
    ...overrides,
  };
}

/** Merge the built-in defaults with a project layer directly — deterministic,
 * and independent of any ~/.ace installation profile on the test machine. */
function configFor(overrides = {}) {
  const { effective } = mergeLayers({ defaults: defaultConfig(), project: aceKey(overrides) });
  return effective;
}

function request(over = {}) {
  return {
    request_id: "req-1",
    source: "gitbot",
    project: "gitbot:repo-1",
    title: "implement the ingest endpoint",
    goal: "the endpoint exists and its tests pass",
    requester: { id: "gitbot-user" },
    ...over,
  };
}

function bots(kind = BOT_COMPLETE) {
  return { experimental: { management_bots: kind } };
}

test("management bots are off by default and create nothing", () => {
  withDir((dir) => {
    const config = configFor(); // no experimental block anywhere
    const status = botStatus(config, {});
    assert.equal(status.enabled, false);
    assert.equal(status.ready, false);
    assert.equal(status.failClosed, true);
    assert.match(status.reason, /disabled by default/);

    const result = intake(dir, config, request());
    assert.equal(result.accepted, false);
    assert.equal(result.code, "BOTS_DISABLED");
    assert.equal(result.taskId, null);
    assert.equal(existsSync(join(dir, ".ace", "tasks")), false, "no task may be created while the feature is off");
  });
});

test("an enabled but incomplete connection is refused, never accepted", () => {
  withDir((dir) => {
    const incomplete = {
      enabled: true,
      provider: "gitbot",
      endpoint: "http://127.0.0.1:8787/hook",
      identity: "ace-gitbot",
      // no projects mapping, no secret_ref
    };
    const config = configFor(bots(incomplete));
    const status = botStatus(config, {});
    assert.equal(status.enabled, true);
    assert.equal(status.ready, false);
    assert.equal(status.connection.configured, false);

    const result = intake(dir, config, request());
    assert.equal(result.accepted, false);
    assert.equal(result.code, "BOTS_MISCONFIGURED");
    assert.equal(existsSync(join(dir, ".ace", "tasks")), false);
  });
});

test("identity and source authorization are enforced", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));

    const noRequester = intake(dir, config, request({ requester: undefined }));
    assert.equal(noRequester.code, "UNAUTHORIZED");

    const wrongSource = intake(dir, config, request({ source: "someone-elses-bot" }));
    assert.equal(wrongSource.code, "UNAUTHORIZED");
    assert.match(wrongSource.reason, /permissions/);

    assert.equal(rt.listTaskRecords(dir).length, 0);
  });
});

test("project mapping and request schema are enforced", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));

    assert.equal(intake(dir, config, request({ project: "unknown" })).code, "UNKNOWN_PROJECT");
    assert.equal(intake(dir, config, request({ request_id: "" })).code, "BAD_REQUEST");
    assert.equal(intake(dir, config, request({ title: "  " })).code, "BAD_REQUEST");
    assert.equal(rt.listTaskRecords(dir).length, 0);
  });
});

test("approval-gated actions need an explicit approval", () => {
  withDir((dir) => {
    const config = configFor(bots({ ...BOT_COMPLETE, approvals: ["deploy"] }));

    const pending = intake(dir, config, request({ request_id: "req-deploy", action: "deploy" }));
    assert.equal(pending.code, "APPROVAL_REQUIRED");
    assert.equal(rt.listTaskRecords(dir).length, 0);

    const approved = intake(dir, config, request({ request_id: "req-deploy", action: "deploy", approved: true }));
    assert.equal(approved.accepted, true);
    assert.equal(rt.listTaskRecords(dir).length, 1);
  });
});

test("a valid request becomes exactly one ACE task", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));
    const result = intake(dir, config, request());

    assert.equal(result.accepted, true);
    assert.equal(result.code, "ACCEPTED");
    assert.equal(result.duplicate, false);
    assert.ok(result.taskId);

    const tasks = rt.listTaskRecords(dir);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].project, "primary");
    assert.equal(tasks[0].origin, "bot:gitbot");
    assert.equal(tasks[0].title, "implement the ingest endpoint");
    assert.deepEqual(tasks[0].acceptance_criteria, []);

    const records = inbox(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].taskId, result.taskId);
  });
});

test("a repeated request_id is idempotent and creates no second task", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));
    const first = intake(dir, config, request());
    const second = intake(dir, config, request());

    assert.equal(second.accepted, false);
    assert.equal(second.code, "DUPLICATE");
    assert.equal(second.duplicate, true);
    assert.equal(second.taskId, first.taskId);
    assert.equal(rt.listTaskRecords(dir).length, 1);
  });
});

test("a request cannot exceed the active-agent budget", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));
    for (let i = 1; i <= 4; i++) {
      rt.upsertAgent(dir, { id: `primary-backend-${i}`, role: "worker", project: "primary", runtime: "local", status: "working" });
    }

    const result = intake(dir, config, request());
    assert.equal(result.accepted, false);
    assert.equal(result.code, "BUDGET_EXHAUSTED");
    assert.match(result.reason, /active-agent budget/);
    assert.equal(rt.listTaskRecords(dir).length, 0, "a budget refusal must not create work");

    // Raising the limit is a configuration change, not an intake trick.
    const raised = configFor({ ...bots(BOT_COMPLETE), concurrency: { max_active_agents: 6 } });
    assert.equal(intake(dir, raised, request({ request_id: "req-2" })).accepted, true);
  });
});

test("a dry run performs every check and writes nothing", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));
    const result = intake(dir, config, request(), { apply: false });

    assert.equal(result.accepted, true);
    assert.equal(result.planned, true);
    assert.equal(result.taskId, null);
    assert.equal(existsSync(join(dir, ".ace", "bots")), false);
    assert.equal(rt.listTaskRecords(dir).length, 0);
  });
});

test("a delivery failure is reported and never undoes the task", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));
    const result = intake(dir, config, request(), { deliver: () => ({ ok: false, detail: "gitbot returned 502" }) });

    assert.equal(result.accepted, true);
    assert.equal(result.delivery.ok, false);
    assert.equal(result.delivery.attempts, 1);
    assert.equal(result.delivery.lastError, "gitbot returned 502");
    assert.equal(typeof result.delivery.nextRetryAt, "string");
    assert.equal(rt.listTaskRecords(dir).length, 1);

    const pending = deliveries(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "failed");
  });
});

test("deliverPending retries the same task instead of creating a new one", () => {
  withDir((dir) => {
    const config = configFor(bots(BOT_COMPLETE));
    const first = intake(dir, config, request(), { deliver: () => ({ ok: false, detail: "timeout" }) });
    assert.equal(first.delivery.ok, false);

    const retry = deliverPending(dir, config, () => ({ ok: true }), { nowMs: Date.now() });
    assert.equal(retry.attempted, 1);
    assert.equal(retry.delivered, 1);
    assert.equal(rt.listTaskRecords(dir).length, 1, "a retry must never create a second task");
    assert.equal(deliveries(dir)[0].status, "delivered");
  });
});

test("a secret in an inbound request never reaches a task, event or action record", () => {
  withDir((dir) => {
    rt.storeSecret(dir, "gitbot_token", SECRET);
    const config = configFor(bots(BOT_COMPLETE));
    const result = intake(dir, config, request({ goal: `use ${SECRET} to reach the API`, title: `rotate ${SECRET}` }));

    assert.equal(result.accepted, true);
    const taskFile = readFileSync(join(dir, ".ace", "tasks", `${result.taskId}.json`), "utf8");
    const events = readFileSync(join(dir, ".ace", "events.jsonl"), "utf8");
    const actions = readFileSync(join(dir, ".ace", "actions.jsonl"), "utf8");
    const record = readFileSync(join(dir, ".ace", "bots", "inbox", "req-1.json"), "utf8");

    for (const [name, text] of [["task", taskFile], ["events", events], ["actions", actions], ["inbox", record]]) {
      assert.equal(text.includes(SECRET), false, `${name} leaked the secret value`);
      assert.equal(text.includes("sk-live-"), false, `${name} leaked an sk- token shape`);
    }
    assert.match(taskFile, /<redacted>/, "the payload should be visibly redacted, not silently dropped");
  });
});

test("a remote endpoint fails closed until HTTPS, a credential and an explicit opt-in are all present", () => {
  withDir((dir) => {
    const remote = { ...BOT_COMPLETE, endpoint: "https://gitbot.example/hook" };

    // The default provider documents no authentication of its own, so network
    // position is never treated as trust.
    const withoutOptIn = configFor(bots(remote));
    const status = botStatus(withoutOptIn, {});
    assert.equal(status.ready, false);
    assert.match(status.reason, /allow_remote_endpoint/);

    const refused = intake(dir, withoutOptIn, request());
    assert.equal(refused.accepted, false);
    assert.equal(refused.code, "BOTS_MISCONFIGURED");
    assert.equal(existsSync(join(dir, ".ace", "tasks")), false, "a refused intake creates nothing");

    // Plain http to a remote host stays refused even with the opt-in.
    const insecure = configFor(bots({ ...remote, endpoint: "http://gitbot.example/hook", allow_remote_endpoint: true }));
    assert.equal(intake(dir, insecure, request()).code, "BOTS_MISCONFIGURED");

    // A fully specified remote deployment is accepted.
    const opted = configFor(bots({ ...remote, allow_remote_endpoint: true }));
    const readyStatus = botStatus(opted, {});
    assert.equal(readyStatus.ready, true, readyStatus.reason);
    const accepted = intake(dir, opted, request());
    assert.equal(accepted.accepted, true, accepted.reason);
  });
});
