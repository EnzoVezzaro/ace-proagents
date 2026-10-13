import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  buildCrew,
  canStart,
  checkRoute,
  checkWriteScope,
  computeOccupancy,
  declaredWorkerCount,
  nextRoute,
  projectRoots,
  routeChain,
  routeLabel,
  supervisorFor,
} from "../lib/crew.mjs";
import { mergeLayers, defaultConfig } from "../lib/config.mjs";

/** Build an effective config the same way the CLI does, without a filesystem. */
function config(project = {}) {
  return mergeLayers({ defaults: defaultConfig(), project }).effective;
}

function agent(id, role, status, runtime = "local", project = "primary") {
  return { id, role, status, runtime, project };
}

test("the roster reads the ace/v1 native agents.workers and wires ownership", () => {
  const cfg = config({ agents: { workers: [{ role: "backend" }, { role: "tester" }] } });
  const crew = buildCrew(cfg);

  assert.equal(crew.governor.id, "governor");
  assert.equal(crew.governor.role, "governor");
  assert.equal(crew.supervisors.length, 1);
  assert.equal(crew.supervisors[0].project, "primary");
  assert.deepEqual(crew.workers.map((w) => w.id), ["primary-backend", "primary-tester"]);
  assert.deepEqual(crew.workers.map((w) => w.supervisor), ["primary-supervisor", "primary-supervisor"]);
  assert.equal(declaredWorkerCount(cfg), 2);
  assert.deepEqual(crew.projects, [
    { project: "primary", supervisor: "primary-supervisor", workspace: ".", workers: ["primary-backend", "primary-tester"] },
  ]);
});

test("multiple projects each get their own supervisor, workspace and workers", () => {
  const cfg = config({
    roles: {
      supervisors: [
        { role: "supervisor", project: "api", workspace: "worktrees/api" },
        { role: "supervisor", project: "web", workspace: "worktrees/web" },
      ],
      workers: [
        { role: "backend", project: "api" },
        { role: "frontend", project: "web" },
      ],
    },
  });
  const crew = buildCrew(cfg);
  assert.deepEqual(crew.supervisors.map((s) => s.id), ["api-supervisor", "web-supervisor"]);
  assert.deepEqual(crew.workers.map((w) => [w.id, w.supervisor]), [
    ["api-backend", "api-supervisor"],
    ["web-frontend", "web-supervisor"],
  ]);
  assert.equal(crew.projects.find((p) => p.project === "api").workspace, "worktrees/api");
});

test("four is the default limit and starting beyond it is refused", () => {
  const cfg = config();
  assert.equal(computeOccupancy(cfg, []).limit, 4);

  const full = [
    agent("w1", "worker", "working"),
    agent("w2", "worker", "working"),
    agent("w3", "worker", "starting"),
    agent("w4", "worker", "working"),
  ];
  const verdict = canStart(cfg, full, { runtime: "local" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "BUDGET_EXHAUSTED");
  assert.match(verdict.reason, /4\/4/);
  assert.match(verdict.reason, /raise concurrency\.max_active_agents/);

  // idle and finished agents do not occupy the budget
  const idle = [agent("w1", "worker", "idle"), agent("w2", "worker", "done"), agent("w3", "worker", "failed")];
  assert.equal(computeOccupancy(cfg, idle).occupied, 0);
  assert.equal(canStart(cfg, idle, { runtime: "local" }).allowed, true);
});

test("the limit is configurable above four", () => {
  const cfg = config({ concurrency: { max_active_agents: 7 } });
  const six = Array.from({ length: 6 }, (_, i) => agent(`w${i}`, "worker", "working"));
  assert.equal(computeOccupancy(cfg, six).limit, 7);
  const verdict = canStart(cfg, six, { runtime: "local" });
  assert.equal(verdict.allowed, true, verdict.reason);
  assert.match(verdict.reason, /7\/7/);

  const seven = [...six, agent("w7", "worker", "working")];
  assert.equal(canStart(cfg, seven, { runtime: "local" }).code, "BUDGET_EXHAUSTED");
});

test("the budget is enforced centrally across runtimes, plus per-runtime caps", () => {
  const cfg = config({ concurrency: { max_active_agents: 3 } });
  const mixed = [
    agent("a", "worker", "working", "opencode"),
    agent("b", "worker", "working", "claude"),
    agent("c", "worker", "working", "codex"),
  ];
  const occ = computeOccupancy(cfg, mixed);
  assert.equal(occ.occupied, 3, "agents from every runtime count against the one budget");
  assert.deepEqual(occ.byRuntime, { opencode: 1, claude: 1, codex: 1 });
  assert.equal(canStart(cfg, mixed, { runtime: "gemini" }).code, "BUDGET_EXHAUSTED");

  // A runtime that would be within the global budget can still be capped.
  const capped = config({ concurrency: { max_active_agents: 10, runtime_overrides: { opencode: 1 } } });
  const two = [agent("a", "worker", "working", "opencode"), agent("b", "worker", "working", "opencode")];
  const verdict = canStart(capped, two, { runtime: "opencode" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "RUNTIME_CAP_REACHED");
  // The reason reports actual usage, including overshoot, rather than clamping
  // the numbers into looking healthy.
  assert.match(verdict.reason, /2\/1/);
  assert.equal(canStart(capped, two, { runtime: "claude" }).allowed, true);
});

test("the governor and supervisors count only when configured to", () => {
  const defaultCfg = config();
  const withPlanners = [agent("governor", "governor", "working"), agent("primary-supervisor", "supervisor", "working")];
  const occ = computeOccupancy(defaultCfg, withPlanners);
  assert.equal(occ.occupied, 0, "planners do not spend the worker budget by default");
  assert.equal(occ.ignored.length, 2);

  const counted = config({ concurrency: { count_governor: true, count_supervisors: true } });
  assert.equal(computeOccupancy(counted, withPlanners).occupied, 2);
});

test("the governor cannot message a worker, by policy rather than by prompt", () => {
  const cfg = config({ agents: { workers: [{ role: "backend" }] } });
  const crew = buildCrew(cfg);
  const governor = { role: "governor", id: "governor", kind: "governor" };
  const worker = { role: "worker", kind: "backend", id: "primary-backend", project: "primary" };
  const supervisor = { role: "supervisor", id: "primary-supervisor", project: "primary" };

  const refused = checkRoute(governor, worker, cfg);
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "GOVERNOR_WORKER_BOUNDARY");
  assert.match(refused.reason, /request action from the worker's supervisor/);

  assert.equal(checkRoute(governor, supervisor, cfg).allowed, true);
  assert.equal(checkRoute(supervisor, worker, cfg).allowed, true);
  assert.equal(checkRoute(worker, supervisor, cfg).allowed, true);
  assert.equal(checkRoute(crew.governor, crew.workers[0], cfg).allowed, false);
});

test("cross-project messages are refused unless context sharing is enabled", () => {
  const cfg = config({
    roles: { supervisors: [{ role: "supervisor", project: "api" }, { role: "supervisor", project: "web" }] },
    agents: { workers: [{ role: "backend", project: "api" }, { role: "frontend", project: "web" }] },
  });
  const apiWorker = { role: "worker", kind: "backend", id: "api-backend", project: "api" };
  const webWorker = { role: "worker", kind: "frontend", id: "web-frontend", project: "web" };
  const apiSupervisor = { role: "supervisor", id: "api-supervisor", project: "api" };

  const refused = checkRoute(apiWorker, webWorker, cfg);
  assert.equal(refused.code, "CROSS_PROJECT_DENIED");
  assert.match(refused.reason, /context\.sharing/);

  // context.sharing widens context and peer messages, not ownership.
  assert.equal(checkRoute(apiSupervisor, webWorker, cfg).code, "CROSS_PROJECT_DENIED");
  const shared = config({ context: { sharing: "shared" } });
  assert.equal(checkRoute(apiSupervisor, webWorker, shared).code, "CROSS_PROJECT_DENIED");
  assert.equal(checkRoute(apiWorker, webWorker, shared).allowed, true);
});

test("supervisorFor routes action through the owning supervisor and reports orphans", () => {
  const crew = buildCrew(config({ agents: { workers: [{ role: "backend" }] } }));
  const owned = supervisorFor(crew, "primary-backend");
  assert.equal(owned.ok, true);
  assert.equal(owned.supervisor.id, "primary-supervisor");

  const orphaned = supervisorFor({ ...crew, workers: [{ ...crew.workers[0], supervisor: null, project: "ghost" }] }, "primary-backend");
  assert.equal(orphaned.ok, false);
  assert.equal(orphaned.code, "ORPHAN_WORKER");
  assert.equal(supervisorFor(crew, "nobody").code, "UNKNOWN_WORKER");
});

test("route chains run primary then fallbacks and terminate", () => {
  const cfg = config({
    models: {
      default: { provider: "fake", model: "fake-1" },
      routes: {
        supervisor: {
          primary: { provider: "openai", model: "gpt-5" },
          fallbacks: [{ provider: "anthropic", model: "claude-4" }, { provider: "opencode", model: "free-1" }],
        },
      },
    },
  });
  const chain = routeChain(cfg, "supervisor", "primary");
  assert.deepEqual(chain.map(routeLabel), ["openai:gpt-5", "anthropic:claude-4", "opencode:free-1"]);
  assert.equal(chain[0].primary, true);

  assert.equal(routeLabel(nextRoute(chain, chain[0])), "anthropic:claude-4");
  assert.equal(routeLabel(nextRoute(chain, chain[1])), "opencode:free-1");
  assert.equal(nextRoute(chain, chain[2]), null, "the chain terminates instead of looping");

  // a role with no route configured falls back to models.default
  assert.deepEqual(routeChain(cfg, "worker", "primary").map(routeLabel), ["fake:fake-1"]);
});

test("a write outside the assigned workspace, or into another project, is refused", () => {
  const inside = checkWriteScope("/tmp/project", "src/index.mjs");
  assert.equal(inside.allowed, true);

  const outside = checkWriteScope("/tmp/project", "../../etc/passwd");
  assert.equal(outside.allowed, false);
  assert.equal(outside.code, "OUT_OF_SCOPE_WRITE");

  const crossProject = checkWriteScope("/tmp/project", "../other-project/src/a.mjs", {
    crossProjectRoots: ["/tmp/other-project"],
  });
  assert.equal(crossProject.allowed, false);
  assert.equal(crossProject.code, "CROSS_PROJECT_WRITE");
  assert.match(crossProject.reason, /belongs to another project/);

  assert.equal(checkWriteScope("/tmp/project", "").code, "NO_PATH");

  const crew = buildCrew(
    config({
      roles: {
        supervisors: [
          { role: "supervisor", project: "api", workspace: "worktrees/api" },
          { role: "supervisor", project: "web", workspace: "worktrees/web" },
        ],
      },
    })
  );
  const roots = projectRoots(crew, "/repo", "api");
  assert.deepEqual(roots, [join("/repo", "worktrees/web")]);
});
