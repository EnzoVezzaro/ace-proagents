import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkContract } from "../lib/adapters/index.mjs";
import {
  allFakes,
  createFakeHandoff,
  createFakeMultiplexer,
  createFakeProvider,
  createFakeVerification,
} from "../lib/adapters/impl.mjs";
import { verifyHandoff, writeHandoff } from "../lib/runtime.mjs";

/* The fakes are the reason the orchestration tests can run with no credential
 * and no provider cost, so they are held to the same contract as a real
 * adapter: if one drifts, the test suite is testing a fiction. */

test("every fake adapter satisfies the adapter contract", () => {
  const fakes = allFakes();
  const kinds = Object.keys(fakes);
  assert.ok(kinds.length >= 7, `expected at least 7 fake kinds, got ${kinds.length}`);
  for (const [kind, adapter] of Object.entries(fakes)) {
    const verdict = checkContract(adapter);
    assert.equal(verdict.ok, true, `${kind} is missing: ${verdict.missing.join(", ")}`);
    assert.equal(adapter.kind, kind, `${kind} reports kind ${adapter.kind}`);
    assert.equal(typeof adapter.describe(), "string");
    assert.equal(adapter.name, "fake");
  }
});

test("fake provider is deterministic and counts its calls", () => {
  const provider = createFakeProvider();
  const first = provider.ops.complete({ prompt: "summarise the diff", model: "fake-fast" });
  const second = provider.ops.complete({ prompt: "summarise the diff", model: "fake-fast" });
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.notEqual(first.output, provider.ops.complete({ prompt: "a different prompt" }).output);
  assert.deepEqual(provider.ops.models(), provider.ops.models());
  assert.equal(provider.status().calls, 3);
});

test("fake provider fault injection is visible and never throws", () => {
  const provider = createFakeProvider({ failure: "quota_exhausted" });
  const health = provider.health();
  assert.equal(health.ok, false);
  assert.match(health.detail, /quota_exhausted/);

  const completion = provider.ops.complete({ prompt: "anything" });
  assert.equal(completion.ok, false);
  assert.equal(completion.code, "PROVIDER_UNAVAILABLE");
  assert.match(completion.detail, /quota_exhausted/);
});

test("fake multiplexer round-trips panes and can refuse a start", () => {
  const multiplexer = createFakeMultiplexer({ failStart: ["busy-worker"] });

  const started = multiplexer.ops.start({ name: "worker-a", kind: "worker" });
  assert.equal(started.ok, true);
  assert.equal(typeof started.id, "string");
  assert.equal(multiplexer.ops.list().length, 1);

  assert.equal(multiplexer.ops.rename(started.id, "worker-b").ok, true);
  assert.equal(multiplexer.ops.list()[0].name, "worker-b");

  const refused = multiplexer.ops.start({ name: "busy-worker" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "agent_pane_busy");
  assert.equal(multiplexer.ops.list().length, 1, "a refused start must not create a pane");

  assert.equal(multiplexer.ops.stop(started.id).ok, true);
  assert.equal(multiplexer.ops.list().length, 0);
  assert.equal(multiplexer.ops.stop("pane-missing").code, "NO_PANE");
});

test("fake handoff without a workspace reports NO_WORKSPACE instead of pretending", () => {
  const handoff = createFakeHandoff();
  assert.equal(handoff.health().ok, false);

  for (const call of [
    handoff.ops.assign({ id: "task_1" }),
    handoff.ops.report({ task: "task_1" }),
    handoff.ops.verify("task_1"),
    handoff.ops.list("task_1"),
  ]) {
    assert.equal(call.ok, false);
    assert.equal(call.code, "NO_WORKSPACE");
  }
});

test("fake handoff round-trips the real durable artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-fake-handoff-"));
  try {
    const handoff = createFakeHandoff({ dir });
    assert.equal(handoff.health().ok, true);

    const reported = handoff.ops.report({
      task: "task_1",
      attempt: 1,
      from: "worker-a",
      status: "complete",
      summary: "moved the resolver into lib/resolver.mjs",
      changed_files: ["lib/resolver.mjs"],
      commands: [{ cmd: "node --test test/", exitCode: 0 }],
    });
    assert.equal(reported.ok, true);
    assert.equal(reported.handoff.status, "complete");
    assert.equal(reported.handoff.attempt, 1);

    // It is really on disk: writing then reading it back through the adapter.
    const verdict = handoff.ops.verify("task_1");
    assert.equal(verdict.ok, true, verdict.errors.join("; "));
    assert.equal(verdict.handoff.summary, "moved the resolver into lib/resolver.mjs");
    assert.equal(handoff.ops.list("task_1").handoffs.length, 1);

    const badReport = handoff.ops.report({ summary: "no task id" });
    assert.equal(badReport.ok, false);
    assert.equal(badReport.code, "BAD_HANDOFF");

    // A completion claim with no evidence is rejected by the real verifier.
    const proof = verifyHandoff(
      writeHandoff(dir, { task: "task_2", attempt: 1, from: "worker-a", status: "complete" }),
    );
    assert.equal(proof.ok, false);
    assert.ok(proof.errors.some((e) => /summary/.test(e)), proof.errors.join("; "));
    assert.ok(proof.errors.some((e) => /verification command/.test(e)), proof.errors.join("; "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fake verification honours the scripted failing checks", () => {
  const verification = createFakeVerification({ fail: ["test"] });
  const lint = verification.ops.run("/tmp/workspace", "lint");
  const testCheck = verification.ops.run("/tmp/workspace", "test");

  assert.equal(lint.ok, true);
  assert.equal(lint.exitCode, 0);
  assert.equal(lint.configured, true);
  assert.equal(testCheck.ok, false);
  assert.equal(testCheck.exitCode, 1);
  assert.deepEqual(verification.status().failing, ["test"]);
});
