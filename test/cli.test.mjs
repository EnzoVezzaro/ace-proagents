import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* Zero-dependency CLI tests: built-in node:test runner only.
 * CI (.github/workflows/ci.yml) runs `node --test test/` on every push. */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "ace.mjs");

function ace(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function withWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ace-test-"));
  try {
    assert.equal(ace(["init", "--name", "ws"], dir).status, 0, "init failed");
    fn(join(dir, "ws"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--help prints the command table", () => {
  const r = ace(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: ace <command>/);
  assert.match(r.stdout, /Commands:/);
  assert.match(r.stdout, /\bdoctor\b/);
  assert.match(r.stdout, /\binit\b/);
});

test("unknown command exits non-zero", () => {
  const r = ace(["definitely-not-a-command"]);
  assert.notEqual(r.status, 0);
});

test("doctor --json reports ok with structured checks", () => {
  const r = ace(["doctor", "--json"]);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  for (const check of report.checks) {
    assert.equal(typeof check.name, "string");
    assert.equal(typeof check.ok, "boolean");
  }
});

test("init scaffolds a self-contained workspace", () => {
  withWorkspace((ws) => {
    const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8"));
    assert.equal(pkg.ace.spec, "ace/v1");
    assert.ok(existsSync(join(ws, "ace-lock.json")));
    assert.ok(existsSync(join(ws, "ace.mjs")));
    assert.ok(existsSync(join(ws, "lib", "pkg.mjs")));
  });
});

test("workspace commands run clean after init", () => {
  withWorkspace((ws) => {
    const commands = [
      ["install"],
      ["status"],
      ["list"],
      ["events"],
      ["context", "--json"],
      ["compose", "--json"],
      ["doctor"],
    ];
    for (const args of commands) {
      const r = ace(args, ws);
      assert.equal(r.status, 0, `${args.join(" ")} exited ${r.status}: ${r.stderr}`);
    }
  });
});

test("compose --json reflects the scaffolded spec", () => {
  withWorkspace((ws) => {
    const r = ace(["compose", "--json"], ws);
    assert.equal(r.status, 0);
    const spec = JSON.parse(r.stdout);
    assert.equal(spec.spec, "ace/v1");
    assert.equal(spec.name, "ws");
    assert.equal(spec.orchestrator.runtime, "opencode");
  });
});

/* --------------------------------------------------------------------- *
 * verify + autopilot — the PAW-parity always-on surface (ace.mjs)
 * --------------------------------------------------------------------- */

test("help advertises verify and autopilot", () => {
  const r = ace(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\bverify\b/);
  assert.match(r.stdout, /\bautopilot\b/);
  assert.match(r.stdout, /--mission/);
});

test("verify --json reports structured checks with an honest pass when none are configured", () => {
  withWorkspace((ws) => {
    const r = ace(["verify", "--json"], ws);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.command, "verify");
    assert.equal(doc.ok, true);
    assert.equal(typeof doc.note, "string");
    assert.deepEqual(doc.checks.map((c) => c.name), ["lint", "typecheck", "test", "build"]);
    for (const check of doc.checks) {
      assert.equal(check.configured, false);
      assert.equal(check.ok, true);
    }
  });
});

test("verify runs configured scripts and fails on the first non-zero exit", () => {
  withWorkspace((ws) => {
    const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8"));
    pkg.scripts = {
      lint: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(1)\"",
    };
    writeFileSync(join(ws, "package.json"), JSON.stringify(pkg, null, 2));

    const r = ace(["verify", "--json"], ws);
    assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, false);
    const byName = Object.fromEntries(doc.checks.map((c) => [c.name, c]));
    assert.equal(byName.lint.ok, true);
    assert.equal(byName.test.ok, false);
    assert.equal(byName.test.configured, true);
    assert.equal(byName.build.configured, false);
  });
});

test("verify rejects an unknown target with COMMAND_NOT_FOUND", () => {
  withWorkspace((ws) => {
    const r = ace(["verify", "deploy"], ws);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /COMMAND_NOT_FOUND/);
    assert.match(r.stderr, /Unknown verify target: deploy/);
  });
});

test("autopilot fails closed outside an initialized workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-test-"));
  try {
    const r = ace(["autopilot", "status", "--json"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PROJECT_NOT_INITIALIZED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autopilot run --max-cycles 1 --json executes one full state-machine cycle", () => {
  withWorkspace((ws) => {
    const r = ace(["autopilot", "run", "--max-cycles", "1", "--json"], ws);
    assert.equal(r.status, 0, `${r.status}: ${r.stderr}`);

    // stdout must be exactly ONE document: verify/checkpoint never print.
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.command, "autopilot cycle");
    assert.deepEqual(doc.cycle.transitions, [
      "PLAN",
      "EXECUTE",
      "VERIFY",
      "CHECKPOINT",
      "SUCCESS",
      "REPLAN",
    ]);
    assert.equal(doc.cycle.verifyOk, true);
    assert.equal(doc.cycle.ok, true);

    const state = JSON.parse(readFileSync(join(ws, ".ace", "autopilot.json"), "utf8"));
    assert.equal(state.cycleCount, 1);
    assert.notEqual(state.lastCycle, null);
    assert.equal(state.history.length, 1);
    assert.ok(["SUCCESS", "FAIL"].includes(state.state));
  });
});

test("autopilot run exits non-zero when a cycle fails", () => {
  withWorkspace((ws) => {
    const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8"));
    pkg.scripts = { test: "node -e \"process.exit(1)\"" };
    writeFileSync(join(ws, "package.json"), JSON.stringify(pkg, null, 2));

    const r = ace(["autopilot", "run", "--max-cycles", "1", "--json"], ws);
    assert.equal(r.status, 1);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.cycle.ok, false);
    assert.deepEqual(doc.cycle.transitions, [
      "PLAN",
      "EXECUTE",
      "VERIFY",
      "CHECKPOINT",
      "FAIL",
      "REPLAN",
    ]);
  });
});

test("autopilot on starts a detached loop, status reports it, off stops it", async () => {
  withWorkspace((ws) => {
    const on = ace(
      ["autopilot", "on", "--interval", "60", "--mission", "showcase the loop", "--json"],
      ws
    );
    assert.equal(on.status, 0, `${on.status}: ${on.stderr}`);
    const onDoc = JSON.parse(on.stdout);
    assert.equal(onDoc.loopRunning, true);
    assert.equal(typeof onDoc.pid, "number");
    assert.equal(onDoc.mission, "showcase the loop");
    assert.equal(onDoc.missionDecomposed, false);

    // The detached child runs its first cycle right away; give it a moment.
    const deadline = Date.now() + 10_000;
    let statusDoc;
    do {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      const status = ace(["autopilot", "status", "--json"], ws);
      statusDoc = JSON.parse(status.stdout);
    } while (statusDoc.cycleCount < 1 && Date.now() < deadline);
    assert.equal(statusDoc.loopRunning, true);
    assert.ok(statusDoc.cycleCount >= 1, "the detached loop should have completed a cycle");
    assert.equal(statusDoc.mission, "showcase the loop");

    const off = ace(["autopilot", "off", "--json"], ws);
    assert.equal(off.status, 0, `${off.status}: ${off.stderr}`);
    const offDoc = JSON.parse(off.stdout);
    assert.equal(offDoc.stopped, true);
    assert.equal(offDoc.state, "IDLE");
    assert.equal(offDoc.pid, null);

    const after = JSON.parse(ace(["autopilot", "status", "--json"], ws).stdout);
    assert.equal(after.loopRunning, false);
    assert.equal(after.state, "IDLE");
  });
});

test("autopilot rejects an unknown subcommand with COMMAND_NOT_FOUND", () => {
  withWorkspace((ws) => {
    const r = ace(["autopilot", "warp"], ws);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /COMMAND_NOT_FOUND/);
    assert.match(r.stderr, /Unknown autopilot subcommand: warp/);
  });
});
