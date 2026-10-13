// orchestration/lib/free-models.mjs — free models only, with bounded failover.
//
// SHIPPED WITH ACE. This is the portable build of the lab's module: it has no
// import outside this directory, so ACE can copy the whole `orchestration/`
// bundle into any repository and it runs there. Nothing about the proven logic
// below changed (bounded retries, a cooldown, a circuit breaker, recovery only
// on a passing probe, provenance on every free-ness claim). What changed is
// where the free pool comes from.
//
// THE HARD RULES, enforced here rather than documented:
//   - a model is assigned work only when its free-ness is ESTABLISHED:
//     `free === true` from a source this file can name. A name containing
//     "-free" is NOT evidence and is never treated as one.
//   - when no verified free model is available, dispatch is REFUSED
//     (FreeModelUnavailable). Nothing silently falls back to a paid model.
//   - freebuff2api is excluded everywhere.
//
// WHERE THE POOL COMES FROM (in order, each labelling its own provenance):
//   1. ACE_FREE_MODEL_COMMAND — a command whose stdout is JSON. The operator is
//      saying "these are free"; labelled `operator-command`, served_live true.
//   2. the opencode serve catalog — GET /api/model, where a model is free only
//      when its whole cost array is all-zero (copied verbatim from the lab's
//      engine/model-index.mjs; the rule is not re-invented here), plus the
//      NVIDIA NIM free list from `opencode models nvidia` (NIM rides opencode's
//      own auth, so it needs no extra credential). Labelled `live-catalog`.
//   3. the cache this file wrote the last time 1 or 2 succeeded — labelled
//      `cache`, served_live FALSE, with the time it was actually measured. A
//      cache is never later read as a live check; that label is the whole
//      reason `served_live` exists.
//   4. nothing — an empty pool, and `select()` refuses. Never an invented entry.
//
// `createFailover()` is a factory so the state machine can be exercised with an
// injected probe and an injected observation sink (the installed selftest does
// exactly that): the shipped `failover` instance writes to this repo's own
// observation ledger, a test instance does not have to.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

export function stateRoot() {
  return process.env.ORCHESTRATION_STATE_DIR || path.join(ROOT, "orchestration", "state");
}

const CACHE_FILE = () => path.join(globalStateDir(), "free-models-cache.json");
const RUNTIME_FILE = () => path.join(globalStateDir(), "model-runtime.json");
const BANNED = /freebuff2api/i;

const OC_BASE = () => `http://127.0.0.1:${Number(process.env.SENTINEL_PORT || 4199)}`;

/** Windows and thresholds, matching the lab's index so the two rank alike. */
const HARD_WINDOW_MS = 60 * 60_000;
const SOFT_WINDOW_MS = 60 * 60_000;
const PROBE_TTL_MS = Number(process.env.MODEL_PROBE_TTL_MIN || 30) * 60_000;
const PROBE_TIMEOUT_MS = Number(process.env.MODEL_PROBE_TIMEOUT_MS || 30_000);
const NIM_TTL_MS = Number(process.env.NIM_CATALOG_TTL_MIN || 10) * 60_000;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 15 * 60_000;

export const DEFAULTS = { retryLimit: 2, cooldownMs: 600_000, circuitThreshold: 3, circuitCooldownMs: 900_000 };

const nowMs = () => Date.now();
const iso = () => new Date().toISOString();
const inWindow = (arr, ms) => (arr || []).filter((t) => nowMs() - t < ms);

/** The blocker list, inlined so this file stands alone. Same strings the
 *  lab's classifier used: these are the provider errors after which retrying
 *  the same model is pointless. */
export function isBlockerError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("ratelimit") ||
    msg.includes("finish reason") ||
    msg.includes("finish token") ||
    msg.includes("max tokens") ||
    msg.includes("context length") ||
    msg.includes("context window") ||
    msg.includes("token limit") ||
    msg.includes("quota") ||
    msg.includes("exhausted") ||
    msg.includes("too many requests") ||
    msg.includes("503") ||
    msg.includes("429")
  );
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function projectStateDir(projectId) {
  return path.join(stateRoot(), projectId);
}

export function globalStateDir() {
  return path.join(stateRoot(), "_global");
}

// ---------- local runtime: observations and probes ----------
/**
 * The lab kept this in engine/state/model-index.json. An installed repo has no
 * engine, so the same shape lives under the orchestration state dir: probes and
 * per-model observations, which is what the ranking and the score fields read.
 */
export function loadRuntime() {
  return readJson(RUNTIME_FILE(), { updated_at: null, probes: {}, obs: {}, index: [] });
}

export function saveRuntime(rt) {
  rt.updated_at = iso();
  writeJson(RUNTIME_FILE(), rt);
  return rt;
}

/** Record one provider outcome (used as the default observation sink). */
export function recordOutcome(key, kind, note) {
  const rt = loadRuntime();
  if (!rt.obs[key]) rt.obs[key] = {};
  const o = rt.obs[key];
  if (kind === "hard") o.hard = [...(o.hard || []).slice(-20), nowMs()];
  else if (kind === "soft") o.soft = [...(o.soft || []).slice(-40), nowMs()];
  else if (kind === "switch") o.switches = (o.switches || 0) + 1;
  else if (kind === "recover") o.recoveries = (o.recoveries || 0) + 1;
  o.note = note ? String(note).slice(0, 200) : o.note || null;
  saveRuntime(rt);
  return o;
}

export function recordProbe(key, ok, ms, error) {
  const rt = loadRuntime();
  rt.probes[key] = { ok, ms, error: error ? String(error).slice(0, 200) : null, at: iso() };
  saveRuntime(rt);
  return rt.probes[key];
}

// ---------- source 1: the operator's own command ----------
/**
 * `ACE_FREE_MODEL_COMMAND` prints the free catalog as JSON on stdout — either a
 * bare array or `{ models: [...] }`. An entry counts ONLY when it says
 * `free === true`; the operator is the authority, and that is recorded as the
 * provenance rather than dressed up as a measurement.
 */
export function parseOperatorCatalog(text) {
  let body;
  try {
    body = JSON.parse(String(text || ""));
  } catch {
    return { models: [], error: "ACE_FREE_MODEL_COMMAND did not print valid JSON" };
  }
  const items = Array.isArray(body) ? body : Array.isArray(body?.models) ? body.models : [];
  const models = [];
  for (const m of items) {
    if (!m || m.free !== true) continue;
    const key = m.key || (m.providerID && m.id ? `${m.providerID}/${m.id}` : null);
    if (!key || BANNED.test(key)) continue;
    const slash = String(key).indexOf("/");
    models.push({
      key: String(key),
      providerID: m.providerID || (slash > 0 ? String(key).slice(0, slash) : null),
      id: m.id || (slash > 0 ? String(key).slice(slash + 1) : String(key)),
      name: m.name || m.id || String(key),
      free: true,
      free_source: "operator-command",
      tools: m.tools !== false,
      context: m.context || m.limit?.context || null,
      rank: Number.isFinite(Number(m.rank)) ? Number(m.rank) : 20,
    });
  }
  return { models, error: null };
}

async function discoverFromCommand(command) {
  try {
    const { stdout } = await run(command, { shell: true, timeout: 20_000, maxBuffer: 8 << 20 });
    return parseOperatorCatalog(stdout);
  } catch (err) {
    return { models: [], error: `ACE_FREE_MODEL_COMMAND failed: ${(err && err.message) || err}` };
  }
}

// ---------- source 2: the live opencode serve catalog ----------
/**
 * Copied from engine/model-index.mjs. A model is free when its whole `cost`
 * array is present and all-zero; "free" in the name is never consulted.
 */
export async function getOpencodeFreeCatalog() {
  try {
    const res = await fetch(`${OC_BASE()}/api/model`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const body = await res.json();
    const items = Array.isArray(body?.data) ? body.data : [];
    return items
      .filter((m) => m && m.id && m.providerID === "opencode")
      .filter((m) => m.status === "active" && m.enabled !== false)
      .filter((m) => m.capabilities?.tools !== false)
      .map((m) => {
        const costs = Array.isArray(m.cost) ? m.cost : [];
        const free = costs.length > 0 && costs.every((c) => !c.input && !c.output);
        return {
          key: `opencode/${m.id}`,
          id: m.id,
          providerID: "opencode",
          name: m.name || m.id,
          free,
          tools: m.capabilities?.tools !== false,
          context: m.limit?.context || null,
          rank: opencodeRank(m.id),
        };
      })
      .filter((m) => m.free);
  } catch {
    // serve down is a normal state, not an error: the caller decides what to do.
    return [];
  }
}

/** Operator preference derived from the model's own size/class signal in its id.
 *  A heuristic for ordering fallbacks — NOT a benchmark claim. */
export function opencodeRank(id) {
  const s = String(id || "").toLowerCase();
  if (/ultra|550b|super|120b|big-pickle/.test(s)) return 38;
  if (/pro|max|longcat|space-bunny|exo|fledge/.test(s)) return 34;
  if (/flash|lightning|mini|nano|lite|small|tiny/.test(s)) return 22;
  return 28;
}

/**
 * The NVIDIA NIM free list. NIM models ride opencode's own auth (no API key is
 * injected here) but never appear in /api/model, so the catalog is enumerated
 * with `opencode models nvidia`. Non-chat families (embeddings, rerankers,
 * vision/image, TTS) are filtered out; the previously verified models keep
 * operator rank/tools overrides. Cached in memory for NIM_CATALOG_TTL_MIN
 * because the CLI call can take tens of seconds.
 *
 * `opencode` may not exist on this host (the harness can be claude/codex/
 * gemini/freebuff). That is not an error — it returns an empty list.
 */
const NVIDIA_DENY = /bge-?m3|embed|rerank|retriev|triever|flux|diffusion|paligemma|esm|guard|safety|speaker|bevformer|cosmos|voicechat|tts|translate|sparsedrive|streampetr|studiovoice|whisper|usd|image|detect|musicgen|canary|popgen/i;

export const NVIDIA_OVERRIDES = [
  { id: "z-ai/glm-5.3", rank: 38 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", rank: 38 },
  { id: "moonshotai/kimi-k3", rank: 37 },
  { id: "nvidia/nemotron-3-super-120b-a12b", rank: 34 },
  { id: "deepseek-ai/deepseek-v4.1-flash", rank: 33 },
  { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", rank: 33 },
  { id: "z-ai/glm-5.3-flash", rank: 30 },
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", rank: 30 },
  { id: "mistralai/mistral-medium-3-instruct", rank: 30 },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", rank: 28 },
  { id: "meta/muse-glimmer-30b", rank: 27 },
  { id: "mistralai/magistral-small-2506", rank: 25 },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", rank: 24 },
  { id: "openai/gpt-oss-20b", rank: 22 },
  { id: "poolside/laguna-xs-2.1", rank: 22 },
  { id: "google/gemma-4-31b-it", rank: 20, tools: false },
  { id: "google/gemma-3-12b-it", rank: 16, tools: false },
];

export const NVIDIA_MODELS = NVIDIA_OVERRIDES.map((m) => ({ ...m, providerID: "nvidia", key: `nvidia/${m.id}` }));

let nimCache = { at: 0, list: [] };

function mkNim(id) {
  const o = NVIDIA_OVERRIDES.find((x) => x.id === id) || {};
  return {
    key: `nvidia/${id}`,
    id,
    providerID: "nvidia",
    name: id,
    free: true,
    tools: o.tools === undefined ? !NVIDIA_DENY.test(id) : o.tools,
    context: null,
    rank: o.rank ?? 20,
  };
}

function opencodeBin() {
  return process.env.SENTINEL_OPENCODE_BIN || process.env.OPENCODE_BIN || "opencode";
}

export async function getNimCatalog({ force = false } = {}) {
  const now = nowMs();
  if (!force && nimCache.list.length && now - nimCache.at < NIM_TTL_MS) return nimCache.list;
  try {
    const { stdout } = await run(opencodeBin(), ["models", "nvidia"], { timeout: 40_000, maxBuffer: 4 << 20 });
    nimCache = {
      at: now,
      // `opencode models nvidia` prints FULL KEYS (`nvidia/<id>`), and for
      // NVIDIA-org models the id itself starts with `nvidia/`. Strip exactly one
      // leading provider segment and keep the rest verbatim, so the key
      // round-trips to what opencode actually serves.
      list: [...new Set(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .map((l) => { const i = l.indexOf("/"); return i > 0 ? l.slice(i + 1) : l; })
        .filter((id) => id && !NVIDIA_DENY.test(id)))].map(mkNim),
    };
  } catch {
    // No opencode binary, no nvidia catalog. Empty, and said so.
    nimCache = { at: now, list: [] };
  }
  return nimCache.list;
}

// ---------- scoring ----------
export function abilityScore(m) {
  const ctx = m.context || 0;
  const ctxPts = ctx >= 1_000_000 ? 40 : ctx >= 500_000 ? 34 : ctx >= 200_000 ? 28 : ctx >= 128_000 ? 22 : ctx >= 32_000 ? 16 : ctx > 0 ? 10 : 18;
  const toolsPts = m.tools === false ? 0 : 20;
  const rankPts = Math.max(0, Math.min(40, m.rank ?? 20));
  return Math.max(0, Math.min(100, ctxPts + toolsPts + rankPts));
}

export function availabilityScore(obs, probe) {
  let a = 100;
  a -= 18 * inWindow(obs?.hard, HARD_WINDOW_MS).length;
  a -= 5 * inWindow(obs?.soft, SOFT_WINDOW_MS).length;
  if (probe) {
    if (probe.ok) a += Math.max(0, 6 - Math.round((probe.ms || 0) / 2000));
    else if (nowMs() - new Date(probe.at).getTime() < PROBE_TTL_MS) a -= 45;
  }
  return Math.max(0, Math.min(100, Math.round(a)));
}

function circuitUntil(obs) {
  const recent = inWindow(obs?.hard, PROBE_TTL_MS);
  if (recent.length >= CIRCUIT_THRESHOLD) return new Date(recent[recent.length - 1] + CIRCUIT_COOLDOWN_MS).toISOString();
  return null;
}

export function scoreModel(m, obs, probe) {
  const ability = abilityScore(m);
  const availability = availabilityScore(obs, probe);
  const circuit = circuitUntil(obs);
  const recentFail = probe && !probe.ok && nowMs() - new Date(probe.at).getTime() < PROBE_TTL_MS;
  return {
    key: m.key,
    providerID: m.providerID,
    id: m.id,
    name: m.name || m.id,
    context: m.context || null,
    tools: m.tools !== false,
    rank: m.rank,
    ability,
    availability,
    score: Math.round(0.55 * ability + 0.45 * availability),
    available: !circuit && !recentFail && availability >= 25,
    circuit_until: circuit,
  };
}

// ---------- discovery ----------
/**
 * The free pool, with provenance. `served_live` is true ONLY when a live source
 * answered this run; entries read from the cache are labelled `cache` and never
 * counted as a live check.
 */
export async function discover({ skipCacheWrite = false } = {}) {
  const byKey = new Map();
  let servedLive = false;
  const notes = [];

  // 1. the operator's command
  const command = process.env.ACE_FREE_MODEL_COMMAND;
  if (command) {
    const { models, error } = await discoverFromCommand(command);
    if (error) notes.push(error);
    for (const m of models) byKey.set(m.key, m);
    if (models.length) servedLive = true;
  }

  // 2. the live catalogs
  const opencodeFree = await getOpencodeFreeCatalog();
  if (opencodeFree.length) servedLive = true;
  for (const m of opencodeFree) if (!byKey.has(m.key)) byKey.set(m.key, { ...m, free_source: "live-catalog" });

  const nim = await getNimCatalog();
  if (nim.length) servedLive = true;
  for (const m of nim) if (!byKey.has(m.key)) byKey.set(m.key, { ...m, free_source: "nim-free-list" });

  const live = [...byKey.values()].filter((m) => m.free === true && !BANNED.test(m.key));

  // 3. whatever the last successful discovery measured, labelled as a cache
  let cachedAt = null;
  if (!servedLive) {
    const cache = readJson(CACHE_FILE(), null);
    const cached = (cache?.models || []).filter((m) => m.free === true && !BANNED.test(m.key));
    for (const m of cached) if (!byKey.has(m.key)) byKey.set(m.key, { ...m, free_source: "cache" });
    cachedAt = cache?.measured_at || null;
    if (cached.length) notes.push(`no live source answered — using the cache measured at ${cachedAt}`);
  } else if (!skipCacheWrite) {
    // A live measurement is the only thing allowed to refresh the cache.
    writeJson(CACHE_FILE(), { measured_at: iso(), served_live: true, count: live.length, models: live });
  }

  const pool = [...byKey.values()].filter((m) => m.free === true && !BANNED.test(m.key));
  const rt = loadRuntime();
  const models = pool
    .map((m) => ({ ...m, ...scoreModel(m, rt.obs[m.key], rt.probes[m.key]), free: true, free_source: m.free_source }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.key).localeCompare(String(b.key)));

  return {
    at: iso(),
    served_live: servedLive,
    cache_age_ms: cachedAt ? nowMs() - new Date(cachedAt).getTime() : null,
    cached_verified_at: cachedAt,
    count: models.length,
    models,
    notes,
    runtime_updated_at: rt.updated_at || null,
  };
}

/** Thrown instead of dispatching on a paid or unknown model. */
export class FreeModelUnavailable extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "FreeModelUnavailable";
    this.detail = detail;
  }
}

/**
 * Best available verified-free model. Ranked locally by this module's own score
 * (ability from context/tools/rank, availability from observed failures and
 * probes); excludes open circuits, excluded keys and models benched by this
 * orchestrator's own cooldown.
 *
 * The `row.free === true` guard is not defensive coding: it is the hard rule. A
 * model that cannot be shown free does not receive work.
 */
export async function select({ exclude = [], requireTools = true, failover = null } = {}) {
  const pool = await discover();
  const skip = new Set(exclude.filter(Boolean));
  const f = failover;
  const benched = (key) => (f ? f.inCooldown(key) || f.circuitOpen(key) : false);

  if (!pool.count) {
    throw new FreeModelUnavailable(
      "no verified free model available — refusing to dispatch. Supply a verified free pool with ACE_FREE_MODEL_COMMAND, or start the opencode serve catalog. Nothing falls back to a paid model.",
      { served_live: pool.served_live, notes: pool.notes || [] }
    );
  }

  const candidates = pool.models
    .filter((m) => m.free === true && !skip.has(m.key) && !benched(m.key) && (!requireTools || m.tools !== false))
    // A model this repo has already seen as unavailable (circuit open, or a
    // failing probe inside the TTL) goes last rather than out: refusing the whole
    // dispatch because every model carries an old failure would be worse than
    // trying the least-bad verified-free one.
    .sort(
      (a, b) =>
        Number(b.available !== false) - Number(a.available !== false) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        (b.context ?? 0) - (a.context ?? 0) ||
        String(a.key).localeCompare(String(b.key))
    );

  const pick = candidates[0];
  if (pick) return { ...pick, free: true, free_source: pick.free_source, pool: { count: pool.count, served_live: pool.served_live } };

  const allBenched = pool.models.every((m) => skip.has(m.key) || benched(m.key));
  throw new FreeModelUnavailable(
    allBenched ? "every verified free model is benched or excluded" : `no free model with tool support (${pool.count} in the pool)`,
    { excluded: [...skip], served_live: pool.served_live }
  );
}

// ---------- provider health: cooldown, circuit, recovery ----------
/**
 * The failover state machine, bound to an injected probe, observation sink and
 * state file. Injecting them is what lets the selftest drive a real provider
 * failure through the real code path.
 */
export function createFailover({
  observe = recordOutcome,
  probe = probeModel,
  stateFile = path.join(globalStateDir(), "providers.json"),
  limits = DEFAULTS,
  ledgerPath = null,
} = {}) {
  const cfg = { ...DEFAULTS, ...limits };

  function load() {
    return readJson(stateFile, { updated_at: null, models: {} });
  }

  function save(state) {
    state.updated_at = iso();
    writeJson(stateFile, state);
    return state;
  }

  function health(key) {
    const s = load();
    return s.models[key] || { key, hard: [], soft: [], switches: 0, recoveries: 0, cooldown_until: null, circuit_until: null, last_error: null };
  }

  function circuitOpen(key) {
    const h = health(key);
    return Boolean(h.circuit_until && nowMs() < new Date(h.circuit_until).getTime());
  }

  function inCooldown(key) {
    const h = health(key);
    return Boolean(h.cooldown_until && nowMs() < new Date(h.cooldown_until).getTime());
  }

  function note(row) {
    if (ledgerPath) appendJsonl(ledgerPath, { at: iso(), ...row });
  }

  /**
   * One provider error in; the decision out: retry, switch, or park.
   * `attempt` is how many tries this mission has already spent, so the retry
   * budget is bounded instead of a loop.
   */
  function onProviderError({ key, error, attempt = 1, project = null, mission = null, resumeFrom = null }) {
    const blocker = isBlockerError(error);
    const kind = blocker ? "hard" : "soft";
    try {
      observe(key, kind, error);
    } catch {
      /* the observation sink is best-effort — never let it break failover */
    }
    const s = load();
    const m = (s.models[key] ||= { key, hard: [], soft: [], switches: 0, recoveries: 0, cooldown_until: null, circuit_until: null, last_error: null });
    m[kind] = [...(m[kind] || []).slice(-40), nowMs()];
    m.last_error = String(error?.message || error).slice(0, 300);
    const recentHard = m.hard.filter((t) => nowMs() - t < cfg.circuitCooldownMs * 2);
    m.cooldown_until = new Date(nowMs() + cfg.cooldownMs).toISOString();
    const circuitOpened = recentHard.length >= cfg.circuitThreshold;
    if (circuitOpened) m.circuit_until = new Date(nowMs() + cfg.circuitCooldownMs).toISOString();
    save(s);

    // attempt = tries already spent (1 = the first try). Allowed tries are
    // 1 + retryLimit, so retriesLeft counts the tries still permitted.
    const retriesLeft = Math.max(0, cfg.retryLimit - (attempt - 1));
    const row = {
      at: iso(),
      project,
      mission,
      from: key,
      classification: kind,
      blocker,
      attempt,
      retries_left: retriesLeft,
      cooldown_until: m.cooldown_until,
      circuit_until: m.circuit_until,
      circuit_opened: circuitOpened,
      hard_in_window: recentHard.length,
      error: m.last_error,
      resume_from: resumeFrom,
    };

    if (circuitOpened) {
      row.action = "park_blocked_provider";
      row.instruction = `provider ${key} failed ${recentHard.length}x inside the window — circuit open until ${m.circuit_until}. The mission keeps its state and its resume point: parked, not dropped.`;
    } else if (!blocker && retriesLeft > 0) {
      row.action = "retry_same_model";
      row.instruction = `transient (non-blocker) error on ${key}; retry after the cooldown (${retriesLeft} retries left).`;
    } else if (retriesLeft > 0) {
      row.action = "retry_same_model";
      row.instruction = `blocker on ${key}; ${retriesLeft} retr${retriesLeft === 1 ? "y" : "ies"} left before switching.`;
    } else {
      row.action = "switch_model";
      m.switches = (m.switches || 0) + 1;
      save(s);
      row.instruction = `${key} is benched until ${m.cooldown_until}; hand the mission, with its resume point, to the next verified free model.`;
    }
    note(row);
    return row;
  }

  /** Benched providers whose circuit has expired — candidates for a recheck. */
  function recoveryDue() {
    const s = load();
    return Object.values(s.models)
      .filter((m) => m.circuit_until && nowMs() >= new Date(m.circuit_until).getTime())
      .map((m) => m.key);
  }

  /**
   * Provider recovery: restore ONLY on a passing probe, and write the restore to
   * the ledger so it is never silent. Until then the circuit stays open, which is
   * what stops the orchestrator thrashing between models.
   */
  async function tryRecover({ keys = null, project = null } = {}) {
    const candidates = keys || recoveryDue();
    const results = [];
    for (const key of candidates) {
      const h = await probe(key);
      const s = load();
      const m = s.models[key];
      if (!m) continue;
      if (h.ok) {
        m.circuit_until = null;
        m.cooldown_until = null;
        m.hard = [];
        m.recoveries = (m.recoveries || 0) + 1;
        results.push({ key, restored: true, ms: h.ms });
        note({ kind: "provider_recovered", project, key, ms: h.ms });
      } else {
        m.circuit_until = new Date(nowMs() + cfg.circuitCooldownMs).toISOString();
        results.push({ key, restored: false, error: h.error });
        note({ kind: "provider_recovery_failed", project, key, error: h.error });
      }
      save(s);
    }
    return results;
  }

  return { limits: cfg, stateFile, load, save, health, circuitOpen, inCooldown, onProviderError, recoveryDue, tryRecover, _probe: probe };
}

/**
 * A real availability check: one one-shot run on the model.
 *
 * Default is the lab's real probe, which is portable — `opencode run --model
 * <key> "Reply with exactly: ok"` in a temp dir, with a timeout — so a circuit
 * is cleared on a MEASURED pass and not on a hope. `ACE_MODEL_PROBE_COMMAND`
 * overrides it (`{key}` is substituted) for a host whose harness is not
 * opencode. When neither can run, the result is a refusal, never a pass.
 */
export function probeModel(key) {
  const templated = process.env.ACE_MODEL_PROBE_COMMAND;
  if (templated) {
    return new Promise((resolve) => {
      const started = nowMs();
      const command = templated.includes("{key}") ? templated.split("{key}").join(key) : `${templated} ${key}`;
      execFile(command, { shell: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve({ ok: false, ms: nowMs() - started, error: String(err.message || err).slice(0, 300) });
        const text = String(stdout).toLowerCase();
        if (/rate.?limit|too many requests|quota|429|503|context length|token limit/.test(text)) return resolve({ ok: false, ms: nowMs() - started, error: "provider blocker" });
        resolve({ ok: true, ms: nowMs() - started, error: null });
      });
    });
  }

  return new Promise((resolve) => {
    const started = nowMs();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-probe-"));
    let stdout = "";
    let settled = false;
    // `timer` is declared before `finish` can run: spawn() can throw
    // synchronously, and `clearTimeout(timer)` on a not-yet-initialised const
    // would throw a ReferenceError inside the error path.
    let timer = null;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve({ ok, ms: nowMs() - started, error });
    };
    let child;
    try {
      child = spawn(opencodeBin(), ["run", "--model", key, "Reply with exactly: ok"], {
        cwd: tmp,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: process.env.HOME || os.homedir() },
      });
    } catch (e) {
      finish(false, `probe could not start: ${e.message}`);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish(false, `timeout ${PROBE_TIMEOUT_MS}ms`);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("error", (e) => finish(false, e.message));
    child.on("close", (code) => {
      const text = stdout.toLowerCase();
      if (code !== 0) return finish(false, `exit ${code}`);
      if (/rate.?limit|too many requests|quota|429|503|context length|token limit/.test(text)) return finish(false, "provider blocker");
      if (!/ok/.test(text)) return finish(false, "no confirmation");
      finish(true, null);
    });
  });
}

/** Real availability check, recorded to the local runtime. */
export async function healthCheck(key) {
  const result = await probeModel(key);
  try {
    recordProbe(key, Boolean(result.ok), result.ms, result.error);
    recordOutcome(key, result.ok ? "recover" : "hard", result.ok ? "orchestration health check passed" : `orchestration health check failed: ${result.error}`);
  } catch {
    /* local runtime is best-effort */
  }
  return { key, at: iso(), ...result };
}

/** The instance the orchestrator uses. */
export const failover = createFailover();
