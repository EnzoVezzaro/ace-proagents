import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
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
