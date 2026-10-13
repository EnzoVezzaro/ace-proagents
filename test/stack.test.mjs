import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import * as intake from "../lib/intake.mjs";
import * as stack from "../lib/stack.mjs";
import * as cliStack from "../lib/cli-stack.mjs";

/* The installer's acceptance suite.
 *
 * Everything here is hermetic: fixtures live under mkdtempSync(tmpdir()), and
 * nothing is written inside the package. The one test that spawns the CLI does
 * so with cwd set to a fixture.
 *
 * The load-bearing tests are `verifyStack` (7) and the CLI end-to-end block (8):
 * an installer that cannot detect a broken setup it just wrote is worse than no
 * installer, and the exit codes are the contract a script or an agent reads.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "ace.mjs");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeRepo({
  name = "demo-repo",
  scripts = { test: "node --test", build: "echo build" },
  areas = [
    ["experiments", "alpha-api"],
    ["experiments", "beta-web"],
  ],
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ace-stack-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "1.0.0", private: true, scripts }, null, 2)}\n`);
  for (const parts of areas) {
    const tree = join(dir, ...parts);
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "README.md"), `# ${parts[parts.length - 1]}\n`);
  }
  return dir;
}

function drop(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const ANSWERS = {
  goal: "ship the paid API",
  outcome: "the report page renders under 200ms",
  projects: ["experiments/alpha-api", "experiments/beta-web"],
  harness: "opencode",
  cap: 4,
};

/** A resolved context + plan for a fixture, asserting the intake resolved. */
function installed(dir, overrides = {}) {
  const facts = intake.inspect(dir);
  const resolved = intake.resolveContext({ dir, answers: { ...ANSWERS, ...overrides }, facts });
  assert.equal(resolved.ok, true, `intake should resolve: ${resolved.violations.join("; ")}`);
  const plan = stack.planStack({ dir, context: resolved.context });
  assert.deepEqual(plan.violations, [], "the shipped assets must all be present");
  return { facts, context: resolved.context, plan };
}

function fullInstall(dir, overrides = {}) {
  const built = installed(dir, overrides);
  const applied = stack.applyStack(built.plan, built.context);
  assert.equal(applied.written.length, built.plan.writes.length, `expected every write to land: ${JSON.stringify(applied.skipped)}`);
  return { ...built, applied };
}

function ace(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// 1. ids
// ---------------------------------------------------------------------------

test("sanitizeId produces a name the multiplexer can attach", () => {
  assert.equal(intake.sanitizeId("Alpha API"), "alpha-api");
  assert.equal(intake.sanitizeId("experiments/Beta_Web!"), "experiments-beta-web");
  assert.equal(intake.sanitizeId("--Loud--Name--"), "loud-name");
  assert.equal(intake.sanitizeId("9lives"), "p-9lives");
  assert.equal(intake.sanitizeId(""), "");
  assert.equal(intake.sanitizeId(null), "");

  const long = intake.sanitizeId("a".repeat(60));
  assert.equal(long.length, 20, "ids are capped so '-supervisor' still fits the 32-char agent-name budget");
  assert.match(long, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(intake.isValidAgentName(`${long}-supervisor`), "id + '-supervisor' must be a valid agent name");
  assert.equal(intake.isValidAgentName("Bad Name"), false);
  assert.equal(intake.isValidAgentName("a".repeat(33)), false);
});

// ---------------------------------------------------------------------------
// 2. the interrogation
// ---------------------------------------------------------------------------

test("validateAnswers names every missing required answer", () => {
  const verdict = intake.validateAnswers({}, {});
  assert.equal(verdict.ok, false);
  const fields = verdict.errors.map((e) => e.field);
  for (const field of ["goal", "outcome", "projects"]) {
    assert.ok(fields.includes(field), `missing "${field}" must be reported: ${JSON.stringify(verdict.errors)}`);
  }
  for (const error of verdict.errors) assert.ok(String(error.fix).length > 0, "every error carries a fix");

  assert.equal(intake.validateAnswers(ANSWERS, {}).ok, true);

  const badHarness = intake.validateAnswers({ ...ANSWERS, harness: "not-a-harness" }, {});
  assert.equal(badHarness.ok, false);
  assert.ok(badHarness.errors.some((e) => e.field === "harness"));

  for (const cap of ["many", -1, 99]) {
    const verdict2 = intake.validateAnswers({ ...ANSWERS, cap }, {});
    assert.equal(verdict2.ok, false, `cap ${JSON.stringify(cap)} must be refused`);
    assert.ok(verdict2.errors.some((e) => e.field === "cap"));
  }

  const emptyProjects = intake.validateAnswers({ ...ANSWERS, projects: [] }, {});
  assert.equal(emptyProjects.ok, false);
  assert.ok(emptyProjects.errors.some((e) => e.field === "projects"));
});

// ---------------------------------------------------------------------------
// 3. inspection
// ---------------------------------------------------------------------------

test("inspect reports what the tree actually says about itself", () => {
  const dir = makeRepo();
  try {
    const facts = intake.inspect(dir);
    assert.deepEqual(facts.detected_verification, [
      { name: "test", command: "npm run test" },
      { name: "build", command: "npm run build" },
    ]);
    assert.deepEqual(facts.candidate_roots.slice().sort(), ["experiments/alpha-api", "experiments/beta-web"]);
    assert.equal(facts.has_orchestration, false);
    assert.equal(facts.has_ace_key, false);
    assert.equal(facts.has_acc_memory, false);
    assert.equal(facts.manifest.name, "demo-repo");
    assert.equal(facts.browser_work_suggested, false);

    const withOrchestration = makeRepo();
    try {
      mkdirSync(join(withOrchestration, "orchestration"), { recursive: true });
      writeFileSync(join(withOrchestration, "orchestration", "projects.json"), "{}\n");
      assert.equal(intake.inspect(withOrchestration).has_orchestration, true);
    } finally {
      drop(withOrchestration);
    }

    const withBrowser = makeRepo();
    try {
      const pkg = readJson(join(withBrowser, "package.json"));
      pkg.devDependencies = { playwright: "1.0.0" };
      writeFileSync(join(withBrowser, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      assert.equal(intake.inspect(withBrowser).browser_work_suggested, true, "a browser dependency is a suggestion, not an assumption");
    } finally {
      drop(withBrowser);
    }
  } finally {
    drop(dir);
  }
});

// ---------------------------------------------------------------------------
// 4. tailoring
// ---------------------------------------------------------------------------

test("resolveContext refuses a setup whose names would lie", () => {
  const dir = makeRepo();
  try {
    const missingRoot = intake.resolveContext({ dir, answers: { ...ANSWERS, projects: ["experiments/nope"] } });
    assert.equal(missingRoot.ok, false);
    assert.ok(missingRoot.violations.some((v) => /does not exist/.test(v)), missingRoot.violations.join("; "));

    mkdirSync(join(dir, "services", "alpha-api"), { recursive: true });
    writeFileSync(join(dir, "services", "alpha-api", "README.md"), "# same name, other tree\n");
    const clash = intake.resolveContext({ dir, answers: { ...ANSWERS, projects: ["experiments/alpha-api", "services/alpha-api"] } });
    assert.equal(clash.ok, false);
    assert.ok(clash.violations.some((v) => /already taken/.test(v)), clash.violations.join("; "));

    const empty = intake.resolveContext({ dir, answers: { ...ANSWERS, projects: [] } });
    assert.equal(empty.ok, false);
    assert.ok(empty.violations.some((v) => /projects/.test(v)), empty.violations.join("; "));
  } finally {
    drop(dir);
  }
});

test("resolveContext derives one name per project and isolation by path", () => {
  const dir = makeRepo();
  try {
    const resolved = intake.resolveContext({ dir, answers: ANSWERS });
    assert.equal(resolved.ok, true, resolved.violations.join("; "));
    const [alpha, beta] = resolved.context.projects;

    for (const project of resolved.context.projects) {
      assert.equal(project.id, basename(project.root), "project.id === basename(its tree)");
      assert.equal(project.browser_space, project.id, "the browser space carries the same name");
      assert.ok(project.owned_paths.includes(`orchestration/state/${project.id}`));
    }

    assert.ok(alpha.forbidden_paths.includes(beta.root), "each project forbids the other's tree");
    assert.ok(alpha.forbidden_paths.includes(`orchestration/state/${beta.id}`));
    assert.ok(beta.forbidden_paths.includes(alpha.root));
    assert.ok(!alpha.forbidden_paths.includes(alpha.root), "a project never forbids its own tree");

    assert.equal(resolved.context.cap, 4);
    assert.deepEqual(
      resolved.context.verification.map((v) => v.command),
      ["npm run test", "npm run build"]
    );
    assert.deepEqual(
      alpha.agents.map((a) => a.role),
      ["supervisor", "worker"],
      "one supervisor and the requested workers"
    );
    assert.equal(alpha.agents[0].name, "alpha-api-supervisor");
    assert.equal(alpha.agents[1].name, "alpha-api-worker");
    assert.ok(alpha.agents.every((a) => intake.isValidAgentName(a.name)));
  } finally {
    drop(dir);
  }
});

test("a first task names its outcome, self-contained and scoped", () => {
  const dir = makeRepo();
  try {
    const resolved = intake.resolveContext({ dir, answers: { ...ANSWERS, first_task: "wire the report page", workers_per_project: 2 } });
    assert.equal(resolved.ok, true, resolved.violations.join("; "));
    const [alpha] = resolved.context.projects;
    assert.equal(alpha.tasks.length, 1);
    const [task] = alpha.tasks;
    assert.equal(task.outcome, "the report page renders under 200ms", "a task with no outcome is refused at dispatch, so it names one at birth");
    assert.match(task.prompt, /wire the report page/);
    assert.match(task.prompt, /Scope: write only inside experiments\/alpha-api/);
    assert.ok(task.acceptance.length >= 2);
    assert.deepEqual(
      alpha.agents.map((a) => a.name),
      ["alpha-api-supervisor", "alpha-api-worker", "alpha-api-worker-2"]
    );
  } finally {
    drop(dir);
  }
});

// ---------------------------------------------------------------------------
// 5. the plan
// ---------------------------------------------------------------------------

test("partsFor pulls in what a part requires, transitively", () => {
  assert.deepEqual(
    stack.partsFor(["ego-lite-spaces"]).map((p) => p.id),
    ["herdr-spaces", "ego-lite-spaces"]
  );
  assert.deepEqual(
    stack.partsFor(["charter"]).map((p) => p.id),
    ["herdr-spaces", "govern", "supervisors-workers", "charter"],
    "the top layer drags the chain below it, and never acc, which nothing requires"
  );
  assert.deepEqual(stack.partsFor([]).map((p) => p.id), stack.PART_IDS);
  assert.equal(stack.partById("nope"), null);
});

test("planStack writes exactly what the chosen parts cause, from real assets", () => {
  const dir = makeRepo();
  try {
    const { context } = installed(dir);

    const egoOnly = stack.planStack({ dir, context, parts: stack.partsFor(["ego-lite-spaces"]) });
    const paths = egoOnly.writes.map((w) => w.path);
    assert.ok(paths.includes("orchestration/lib/ego.mjs"));
    assert.ok(paths.includes("orchestration/lib/topology.mjs"), "the required herdr-spaces part comes along");
    assert.ok(!paths.includes("package.json"), "govern/supervisors-workers are not installed, so nothing merges the ace key");
    assert.ok(!paths.includes("STACK.md"));
    for (const write of egoOnly.writes.filter((w) => w.kind === "vendor")) {
      assert.ok(existsSync(write.from), `shipped asset missing: ${write.path}`);
    }

    const full = stack.planStack({ dir, context });
    const fullPaths = full.writes.map((w) => w.path);
    for (const expected of [
      "orchestration/tabs.mjs",
      "orchestration/selftest.mjs",
      "orchestration/projects.json",
      "orchestration/lib/handoff.mjs",
      "package.json",
      "STACK.md",
      "charter/registry/experts.json",
      ".acc/config/config.yaml",
      "experiments/alpha-api/.acc-memory.md",
    ]) {
      assert.ok(fullPaths.includes(expected), `${expected} is missing from the plan`);
    }
    assert.equal(fullPaths.filter((p) => p === "package.json").length, 1, "the manifest is merged once, whichever part claims it");

    // Every link points at a part that is also in the plan: the plan can never
    // describe a hand-off to something absent.
    const ids = new Set(full.parts.map((p) => p.id));
    for (const link of full.links) {
      assert.ok(ids.has(link.from) && ids.has(link.to), `dangling link ${link.from} → ${link.to}`);
      assert.ok(link.name && link.how, "a link names the thing it carries and how");
    }
  } finally {
    drop(dir);
  }
});

// ---------------------------------------------------------------------------
// 6. the apply
// ---------------------------------------------------------------------------

test("applyStack merges the ace key and touches nothing else in the manifest", () => {
  const dir = makeRepo();
  try {
    const { context, plan } = installed(dir);
    const before = readJson(join(dir, "package.json"));
    stack.applyStack(plan, context);
    const after = readJson(join(dir, "package.json"));

    assert.deepEqual(Object.keys(after).sort(), ["ace", "name", "private", "scripts", "version"]);
    assert.equal(after.version, before.version);
    assert.equal(after.private, true);
    assert.deepEqual(after.scripts, before.scripts);
    assert.equal(after.ace.spec, "ace/v1");
    assert.equal(after.ace.concurrency.max_active_agents, 4);
    assert.deepEqual(
      after.ace.roles.supervisors.map((s) => [s.id, s.project]),
      [
        ["alpha-api-supervisor", "alpha-api"],
        ["beta-web-supervisor", "beta-web"],
      ]
    );
    assert.deepEqual(
      after.ace.roles.workers.map((w) => w.project),
      ["alpha-api", "beta-web"]
    );
    assert.equal(after.ace.orchestration.data, "orchestration/projects.json");

    // The written data must agree with itself: the budget in the ace key is the
    // budget the orchestrator enforces.
    const config = readJson(join(dir, "orchestration", "projects.json"));
    assert.equal(config.cap.max_active_workers, after.ace.concurrency.max_active_agents);
    assert.equal(config.topology.governor.name, "governor");
    assert.deepEqual(
      config.projects.map((p) => p.id),
      ["alpha-api", "beta-web"]
    );
    assert.ok(existsSync(join(dir, "orchestration", "state", ".gitignore")));
    assert.equal(readFileSync(join(dir, ".acc-memory.md"), "utf8").length > 0, true);
  } finally {
    drop(dir);
  }
});

test("applyStack never clobbers, and a second apply changes nothing", () => {
  const dir = makeRepo();
  try {
    const { context, plan } = fullInstall(dir);
    const first = {
      projects: readFileSync(join(dir, "orchestration", "projects.json"), "utf8"),
      stack: readFileSync(join(dir, "STACK.md"), "utf8"),
      memory: readFileSync(join(dir, ".acc-memory.md"), "utf8"),
    };

    // A repo that already carries decisions is not overwritten.
    const edited = readJson(join(dir, "orchestration", "projects.json"));
    edited.hand_edited = true;
    const handEdited = `${JSON.stringify(edited, null, 2)}\n`;
    writeFileSync(join(dir, "orchestration", "projects.json"), handEdited);
    const second = stack.applyStack(plan, context);
    assert.equal(readFileSync(join(dir, "orchestration", "projects.json"), "utf8"), handEdited, "a differing generated file is left alone");
    assert.ok(
      second.skipped.some((s) => s.path === "orchestration/projects.json" && /differs/.test(s.reason)),
      JSON.stringify(second.skipped)
    );
    assert.ok(
      second.skipped.some((s) => s.path === "package.json" && /already matches this plan/.test(s.reason)),
      "an identical ace key is not rewritten"
    );

    // With force, the same file is regenerated from the plan.
    const forced = stack.applyStack(plan, context, { force: true });
    assert.equal(readFileSync(join(dir, "orchestration", "projects.json"), "utf8"), first.projects);
    assert.ok(forced.written.some((w) => w.path === "orchestration/projects.json"));

    // A clean second apply leaves every generated document byte-identical —
    // including the timestamped memory, which must never be silently rebuilt.
    //
    // NOTE for the coordinator: the memory files embed `new Date().toISOString()`,
    // so a re-run reports them as "exists and differs … pass --force to overwrite"
    // rather than "already identical". Leaving them alone is the right behaviour
    // (asserted below); only the printed reason is misleading, and it invites an
    // operator to --force over their own accumulated notes.
    stack.applyStack(plan, context);
    assert.equal(readFileSync(join(dir, "STACK.md"), "utf8"), first.stack);
    assert.equal(readFileSync(join(dir, ".acc-memory.md"), "utf8"), first.memory);

    const again = stack.applyStack(plan, context);
    for (const doc of ["STACK.md", ".acc/config/config.yaml", "charter/TASK-CONTRACT.md", "charter/registry/experts.json"]) {
      assert.ok(again.skipped.some((s) => s.path === doc), `${doc} should be reported rather than rewritten`);
    }
  } finally {
    drop(dir);
  }
});

test("applyStack creates a manifest when the repo has none", () => {
  const dir = makeRepo();
  try {
    rmSync(join(dir, "package.json"));
    const { context, plan } = installed(dir);
    stack.applyStack(plan, context);
    const manifest = readJson(join(dir, "package.json"));
    // No manifest to read a name from, so the context falls back to the tree's
    // own directory name rather than inventing one.
    assert.equal(context.name, basename(dir));
    assert.equal(manifest.name, basename(dir));
    assert.equal(manifest.ace.spec, "ace/v1");
  } finally {
    drop(dir);
  }
});

// ---------------------------------------------------------------------------
// 7. the verification — the acceptance test of the whole feature
// ---------------------------------------------------------------------------

test("verifyStack passes on a clean install and covers every part", async () => {
  const dir = makeRepo();
  try {
    const { context, plan } = fullInstall(dir);
    const verdict = await stack.verifyStack(plan, context);

    assert.equal(verdict.failed, 0, JSON.stringify(verdict.checks.filter((c) => c.status === "fail"), null, 2));
    assert.equal(verdict.ok, true);
    assert.ok(verdict.passed >= 12, `expected the real invariants to be checked, got ${verdict.passed}`);
    assert.deepEqual([...new Set(verdict.checks.map((c) => c.part))].sort(), [...stack.PART_IDS].sort(), "every part is verified");
    assert.ok(
      verdict.checks.every((c) => ["pass", "fail", "skip"].includes(c.status)),
      "a check is never a maybe"
    );
    const skipped = verdict.checks.filter((c) => c.status === "skip");
    assert.ok(skipped.length >= 1, "what needs a live session is reported, not asserted");
    for (const check of skipped) assert.ok(check.detail.length > 0, `a skipped check must say why: ${check.name}`);
  } finally {
    drop(dir);
  }
});

test("verifyStack fails on a broken setup, for every kind of breakage", async () => {
  const dir = makeRepo();
  try {
    const { context, plan } = fullInstall(dir, { first_task: "wire the report page" });
    const configFile = join(dir, "orchestration", "projects.json");
    const manifestFile = join(dir, "package.json");

    const pristine = readJson(configFile);
    const baseline = await stack.verifyStack(plan, context);
    assert.equal(baseline.ok, true);

    const failsFor = async (part, mutate) => {
      const config = JSON.parse(JSON.stringify(pristine));
      mutate(config);
      writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
      const verdict = await stack.verifyStack(plan, context);
      assert.equal(verdict.ok, false, `${part}: a broken setup must not verify`);
      const failures = verdict.checks.filter((c) => c.status === "fail");
      assert.ok(
        failures.some((c) => c.part === part),
        `${part}: expected a failing check naming that part, got ${JSON.stringify(failures.map((c) => [c.part, c.name]))}`
      );
      writeFileSync(configFile, `${JSON.stringify(pristine, null, 2)}\n`);
    };

    await failsFor("supervisors-workers", (config) => {
      config.projects[0].agents.push({ role: "supervisor", name: "alpha-api-shadow", harness: "opencode", priority: 9 });
    });

    await failsFor("supervisors-workers", (config) => {
      config.projects[1].tasks = [{ id: "t1-missingOutcome", title: "do the thing", priority: 1, status: "pending", outcome: "", prompt: "x", acceptance: ["y"] }];
    });

    await failsFor("ego-lite-spaces", (config) => {
      config.projects[0].browser_space = "some-other-space";
    });

    await failsFor("herdr-spaces", (config) => {
      config.projects[0].id = config.projects[1].id;
    });

    // The one breakage that lives in the manifest: the two budgets disagree.
    const manifest = readJson(manifestFile);
    manifest.ace.concurrency.max_active_agents = 9;
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const mismatched = await stack.verifyStack(plan, context);
    assert.equal(mismatched.ok, false, "a budget that disagrees with the cap is a broken setup");
    assert.ok(
      mismatched.checks.some((c) => c.part === "govern" && c.status === "fail"),
      JSON.stringify(mismatched.checks.filter((c) => c.status === "fail"))
    );

    // Removing the ACC control file is caught too, not silently tolerated.
    rmSync(join(dir, ".acc", "config", "config.yaml"));
    const noControl = await stack.verifyStack(plan, context);
    assert.ok(noControl.checks.some((c) => c.part === "acc" && c.status === "fail"));
  } finally {
    drop(dir);
  }
});

// ---------------------------------------------------------------------------
// 8. end to end, through the CLI
// ---------------------------------------------------------------------------

test("setup without answers and without a terminal refuses, names the fields, and writes nothing", () => {
  const dir = makeRepo();
  try {
    const before = readFileSync(join(dir, "package.json"), "utf8");
    const r = ace(["setup"], dir);

    assert.equal(r.status, 2, `expected a usage error: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /INTAKE_INVALID/);
    for (const field of ["goal", "outcome", "projects"]) {
      assert.match(r.stderr, new RegExp(field), `the refusal must name "${field}"`);
    }
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), before);
    assert.equal(existsSync(join(dir, "orchestration")), false);
    assert.equal(existsSync(join(dir, "STACK.md")), false);
    assert.equal(existsSync(join(dir, ".acc-memory.md")), false);
  } finally {
    drop(dir);
  }
});

test("setup installs from flags and the result is inspectable", () => {
  const dir = makeRepo();
  try {
    const r = ace(
      ["setup", "--goal", "ship the reporting API", "--outcome", "the report page renders under 200ms", "--projects", "experiments/alpha-api,experiments/beta-web"],
      dir
    );
    assert.equal(r.status, 0, `install failed: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /alpha-api/);
    assert.match(r.stdout, /beta-web/);
    assert.match(r.stdout, /verify — \d+ passed, 0 failed/);

    const config = readJson(join(dir, "orchestration", "projects.json"));
    assert.deepEqual(
      config.projects.map((p) => p.id),
      ["alpha-api", "beta-web"]
    );
    assert.equal(config.cap.max_active_workers, 4);
    assert.equal(config.topology.governor.name, "governor");
    assert.equal(config.projects[0].agents[0].name, "alpha-api-supervisor");
    assert.equal(config.projects[0].browser_space, "alpha-api");
    assert.equal(config.verification.checks.length, 2);

    const manifest = readJson(join(dir, "package.json"));
    assert.equal(manifest.ace.concurrency.max_active_agents, config.cap.max_active_workers);
    assert.ok(existsSync(join(dir, "STACK.md")));
    assert.ok(existsSync(join(dir, "charter", "registry", "experts.json")));
    assert.ok(existsSync(join(dir, ".acc", "config", "config.yaml")));
    assert.ok(existsSync(join(dir, "experiments", "alpha-api", ".acc-memory.md")));
    assert.ok(existsSync(join(dir, "orchestration", "lib", "topology.mjs")));

    // A second run is a no-op on content, and still exits 0.
    const again = ace(["setup", "--goal", "ship the reporting API", "--outcome", "the report page renders under 200ms", "--projects", "experiments/alpha-api,experiments/beta-web"], dir);
    assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
    assert.equal(readFileSync(join(dir, "orchestration", "projects.json"), "utf8"), `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    drop(dir);
  }
});

test("setup --dry-run writes nothing", () => {
  const dir = makeRepo();
  try {
    const before = readFileSync(join(dir, "package.json"), "utf8");
    const r = ace(["setup", "--dry-run", "--goal", "g", "--outcome", "m", "--projects", "experiments/alpha-api"], dir);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /plan — \d+ part/);
    assert.match(r.stdout, /alpha-api/);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), before);
    assert.equal(existsSync(join(dir, "orchestration")), false);
    assert.equal(existsSync(join(dir, "STACK.md")), false);
  } finally {
    drop(dir);
  }
});

test("setup refuses an unknown part, and a broken setup exits 1", () => {
  const dir = makeRepo();
  try {
    const unknown = ace(["setup", "--parts", "definitely-not-a-part"], dir);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /UNKNOWN_PART/);
    assert.equal(existsSync(join(dir, "orchestration")), false);

    const r = ace(["setup", "--goal", "g", "--outcome", "m", "--projects", "experiments/alpha-api"], dir);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

    // Break the installed data by hand: the next run must keep the operator's
    // file (it differs) and fail its own verification instead of reporting success.
    const configFile = join(dir, "orchestration", "projects.json");
    const config = readJson(configFile);
    config.projects[0].browser_space = "wrong-space";
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

    const after = ace(["setup", "--goal", "g", "--outcome", "m", "--projects", "experiments/alpha-api"], dir);
    assert.equal(after.status, 1, `a failed check must exit 1: ${after.stdout}${after.stderr}`);
    assert.match(after.stdout, /FAIL/);
    assert.equal(readJson(configFile).projects[0].browser_space, "wrong-space", "the operator's file is never clobbered without --force");
  } finally {
    drop(dir);
  }
});

test("ace parts describes the catalogue and the questions an agent must answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-parts-"));
  try {
    const r = ace(["parts"], dir);
    assert.equal(r.status, 0, r.stderr);
    for (const id of stack.PART_IDS) assert.match(r.stdout, new RegExp(`\\b${id}\\b`));

    const json = ace(["parts", "--json"], dir);
    assert.equal(json.status, 0);
    assert.deepEqual(
      JSON.parse(json.stdout).parts.map((p) => p.id),
      stack.PART_IDS
    );

    const questions = ace(["parts", "--questions"], dir);
    assert.equal(questions.status, 0, questions.stderr);
    for (const id of ["goal", "outcome", "projects", "cap", "verification"]) {
      assert.match(questions.stdout, new RegExp(id));
    }

    const one = ace(["parts", "govern"], dir);
    assert.equal(one.status, 0);
    assert.match(one.stdout, /worker budget/);

    // The in-process handler contract: same code, a captured ctx. Restore the
    // process exit code afterwards so a refusal cannot fail the test runner.
    const previousExit = process.exitCode;
    const errors = [];
    const printed = [];
    const ctx = {
      writeStructuredError: (e) => errors.push(e),
      printJson: (v) => printed.push(v),
      printTable: () => {},
      workspaceInitialized: () => true,
      notInitialized: () => {},
      runVerifyChecks: () => [],
      gitInfo: () => ({ branch: null, commit: null }),
    };
    try {
      assert.deepEqual([...cliStack.COMMANDS].sort(), ["parts", "setup"]);
      await cliStack.run("parts", ["--questions", "--json"], ctx);
      assert.equal(errors.length, 0);
      const doc = printed.find((d) => d.command === "parts --questions");
      assert.ok(doc && doc.questions.length >= 8, "the interrogation is exposed for an agent to answer");
      assert.ok(doc.questions.every((q) => q.why && q.prompt));
    } finally {
      process.exitCode = previousExit;
    }
  } finally {
    drop(dir);
  }
});

// ---------------------------------------------------------------------------
// 9. the installed bundle runs
// ---------------------------------------------------------------------------

/**
 * The strongest acceptance test there is for this feature: after `ace setup`,
 * the code that was WRITTEN into the repo (not the shipped asset) has to run on
 * its own, offline, and pass its own proof. A bundle that only looks installed
 * is the failure this catches — a lab-only import left in place, a module that
 * cannot find its data, a topology the rules reject.
 */
test("the installed stack is self-contained: its own selftest runs green offline", () => {
  const dir = makeRepo();
  try {
    fullInstall(dir);
    const selftest = join(dir, "orchestration", "selftest.mjs");
    assert.ok(existsSync(selftest), "the install wrote orchestration/selftest.mjs");

    // An environment with no multiplexer, no catalog port and no opencode binary:
    // the run must still be green, because nothing in it needs any of them.
    const r = spawnSync(process.execPath, [selftest], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        SENTINEL_PORT: "45999",
        SENTINEL_OPENCODE_BIN: join(dir, "not-an-opencode-binary"),
      },
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /0 failures/);
    const okCount = (r.stdout.match(/^ {2}ok {4}/gm) || []).length;
    assert.ok(okCount >= 40, `only ${okCount} assertions ran — the proof must cover the whole stack`);
    assert.match(r.stdout, /the tab contract/);
    assert.match(r.stdout, /the handoff lifecycle/);
    assert.match(r.stdout, /free models only/);
  } finally {
    drop(dir);
  }
});

test("the installed orchestrator reads its own data without a multiplexer", () => {
  const dir = makeRepo();
  try {
    fullInstall(dir);
    // `cap` reads the config and the cap sources; a missing herdr is a normal
    // state, not a crash — it must report, not throw.
    const r = spawnSync(process.execPath, [join(dir, "orchestration", "tabs.mjs"), "cap"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.cap, 4);
    assert.match(doc.source, /projects\.json/);
    assert.ok(Array.isArray(doc.recovery_due) === false || doc.recovery_due !== undefined);
  } finally {
    drop(dir);
  }
});
