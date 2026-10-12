/**
 * Runtime provider-selection tests for the admin-managed ApplianceClinic AI
 * config: the orchestrator seam that turns a stored config into concrete
 * providers, plus the permanent proof of the remote (OpenAI) adapter contract.
 *
 * Fully offline — an injectable fetchSecret and a fake transport mean NO real
 * secret read and NO model call (paid or local) ever happens.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadAdminInference, _resetCache, AI_CONFIG_SECRET_ID, OPENAI_SECRET_ID, JEV_SECRET_ID } = require("../admin-config.js");
const { resolveProvidersFromAdminConfig, LMStudioProvider, OpenAIProvider, InferenceError } = require("../inference.js");

/** Fake transport that records requests and returns scripted responses. */
function fakeTransport({ nonStreamBody, streamDeltas = [], streamUsage = null, status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    request(url, opts) { calls.push({ mode: "request", url, headers: opts.headers, body: JSON.parse(opts.body) }); return Promise.resolve({ status, body: nonStreamBody ?? "" }); },
    stream(url, opts) {
      calls.push({ mode: "stream", url, headers: opts.headers, body: JSON.parse(opts.body) });
      for (const d of streamDeltas) opts.onEvent({ choices: [{ delta: { content: d } }] });
      if (streamUsage) opts.onEvent({ usage: streamUsage });
      return Promise.resolve();
    },
  };
}
const okBody = (content, usage) => JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });

// A fetchSecret backed by an in-memory map keyed by secret id.
function fakeSecrets({ config, key, jev } = {}) {
  return async (id) => {
    if (id === AI_CONFIG_SECRET_ID) return config === undefined ? null : JSON.stringify(config);
    if (id === OPENAI_SECRET_ID) return key ? JSON.stringify({ apiKey: key }) : null;
    if (id === JEV_SECRET_ID) return jev ? JSON.stringify(jev) : null;
    return null;
  };
}

describe("loadAdminInference — secret loading & fallback", () => {
  it("returns config:null when the config secret is absent (fall back to local)", async () => {
    _resetCache();
    const r = await loadAdminInference({ now: 1, env: {}, fetchSecret: fakeSecrets({ config: undefined }) });
    expect(r.config).toBe(null);
    expect(r.openaiKey).toBe(null);
    expect(r.jevConfigured).toBe(false);
  });

  it("loads Jev credentials from the dedicated secret and never stores them on the AI config", async () => {
    _resetCache();
    const r = await loadAdminInference({
      now: 1,
      env: {},
      fetchSecret: fakeSecrets({
        config: { routing: { understand: "local", compose: "local" } },
        jev: { accountId: "acct-1", apiToken: "jev-secret-token" },
      }),
    });
    expect(r.jevConfigured).toBe(true);
    expect(r.jev.accountId).toBe("acct-1");
    expect(r.jev.apiToken).toBe("jev-secret-token");
    expect(JSON.stringify(r.config)).not.toContain("jev-secret-token");
  });

  it("accepts CLOUDFLARE_* env as a local-eval override without a secret", async () => {
    _resetCache();
    const r = await loadAdminInference({
      now: 1,
      env: { CLOUDFLARE_ACCOUNT_ID: "env-acct", CLOUDFLARE_API_TOKEN: "env-token" },
      fetchSecret: fakeSecrets({ config: undefined }),
    });
    expect(r.jevConfigured).toBe(true);
    expect(r.jev.accountId).toBe("env-acct");
  });

  it("does NOT read the credential when neither stage routes to frontier", async () => {
    _resetCache();
    let keyRead = false;
    const fetchSecret = async (id) => {
      if (id === OPENAI_SECRET_ID) { keyRead = true; return JSON.stringify({ apiKey: "sk-x" }); }
      return JSON.stringify({ routing: { understand: "local", compose: "local" }, local: {}, frontier: {} });
    };
    const r = await loadAdminInference({ now: 1, env: {}, fetchSecret });
    expect(keyRead).toBe(false);
    expect(r.openaiKey).toBe(null);
  });

  it("reads the credential only when a stage routes to frontier", async () => {
    _resetCache();
    const cfg = { routing: { understand: "frontier", compose: "local" }, local: {}, frontier: { model: "gpt-4o-mini" } };
    const r = await loadAdminInference({ now: 1, env: {}, fetchSecret: fakeSecrets({ config: cfg, key: "sk-live" }) });
    expect(r.openaiKey).toBe("sk-live");
  });

  it("caches within the TTL and re-reads after reset", async () => {
    _resetCache();
    let reads = 0;
    const fetchSecret = async () => { reads++; return JSON.stringify({ routing: { understand: "local", compose: "local" } }); };
    await loadAdminInference({ now: 1000, env: {}, fetchSecret });
    await loadAdminInference({ now: 1000 + 30000, env: {}, fetchSecret }); // within 60s TTL
    expect(reads).toBe(2); // AI config + Jev secret, once
    await loadAdminInference({ now: 1000 + 120000, env: {}, fetchSecret }); // past TTL
    expect(reads).toBe(4);
  });
});

describe("resolveProvidersFromAdminConfig — routing resolution", () => {
  const env = { LM_STUDIO_URL: "https://deployed-lm.example.app" };

  it("null config falls back to env local/local (production baseline)", () => {
    const { understand, compose } = resolveProvidersFromAdminConfig(null, null, env);
    expect(understand).toBeInstanceOf(LMStudioProvider);
    expect(compose).toBeInstanceOf(LMStudioProvider);
    expect(understand.baseUrl).toBe("https://deployed-lm.example.app");
  });

  it("local/local with blank admin endpoint uses the deployed LM_STUDIO_URL", () => {
    const cfg = { routing: { understand: "local", compose: "local" }, local: { endpoint: "", model: "" }, frontier: {} };
    const { understand } = resolveProvidersFromAdminConfig(cfg, null, env);
    expect(understand.baseUrl).toBe("https://deployed-lm.example.app");
  });

  it("admin local endpoint override wins over the deployed default", () => {
    const cfg = { routing: { understand: "local", compose: "local" }, local: { endpoint: "https://override.example.app", model: "qwen" }, frontier: {} };
    const { compose } = resolveProvidersFromAdminConfig(cfg, null, env);
    expect(compose.baseUrl).toBe("https://override.example.app");
    expect(compose.model).toBe("qwen");
  });

  it("selects UNDERSTAND and COMPOSE independently (frontier + local)", () => {
    const cfg = { routing: { understand: "frontier", compose: "local" }, local: {}, frontier: { model: "gpt-4o-mini" } };
    const { understand, compose } = resolveProvidersFromAdminConfig(cfg, "sk-live", env);
    expect(understand).toBeInstanceOf(OpenAIProvider);
    expect(understand.model).toBe("gpt-4o-mini");
    expect(compose).toBeInstanceOf(LMStudioProvider);
  });

  it("frontier routing with NO key throws CONFIG (no silent local fallback)", () => {
    const cfg = { routing: { understand: "frontier", compose: "local" }, local: {}, frontier: { model: "gpt-4o-mini" } };
    let err;
    try { resolveProvidersFromAdminConfig(cfg, null, env); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(InferenceError);
    expect(err.category).toBe("CONFIG");
  });

  it("frontier routing with NO model throws CONFIG", () => {
    const cfg = { routing: { understand: "frontier", compose: "local" }, local: {}, frontier: { model: "" } };
    let err;
    try { resolveProvidersFromAdminConfig(cfg, "sk-live", env); } catch (e) { err = e; }
    expect(err.category).toBe("CONFIG");
  });
});

describe("remote (OpenAI) adapter contract — permanent proof", () => {
  const env = {};
  const frontierCfg = { routing: { understand: "frontier", compose: "frontier" }, local: {}, frontier: { model: "gpt-4o-mini" } };

  it("OpenAI can be selected, requires a key + model, and sends Bearer auth + model", async () => {
    const t = fakeTransport({ nonStreamBody: okBody("hello", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) });
    const { understand } = resolveProvidersFromAdminConfig(frontierCfg, "sk-live", env, { transport: t });
    const res = await understand.infer({ messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 50, stream: false, timeoutMs: 1000 });
    expect(res.text).toBe("hello");
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 }); // usage normalised
    expect(t.calls[0].headers.Authorization).toBe("Bearer sk-live");
    expect(t.calls[0].body.model).toBe("gpt-4o-mini"); // model forwarded
  });

  it("uses GPT-5-compatible params: max_completion_tokens, no temperature/max_tokens/repeat_penalty", async () => {
    const t = fakeTransport({ nonStreamBody: okBody("ok") });
    const { understand } = resolveProvidersFromAdminConfig(frontierCfg, "sk-live", env, { transport: t });
    await understand.infer({ messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 900, repeatPenalty: 1.1, stream: false, timeoutMs: 1000 });
    const body = t.calls[0].body;
    expect(body.max_completion_tokens).toBe(900);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.repeat_penalty).toBeUndefined();
  });

  it("local (LM Studio) still uses classic max_tokens + temperature", async () => {
    const t = fakeTransport({ nonStreamBody: okBody("ok") });
    const { understand } = resolveProvidersFromAdminConfig({ routing: { understand: "local", compose: "local" }, local: {}, frontier: {} }, null, env, { transport: t });
    await understand.infer({ messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 900, stream: false, timeoutMs: 1000 });
    const body = t.calls[0].body;
    expect(body.max_tokens).toBe(900);
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("forwards structured-output response_format to the remote", async () => {
    const t = fakeTransport({ nonStreamBody: okBody("{}") });
    const { understand } = resolveProvidersFromAdminConfig(frontierCfg, "sk-live", env, { transport: t });
    await understand.infer({ messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 50, stream: false, timeoutMs: 1000, responseFormat: { type: "json_object" } });
    expect(t.calls[0].body.response_format).toEqual({ type: "json_object" });
  });

  it("streams remote deltas and normalises the usage frame", async () => {
    const t = fakeTransport({ streamDeltas: ["Hel", "lo"], streamUsage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    const { compose } = resolveProvidersFromAdminConfig(frontierCfg, "sk-live", env, { transport: t });
    const chunks = [];
    const res = await compose.infer({ messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 50, stream: true, timeoutMs: 1000 }, { onDelta: (d) => chunks.push(d) });
    expect(chunks.join("")).toBe("Hello");
    expect(res.text).toBe("Hello");
    expect(res.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(t.calls[0].body.stream_options).toEqual({ include_usage: true }); // asks OpenAI for usage
  });

  it("a provider error message never contains the credential", async () => {
    const throwing = { request: () => Promise.reject(new Error("Request timeout")), stream: () => Promise.reject(new Error("Request timeout")) };
    const { understand } = resolveProvidersFromAdminConfig(frontierCfg, "sk-super-secret", env, { transport: throwing });
    let err;
    try { await understand.infer({ messages: [], temperature: 0, maxTokens: 10, stream: false, timeoutMs: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(InferenceError);
    expect(JSON.stringify({ m: err.message, ...err })).not.toContain("sk-super-secret");
  });
});
