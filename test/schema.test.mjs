import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfig, SECURITY_KEYS } from "../lib/config.mjs";
import { ADAPTERS, ADAPTER_KINDS } from "../lib/adapters/index.mjs";

/* The schema documents the ace key; the code decides what it means. These
 * tests fail when the two drift apart, which is the only way a hand-written
 * schema stays true. No JSON-schema validator dependency: the checks below are
 * structural and specific. */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(root, "schemas", "workspace.schema.json");

function loadSchema() {
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

/** Walk a dotted path through schema.properties, resolving local $refs. */
function resolvePropertyPath(schema, dotted) {
  let node = schema;
  for (const segment of dotted.split(".")) {
    if (node.$ref) node = deref(schema, node.$ref);
    if (!node || !node.properties || !node.properties[segment]) return null;
    node = node.properties[segment];
  }
  if (node && node.$ref) node = deref(schema, node.$ref);
  return node ?? null;
}

function deref(schema, ref) {
  if (!ref.startsWith("#/")) return null;
  let node = schema;
  for (const segment of ref.slice(2).split("/")) {
    node = node?.[segment];
  }
  return node ?? null;
}

/** Every `enum` array anywhere in the document. */
function allEnums(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) allEnums(item, found);
    return found;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) found.push(value);
      else allEnums(value, found);
    }
  }
  return found;
}

test("the schema is a valid draft 2020-12 ace/v1 document with an unchanged identity", () => {
  const schema = loadSchema();
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "ace.workspace/v1");
  assert.equal(schema.properties.spec.const, "ace/v1");
  assert.deepEqual(schema.required, ["spec", "name"]);
  // An ace/v1 package written before governance existed must still validate:
  // only spec and name are required.
  assert.equal(schema.properties.roles && !schema.required.includes("roles"), true);
});

test("every top-level key of the shipped defaults is documented in the schema", () => {
  const schema = loadSchema();
  const defaults = Object.keys(defaultConfig());
  for (const key of defaults) {
    assert.ok(schema.properties[key], `defaultConfig().${key} has no schema entry`);
  }
});

test("every security-relevant setting resolves through the schema", () => {
  const schema = loadSchema();
  for (const { path } of SECURITY_KEYS) {
    const node = resolvePropertyPath(schema, path);
    assert.ok(node, `security key "${path}" is not documented in the schema`);
    assert.ok(
      typeof node.description === "string" && /Security-relevant|Denied by default|Off by default|refused/.test(node.description),
      `security key "${path}" must say why it is enforced`
    );
  }
});

test("every adapter kind has a swap point in the schema", () => {
  const schema = loadSchema();
  const documented = Object.keys(schema.properties.adapters.properties);
  assert.deepEqual([...documented].sort(), [...ADAPTER_KINDS].sort());
  for (const kind of ADAPTER_KINDS) {
    const node = schema.properties.adapters.properties[kind];
    const resolved = node.$ref ? deref(schema, node.$ref) : node;
    assert.ok(resolved.properties.provider, `adapters.${kind} must select a provider`);
  }
});

test("the concurrency default and floor in the schema match the code", () => {
  const schema = loadSchema();
  const limit = schema.properties.concurrency.properties.max_active_agents;
  assert.equal(limit.default, 4);
  assert.equal(limit.minimum, 1);
  assert.equal(defaultConfig().concurrency.max_active_agents, limit.default);
  assert.equal(schema.properties.default_agent_limit.default, 4);
});

test("management bots are documented as experimental and off by default, and are off in code", () => {
  const schema = loadSchema();
  const bots = schema.properties.experimental.properties.management_bots;
  assert.equal(bots.properties.enabled.default, false);
  assert.match(bots.properties.enabled.description, /Off by default/);
  assert.match(bots.description, /Off by default/);
  assert.equal(defaultConfig().experimental.management_bots.enabled, false);
  assert.ok(bots.properties.permissions, "the permissions the bot may request must be configurable");
  assert.ok(bots.properties.approvals, "approval-gated actions must be configurable");
});

test("no provider or capability is frozen by name in the schema", () => {
  const schema = loadSchema();
  const providerNames = new Set([
    ...Object.keys(ADAPTERS.provider),
    ...ADAPTER_KINDS,
    ...Object.values(ADAPTERS).flatMap((group) => Object.keys(group)),
  ]);
  for (const values of allEnums(schema)) {
    for (const value of values) {
      assert.equal(
        providerNames.has(value),
        false,
        `the schema enumerates "${value}", which lives in a swappable registry — use a description instead so replacing an adapter does not require a schema change`
      );
    }
  }
});
