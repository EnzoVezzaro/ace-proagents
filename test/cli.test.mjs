import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
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

/* --------------------------------------------------------------------- *
 * Governance surface, driven through the CLI — the interface an operator
 * and a supervisor actually use. Every command asserted here is implemented
 * by lib/cli-governance.mjs and documented in ace --help.
 * --------------------------------------------------------------------- */

/** Run the CLI with an isolated ACE_HOME so a developer's own installation
 *  profile can never change the expected result. */
function aceIso(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ACE_HOME: join(cwd, ".no-installation-profile") },
  });
}

function writeJsonFile(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

test("--help advertises the governance surface", () => {
  const r = ace(["--help"]);
  assert.equal(r.status, 0);
  for (const command of ["config", "crew", "govern", "supervise", "task", "handoff", "watchdog", "bots", "adapters"]) {
    assert.match(r.stdout, new RegExp(`\\b${command}\\b`), `--help does not mention ${command}`);
  }
  assert.match(r.stdout, /Four is the default|max_active_agents/);
});

test("a scaffolded workspace carries every governance module", () => {
  withWorkspace((ws) => {
    for (const file of ["lib/config.mjs", "lib/crew.mjs", "lib/governance.mjs", "lib/cli-governance.mjs", "lib/watchdog.mjs", "lib/bots.mjs"]) {
      assert.ok(existsSync(join(ws, file)), `init did not copy ${file}`);
    }
    assert.ok(existsSync(join(ws, "lib", "adapters", "index.mjs")), "init did not recurse into lib/adapters");
    assert.ok(existsSync(join(ws, "lib", "adapters", "impl.mjs")));
  });
});

test("config check validates the effective configuration and reports the shipped default", () => {
  withWorkspace((ws) => {
    const check = aceIso(["config", "check", "--json"], ws);
    assert.equal(check.status, 0, check.stderr);
    const doc = JSON.parse(check.stdout);
    assert.equal(doc.ok, true);
    assert.deepEqual(doc.errors, []);

    const show = aceIso(["config", "--json"], ws);
    assert.equal(show.status, 0, show.stderr);
    const effective = JSON.parse(show.stdout);
    assert.equal(effective.effective.concurrency.max_active_agents, 4);
    assert.equal(effective.layers.includes("project"), true);
    assert.equal(effective.security.ok, true);
  });
});

test("config set writes a session override that the next resolution honours", () => {
  withWorkspace((ws) => {
    const set = aceIso(["config", "set", "concurrency.max_active_agents=7"], ws);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /session override written/);

    const show = aceIso(["config", "--json", "--resolve"], ws);
    const doc = JSON.parse(show.stdout);
    assert.equal(doc.effective.concurrency.max_active_agents, 7);
    assert.equal(doc.sources["concurrency.max_active_agents"], "session");
  });
});

test("crew reports the roster, the budget and the governor boundary", () => {
  withWorkspace((ws) => {
    const r = aceIso(["crew", "--json"], ws);
    assert.equal(r.status, 0, r.stderr);
    const crew = JSON.parse(r.stdout);
    assert.equal(crew.governor.id, "governor");
    assert.equal(crew.supervisors.length, 1);
    assert.equal(crew.workers.length, 5, "the scaffolded five workers are visible");
    assert.equal(crew.budget.limit, 4);
    assert.equal(crew.budget.occupied, 0);
    assert.match(crew.boundary, /governor → worker is refused/);
  });
});

test("crew spawn is refused once the budget is spent, and allowed again when it is raised", () => {
  withWorkspace((ws) => {
    for (const id of ["a", "b", "c", "d"]) {
      const hb = aceIso(["heartbeat", "--agent", id, "--role", `worker-${id}`, "--status", "working", "--project", "primary"], ws);
      assert.equal(hb.status, 0, hb.stderr);
    }

    const refused = aceIso(["crew", "spawn", "e", "--project", "primary"], ws);
    assert.equal(refused.status, 1, `expected refusal, got ${refused.status}: ${refused.stdout}`);
    assert.match(refused.stderr, /BUDGET_EXHAUSTED/);
    assert.match(refused.stderr, /4\/4/);
    assert.match(refused.stderr, /max_active_agents/);

    assert.equal(aceIso(["config", "set", "concurrency.max_active_agents=6"], ws).status, 0);
    const allowed = aceIso(["crew", "spawn", "e", "--project", "primary", "--json"], ws);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).agent, "primary-e");
  });
});

test("govern on a workspace where nothing is running exits non-zero and names the operator action", () => {
  withWorkspace((ws) => {
    const r = aceIso(["govern", "--json"], ws);
    assert.equal(r.status, 1, `expected an escalation exit code, got ${r.status}: ${r.stdout}`);
    const report = JSON.parse(r.stdout);
    assert.ok(report.detections.some((d) => d.code === "SUPERVISOR_ABSENT"));
    assert.ok(report.escalations.some((e) => e.needsOperator === true));
    assert.ok(report.checksNotRun.length > 0, "the report must disclose what it did not check");
    assert.equal(report.applied, true);
  });
});

test("a dry run of govern writes nothing", () => {
  withWorkspace((ws) => {
    const before = existsSync(join(ws, ".ace")) ? readdirSync(join(ws, ".ace")).sort().join(",") : "<absent>";
    const r = aceIso(["govern", "--dry-run", "--json"], ws);
    assert.equal(r.status, 1, "a dry run still reports the escalation");
    assert.equal(JSON.parse(r.stdout).applied, false);
    const after = existsSync(join(ws, ".ace")) ? readdirSync(join(ws, ".ace")).sort().join(",") : "<absent>";
    assert.equal(after, before, "--dry-run must not create state");
  });
});

test("task and handoff work end to end through the CLI", () => {
  withWorkspace((ws) => {
    const added = aceIso(["task", "add", "ship the smoke feature", "--project", "primary", "--goal", "prove the loop", "--criteria", "tests pass"], ws);
    assert.equal(added.status, 0, added.stderr);
    const taskId = /created (\S+)/.exec(added.stdout)[1];

    const listed = JSON.parse(aceIso(["task", "list", "--json"], ws).stdout);
    assert.equal(listed.count, 1);
    assert.equal(listed.tasks[0].status, "pending");

    assert.equal(aceIso(["task", "claim", taskId, "--agent", "primary-backend"], ws).status, 0);
    assert.equal(aceIso(["task", "claim", taskId, "--agent", "primary-tester"], ws).status, 1, "a second owner is refused");
    assert.equal(aceIso(["task", "start", taskId, "--by", "primary-backend"], ws).status, 0);

    const handoffPath = join(ws, "handoff.json");
    writeJsonFile(handoffPath, {
      from: "primary-backend",
      status: "complete",
      summary: "implemented the feature",
      changed_files: ["src/smoke.mjs"],
      commands: [{ command: "npm test", exitCode: 0 }],
      checks_not_run: ["no integration suite exists"],
      committed: true,
    });
    const submitted = aceIso(["handoff", "submit", taskId, "--file", handoffPath], ws);
    assert.equal(submitted.status, 0, submitted.stderr);
    const verified = aceIso(["handoff", "verify", taskId, "--json"], ws);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verdict.ok, true);

    assert.equal(aceIso(["task", "review", taskId, "--by", "primary-backend"], ws).status, 0);
    const supervised = aceIso(["supervise", "--json"], ws);
    assert.equal(supervised.status, 0, supervised.stderr);
    const report = JSON.parse(supervised.stdout);
    assert.equal(report.verifications[0].accepted, true, JSON.stringify(report.verifications));

    const finished = JSON.parse(aceIso(["task", "show", taskId, "--json"], ws).stdout);
    assert.equal(finished.task.status, "done");
    assert.equal(finished.task.owner, null);
  });
});

test("handoff verify refuses an unevidenced claim", () => {
  withWorkspace((ws) => {
    const added = aceIso(["task", "add", "unsupported", "--project", "primary"], ws);
    const taskId = /created (\S+)/.exec(added.stdout)[1];
    const path = join(ws, "weak.json");
    writeJsonFile(path, { from: "primary-backend", status: "complete", summary: "it works" });
    const submitted = aceIso(["handoff", "submit", taskId, "--file", path], ws);
    assert.equal(submitted.status, 0);
    assert.match(submitted.stdout, /reject/);

    const verified = aceIso(["handoff", "verify", taskId, "--json"], ws);
    assert.equal(verified.status, 1);
    assert.equal(JSON.parse(verified.stdout).verdict.ok, false);
  });
});

test("route set validates the provider before it changes anything, and show reports it", () => {
  withWorkspace((ws) => {
    const unknown = aceIso(["route", "set", "governor", "nope:model", "--reason", "test"], ws);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /INCOMPATIBLE_ADAPTER/);

    const set = aceIso(["route", "set", "governor", "fake:fake-1", "--reason", "primary down"], ws);
    assert.equal(set.status, 0, set.stderr);

    const shown = JSON.parse(aceIso(["route", "show", "governor", "--json"], ws).stdout);
    assert.equal(shown.active.model, "fake-1");
    assert.equal(shown.switches, 1);
  });
});

test("watchdog and bots report honestly, and management bots are off by default", () => {
  withWorkspace((ws) => {
    const watchdog = aceIso(["watchdog", "--json"], ws);
    assert.equal(watchdog.status, 0, watchdog.stderr);
    const w = JSON.parse(watchdog.stdout);
    assert.equal(w.running, false);
    assert.equal(w.governor.alive, false);
    assert.match(w.note, /never run|no governor heartbeat/);

    const cycle = aceIso(["watchdog", "cycle", "--json"], ws);
    assert.equal(cycle.status === 0 || cycle.status === 1, true, cycle.stderr);
    const c = JSON.parse(cycle.stdout);
    assert.equal(c.applied, true);
    if (c.action) {
      // No delivery function is configured on a bare workspace, so no action
      // may claim to have delivered anything.
      assert.notEqual(c.action.delivered, true, `action claims delivery: ${JSON.stringify(c.action)}`);
      assert.ok(typeof c.action.reason === "string" && c.action.reason.length > 0);
    }
    assert.ok(Array.isArray(c.checksNotRun));

    const bots = aceIso(["bots", "--json"], ws);
    assert.equal(bots.status, 0, bots.stderr);
    const b = JSON.parse(bots.stdout);
    assert.equal(b.enabled, false);
    assert.equal(b.ready, false);

    writeJsonFile(join(ws, "request.json"), { request_id: "r1", title: "do a thing", project: "inbound", requester: { id: "alice" } });
    const refused = aceIso(["bots", "intake", "--file", join(ws, "request.json")], ws);
    assert.equal(refused.status, 1, `stdout=${refused.stdout} stderr=${refused.stderr}`);
    assert.match(refused.stdout, /BOTS_DISABLED/);
  });
});

test("adapters lists the registry, audits the contract and reports health", () => {
  withWorkspace((ws) => {
    const audit = aceIso(["adapters", "audit"], ws);
    assert.equal(audit.status, 0, audit.stdout);
    assert.match(audit.stdout, /OK/);

    const health = aceIso(["adapters", "health", "--json"], ws);
    assert.equal(health.status, 0, health.stderr);
    const doc = JSON.parse(health.stdout);
    assert.equal(doc.rows.every((r) => typeof r.ok === "boolean"), true);
    assert.ok(doc.rows.some((r) => r.kind === "provider"));

    const list = aceIso(["adapters", "list", "--kind", "workspace", "--json"], ws);
    assert.equal(list.status, 0);
    assert.ok(JSON.parse(list.stdout).adapters.some((a) => a.name === "git-worktree"));
  });
});

test("restart reconciles an agent whose process is gone", () => {
  withWorkspace((ws) => {
    assert.equal(aceIso(["heartbeat", "--agent", "primary-backend", "--status", "working"], ws).status, 0);
    const restart = aceIso(["restart"], ws);
    assert.equal(restart.status, 0, restart.stderr);
    assert.match(restart.stdout, /Interrupted agents: primary-backend/);
  });
});

test("a heartbeat with no pid claim satisfies the governor, and a dead pid does not", () => {
  withWorkspace((ws) => {
    assert.equal(aceIso(["heartbeat", "--agent", "primary-supervisor", "--role", "supervisor", "--status", "working"], ws).status, 0);

    const clean = aceIso(["govern", "--json"], ws);
    const report = JSON.parse(clean.stdout);
    assert.equal(report.supervisors[0].alive, true, JSON.stringify(report.supervisors[0]));
    assert.equal(report.supervisors[0].pid, null);
    assert.equal(report.detections.some((d) => d.code === "SUPERVISOR_DEAD"), false);
    assert.equal(clean.status, 0, `a live supervisor with no open escalation should exit 0: ${clean.stdout}`);

    // A claimed pid that no longer exists is a failure, fresh heartbeat or not.
    assert.equal(aceIso(["heartbeat", "--agent", "primary-supervisor", "--pid", "999999", "--status", "working"], ws).status, 0);
    const dead = JSON.parse(aceIso(["govern", "--json"], ws).stdout);
    assert.equal(dead.supervisors[0].pid, 999999);
    assert.equal(dead.supervisors[0].alive, false);
    assert.ok(dead.detections.some((d) => d.code === "SUPERVISOR_DEAD"));
  });
});

test("status --json exposes the governance snapshot a UI can consume", () => {
  withWorkspace((ws) => {
    const r = aceIso(["status", "--json"], ws);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.command, "status");
    assert.ok(doc.governance, "the snapshot is the machine-readable surface");
    assert.equal(doc.governance.budget.limit, 4);
    assert.equal(doc.governance.crew.governor.id, "governor");
    assert.equal(doc.governance.crew.workers.length, 5);
    assert.equal(doc.governance.bots.enabled, false);
    assert.equal(doc.governance.configuration.valid, true);
    assert.equal(typeof doc.governance.watchdog.enabled, "boolean");
    assert.equal(JSON.stringify(doc).includes("sk-"), false, "no credential value may be exposed");
  });
});

test("stop reports exactly what it preserves and what it does not kill", () => {
  withWorkspace((ws) => {
    assert.equal(aceIso(["heartbeat", "--agent", "primary-backend", "--status", "working"], ws).status, 0);
    assert.equal(aceIso(["task", "add", "still open", "--project", "primary"], ws).status, 0);

    const stopped = aceIso(["stop", "--json"], ws);
    assert.equal(stopped.status, 0, stopped.stderr);
    const doc = JSON.parse(stopped.stdout);
    assert.equal(doc.status, "stopped");
    assert.deepEqual(doc.killed, [], "stop never claims to have killed an external process");
    assert.deepEqual(doc.preserved.activeAgents, ["primary-backend"]);
    assert.equal(doc.preserved.openTasks.length, 1);

    // and the state really did move
    assert.equal(JSON.parse(aceIso(["status", "--json"], ws).stdout).status, "stopped");
  });
});

/* A streamed --json report (one document per cycle) is split by brace depth,
 * which is how a consumer reads `ace watchdog run --json` and `ace autopilot
 * run --json` alike. */
function splitJsonDocuments(stdout) {
  const docs = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) docs.push(JSON.parse(stdout.slice(start, i + 1)));
    }
  }
  return docs;
}

test("every --json report is a single parseable document, with no prose mixed in", () => {
  withWorkspace((ws) => {
    const added = aceIso(["task", "add", "keep the contract", "--json"], ws);
    const taskId = JSON.parse(added.stdout).task.id;

    // claim and the status transitions used to print a prose line in front of
    // the document, which breaks any consumer that parses stdout.
    const claim = aceIso(["task", "claim", taskId, "--agent", "primary-backend", "--json"], ws);
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(JSON.parse(claim.stdout).command, "task claim");
    assert.equal(JSON.parse(claim.stdout).task.owner, "primary-backend");

    const start = aceIso(["task", "start", taskId, "--by", "primary-backend", "--json"], ws);
    assert.equal(JSON.parse(start.stdout).task.status, "in_progress");

    // A refusal is one document on stderr, with stdout left empty, so a
    // consumer can tell success from failure without reading prose.
    const refusal = aceIso(["task", "integrate", taskId, "--json"], ws);
    assert.equal(refusal.status, 1);
    assert.equal(refusal.stdout, "");
    assert.equal(JSON.parse(refusal.stderr).code, "INVALID_TRANSITION");

    // ...and so is every other mutating subcommand, so a caller can drive the
    // whole surface by parsing stdout.
    const configSet = aceIso(["config", "set", "concurrency.max_active_agents=4", "--json"], ws);
    assert.equal(JSON.parse(configSet.stdout).layer, "session");

    const r2 = aceIso(["heartbeat", "--agent", "primary-frontend", "--status", "working"], ws);
    assert.equal(r2.status, 0, r2.stderr);
    const routeSet = aceIso(["route", "set", "primary-frontend", "opencode:fledge-alpha-free", "--json"], ws);
    assert.equal(routeSet.status, 0, routeSet.stderr);
    const routeDoc = JSON.parse(routeSet.stdout);
    assert.equal(routeDoc.command, "route set");
    assert.equal(routeDoc.route.model, "fledge-alpha-free");

    // the human path still reads like a terminal
    assert.match(aceIso(["task", "add", "human path", "--project", "primary"], ws).stdout, /created task_/);
    assert.match(aceIso(["config", "set", "concurrency.max_active_agents=4"], ws).stdout, /session override written/);
  });
});

test("watchdog run reports every cycle and stops at --max-cycles", () => {
  withWorkspace((ws) => {
    const streamed = aceIso(["watchdog", "run", "--max-cycles", "2", "--interval", "1", "--json"], ws);
    const docs = splitJsonDocuments(streamed.stdout);
    assert.equal(docs.length, 2, `one document per cycle, got ${docs.length}`);
    assert.deepEqual(docs.map((d) => d.cycle), [1, 2]);
    for (const doc of docs) {
      assert.equal(doc.command, "watchdog cycle");
      assert.equal(typeof doc.report.governor.alive, "boolean");
      assert.ok(Array.isArray(doc.report.checksNotRun));
    }

    // The human path is not silent: a bounded run says what it did.
    const human = aceIso(["watchdog", "run", "--max-cycles", "1"], ws);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /watchdog cycle 1/);
    assert.match(human.stdout, /watchdog stopped after 1 cycle/);
  });
});

test("bots enable is reported as a document and says what is still missing", () => {
  withWorkspace((ws) => {
    const enabled = aceIso(["bots", "enable", "gitbot", "--json"], ws);
    assert.equal(enabled.status, 1, "an enabled intake with missing settings needs an operator");
    const doc = JSON.parse(enabled.stdout);
    assert.equal(doc.command, "bots enable");
    assert.equal(doc.enabled, true);
    assert.equal(doc.provider, "gitbot");
    assert.equal(doc.valid, false);
    assert.equal(doc.ready, false, "enabling must not claim a working connection");
    assert.ok(doc.errors.length > 0);
    assert.match(doc.fix, /experimental\.management_bots\.endpoint/);

    // and disabling returns the workspace to a valid, closed state
    const disabled = aceIso(["bots", "disable", "--json"], ws);
    assert.equal(disabled.status, 0, disabled.stderr);
    const after = JSON.parse(disabled.stdout);
    assert.equal(after.enabled, false);
    assert.equal(after.valid, true);
  });
});

test("governance commands fail closed outside an initialized workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-test-"));
  try {
    for (const args of [["govern"], ["crew"], ["config", "check"], ["supervise"], ["watchdog", "cycle"]]) {
      const r = aceIso(args, dir);
      assert.equal(r.status, 1, `${args.join(" ")} should fail closed`);
      assert.match(r.stderr, /PROJECT_NOT_INITIALIZED/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
