import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultConfig,
  mergeLayers,
  parseOverridePair,
  redactConfig,
  resolveConfig,
  validateEffective,
  writeSessionOverride,
  MAX_ACTIVE_AGENTS_DEFAULT,
} from "../lib/config.mjs";

/* Every test pins ACE_HOME to a path inside the temp workspace, so a
 * developer's own ~/.ace/profile.json can never change the result. */

function withWorkspace(ace, fn, { env = {}, layers = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ace-config-"));
  const dir = join(root, "ws");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "ws", version: "0.1.0", ace: { spec: "ace/v1", name: "ws", ...ace } }, null, 2)
  );
  for (const [name, value] of Object.entries(layers)) {
    if (name === "installation") {
      mkdirSync(join(root, "home"), { recursive: true });
      writeFileSync(join(root, "home", "profile.json"), JSON.stringify(value, null, 2));
    }
    if (name === "environment") writeFileSync(join(root, "env-profile.json"), JSON.stringify(value, null, 2));
    if (name === "session") {
      mkdirSync(join(dir, ".ace"), { recursive: true });
      writeFileSync(join(dir, ".ace", "session.json"), JSON.stringify(value, null, 2));
    }
  }
  try {
    const env2 = {
      ACE_HOME: join(root, "home"),
      ...(layers.environment ? { ACE_PROFILE_FILE: join(root, "env-profile.json") } : {}),
      ...env,
    };
    fn({ dir, root, env: env2, resolve: () => resolveConfig({ dir, env: env2 }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the default active-agent limit is four and the defaults validate", () => {
  const defaults = defaultConfig();
  assert.equal(defaults.concurrency.max_active_agents, 4);
  assert.equal(defaults.default_agent_limit, MAX_ACTIVE_AGENTS_DEFAULT);
  const verdict = validateEffective(defaults, { env: {} });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  assert.deepEqual(verdict.errors, []);
});

test("project config overrides defaults and its source is recorded", () => {
  withWorkspace({ concurrency: { max_active_agents: 6 } }, ({ resolve }) => {
    const resolved = resolve();
    assert.equal(resolved.effective.concurrency.max_active_agents, 6);
    assert.equal(resolved.sources["concurrency.max_active_agents"], "project");
    assert.equal(resolved.sources["recovery.stale_heartbeat_seconds"], "defaults");
    assert.equal(resolved.security.ok, true);
  });
});

test("task overrides the project layer and session overrides the task layer", () => {
  withWorkspace(
    { concurrency: { max_active_agents: 6 } },
    ({ dir, env }) => {
      const taskId = "task_layered";
      mkdirSync(join(dir, ".ace", "tasks"), { recursive: true });
      writeFileSync(
        join(dir, ".ace", "tasks", `${taskId}.json`),
        JSON.stringify({ id: taskId, status: "pending", config: { concurrency: { max_active_agents: 7 } } })
      );
      const withoutSession = resolveConfig({ dir, env, taskId });
      assert.equal(withoutSession.effective.concurrency.max_active_agents, 7);
      assert.equal(withoutSession.sources["concurrency.max_active_agents"], "task");

      writeSessionOverride(dir, { concurrency: { max_active_agents: 8 } });
      const withSession = resolveConfig({ dir, env, taskId });
      assert.equal(withSession.effective.concurrency.max_active_agents, 8);
      assert.equal(withSession.sources["concurrency.max_active_agents"], "session");

      // the task layer is still visible underneath the session layer
      const noSessionFile = resolveConfig({ dir, env, taskId });
      assert.equal(noSessionFile.layers.task.concurrency.max_active_agents, 7);
    }
  );
});

test("an environment profile can raise the limit above four", () => {
  withWorkspace({}, ({ resolve }) => {
    const resolved = resolve();
    assert.equal(resolved.effective.concurrency.max_active_agents, 4, "without an environment profile the shipped default stands");
  });
  withWorkspace({}, ({ resolve }) => {
    const resolved = resolve();
    assert.equal(resolved.effective.concurrency.max_active_agents, 9);
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  }, { layers: { environment: { concurrency: { max_active_agents: 9 } } } });
});

test("the installation profile is the lowest layer above the defaults", () => {
  withWorkspace(
    { concurrency: { max_active_agents: 6 } },
    ({ resolve }) => {
      const resolved = resolve();
      assert.equal(resolved.effective.concurrency.max_active_agents, 6);
      assert.equal(resolved.sources["concurrency.max_active_agents"], "project");
      assert.equal(resolved.effective.recovery.max_restarts, 5, "installation value must survive when no higher layer sets it");
      assert.equal(resolved.sources["recovery.max_restarts"], "installation");
    },
    { layers: { installation: { recovery: { max_restarts: 5 } } } }
  );
});

test("an unknown or known-but-unimplemented adapter fails visibly with a fix", () => {
  withWorkspace({ adapters: { provider: { provider: "llama-local" } } }, ({ resolve }) => {
    const resolved = resolve();
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    assert.equal(verdict.ok, false);
    const error = verdict.errors.find((e) => e.code === "INCOMPATIBLE_ADAPTER");
    assert.ok(error, "expected INCOMPATIBLE_ADAPTER");
    assert.match(error.message, /unknown provider/);
    assert.ok(error.fix && error.fix.length > 0);
  });

  withWorkspace({ adapters: { workspace: { provider: "docker" } } }, ({ resolve }) => {
    const resolved = resolve();
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    const error = verdict.errors.find((e) => e.code === "INCOMPATIBLE_ADAPTER" && /docker/.test(e.message));
    assert.ok(error, "a declared but unimplemented adapter must be refused, not ignored");
    assert.match(error.message, /not implemented/);
  });
});

test("a credential missing for an active provider is reported, and clears when present", () => {
  withWorkspace({ models: { default: { provider: "openai", model: "gpt-5" } } }, ({ resolve }) => {
    const resolved = resolve();
    const missing = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    assert.equal(missing.ok, false);
    const error = missing.errors.find((e) => e.code === "MISSING_CREDENTIAL");
    assert.ok(error, "expected MISSING_CREDENTIAL");
    assert.match(error.message, /OPENAI_API_KEY/);
    assert.match(error.fix, /OPENAI_API_KEY/);

    const present = validateEffective(resolved.effective, { env: { OPENAI_API_KEY: "test-key" }, layers: resolved.layers });
    assert.equal(present.ok, true, JSON.stringify(present.errors));
  });
});

test("a route with a provider but no model identifier is refused", () => {
  withWorkspace({ models: { routes: { worker: { primary: { provider: "fake" } } } } }, ({ resolve }) => {
    const resolved = resolve();
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    const error = verdict.errors.find((e) => e.code === "INVALID_MODEL");
    assert.ok(error, "expected INVALID_MODEL");
    assert.match(error.where, /models\.routes\.worker/);
  });
});

test("the security floor refuses a lower-trust layer that loosens installation policy", () => {
  withWorkspace(
    { network: { mode: "open" } },
    ({ resolve }) => {
      const resolved = resolve();
      assert.equal(resolved.security.ok, false);
      const violation = resolved.security.violations.find((v) => v.path === "network.mode");
      assert.ok(violation, "project must not loosen restricted network mode");
      assert.equal(violation.floor.layer, "installation");
      assert.equal(violation.attempted.layer, "project");

      const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
      assert.ok(verdict.errors.some((e) => e.code === "SECURITY_OVERRIDE_DENIED"));
    },
    { layers: { installation: { network: { mode: "restricted" } } } }
  );
});

test("the security floor does not fire when no higher-authority layer set the key", () => {
  withWorkspace({ network: { mode: "open" } }, ({ resolve }) => {
    const resolved = resolve();
    assert.equal(resolved.security.ok, true, JSON.stringify(resolved.security.violations));
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    assert.equal(verdict.errors.filter((e) => e.code === "SECURITY_OVERRIDE_DENIED").length, 0);
  });
});

test("enabling management bots from a project layer is refused when installation keeps them off", () => {
  withWorkspace(
    { experimental: { management_bots: { enabled: true, provider: "gitbot" } } },
    ({ resolve }) => {
      const resolved = resolve();
      const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
      const violation = verdict.errors.find((e) => e.code === "SECURITY_OVERRIDE_DENIED" && e.where === "experimental.management_bots.enabled");
      assert.ok(violation, `a project layer must not switch on an experimental inbound surface (got ${verdict.errors.map((e) => e.code).join(", ")})`);
      assert.match(violation.fix, /installation or environment profile/);
    },
    { layers: { installation: { experimental: { management_bots: { enabled: false } } } } }
  );
});

test("a management-bot endpoint is trusted on loopback, and off it only with HTTPS plus a credential plus an opt-in", () => {
  const base = {
    enabled: true,
    provider: "gitbot",
    identity: "ace-gitbot",
    secret_ref: "gitbot_token",
    projects: { inbound: "ws" },
    endpoint: "http://127.0.0.1:8787/hook",
  };

  withWorkspace({ experimental: { management_bots: base } }, ({ resolve }) => {
    const resolved = resolve();
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  });

  withWorkspace({ experimental: { management_bots: { ...base, endpoint: "https://gitbot.example/hook" } } }, ({ resolve }) => {
    const resolved = resolve();
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    const error = verdict.errors.find((e) => e.code === "INCOMPATIBLE_ADAPTER" && /allow_remote_endpoint/.test(e.message));
    assert.ok(error, `a remote endpoint without an opt-in must be refused (${verdict.errors.map((e) => e.message).join(" | ")})`);
    assert.match(error.fix, /endpoint, identity, secret_ref/);
  });

  withWorkspace({ experimental: { management_bots: { ...base, endpoint: "https://gitbot.example/hook", allow_remote_endpoint: true } } }, ({ resolve }) => {
    const resolved = resolve();
    const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  });
});

test("a wildcard permission on a management bot is refused", () => {
  withWorkspace(
    { experimental: { management_bots: { enabled: true, provider: "gitbot", endpoint: "http://127.0.0.1:9/x", identity: "gitbot", projects: { inbound: "ws" }, permissions: ["*"] } } },
    ({ resolve }) => {
      const resolved = resolve();
      const verdict = validateEffective(resolved.effective, { env: {}, layers: resolved.layers });
      assert.ok(verdict.errors.some((e) => e.code === "UNSUPPORTED_SETTING" && /wildcard/.test(e.message)));
    }
  );
});

test("override pairs are typed and session overrides are applied at the highest precedence", () => {
  assert.deepEqual(parseOverridePair("concurrency.max_active_agents=6").patch, { concurrency: { max_active_agents: 6 } });
  assert.deepEqual(parseOverridePair("experimental.management_bots.enabled=true").patch, {
    experimental: { management_bots: { enabled: true } },
  });
  assert.equal(parseOverridePair("goal.statement=ship it").patch.goal.statement, "ship it");
  assert.throws(() => parseOverridePair("no-equals-sign"), /key=value/);

  withWorkspace({}, ({ dir }) => {
    writeSessionOverride(dir, parseOverridePair("concurrency.max_active_agents=11").patch);
    const resolved = resolveConfig({ dir, env: { ACE_HOME: join(dir, "absent-home") } });
    assert.equal(resolved.effective.concurrency.max_active_agents, 11);
    assert.equal(resolved.sources["concurrency.max_active_agents"], "session");
  });
});

test("a higher layer's array replaces the one below it, so two supervisors survive", () => {
  const merged = mergeLayers({
    defaults: defaultConfig(),
    project: {
      roles: {
        supervisors: [
          { role: "supervisor", project: "api" },
          { role: "supervisor", project: "web" },
        ],
      },
    },
  });
  // Concatenate-and-dedupe (pkg.compose semantics) would collapse these into
  // one, because both carry role "supervisor"; a configuration override must
  // not.
  assert.deepEqual(merged.effective.roles.supervisors.map((s) => s.project), ["api", "web"]);

  const nested = mergeLayers({
    defaults: defaultConfig(),
    project: { recovery: { max_restarts: 7 } },
  });
  assert.equal(nested.effective.recovery.max_restarts, 7, "objects still merge recursively");
  assert.equal(nested.effective.recovery.lease_seconds, defaultConfig().recovery.lease_seconds, "untouched defaults survive");

  const redacted = redactConfig({ experimental: { management_bots: { secret_ref: "secret:gitbot", api_key: "sk-live-abcdefghijklmnop" } } });
  assert.ok(redacted);

  assert.equal(redacted.experimental.management_bots.secret_ref, "secret:gitbot", "a reference is not a secret");
  assert.equal(redacted.experimental.management_bots.api_key, "<redacted>");
});
