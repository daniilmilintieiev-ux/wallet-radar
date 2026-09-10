import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestEffortDigest,
  buildPrompt,
  llmConfigFromEnv,
  llmDigest,
  LlmConfig,
} from "../src/llmdigest.js";
import { Anomaly } from "../src/types.js";

const ANOMALIES: Anomaly[] = [
  {
    type: "DORMANT_ACTIVE",
    wallet: "W1",
    severity: "high",
    timestamp: 1,
    evidence: { daysSilent: 82 },
    text: "Wallet reactivated after ~82 days of inactivity.",
  },
  {
    type: "LARGE_SWAP",
    wallet: "W1",
    severity: "high",
    timestamp: 2,
    evidence: { usd: 5000 },
    text: "Swap of ~$5000 is 3x the wallet's median.",
  },
];

const CFG: LlmConfig = { baseUrl: "https://llm.test/v1", apiKey: "k", model: "test-model" };

function okFetch(content: string): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

test("llmConfigFromEnv: null without key, defaults with key, env overrides", () => {
  const saved = {
    key: process.env.RADAR_LLM_KEY,
    base: process.env.RADAR_LLM_BASE,
    model: process.env.RADAR_LLM_MODEL,
  };
  try {
    delete process.env.RADAR_LLM_KEY;
    assert.equal(llmConfigFromEnv(), null);

    process.env.RADAR_LLM_KEY = "sk-test";
    const def = llmConfigFromEnv();
    assert.ok(def);
    assert.equal(def.baseUrl, "https://api.openai.com/v1");
    assert.equal(def.model, "gpt-4o-mini");

    process.env.RADAR_LLM_BASE = "https://custom.test/v1";
    process.env.RADAR_LLM_MODEL = "custom-model";
    const over = llmConfigFromEnv();
    assert.ok(over);
    assert.equal(over.baseUrl, "https://custom.test/v1");
    assert.equal(over.model, "custom-model");

    // RADAR_LLM_URL fallback when RADAR_LLM_BASE is unset
    delete process.env.RADAR_LLM_BASE;
    process.env.RADAR_LLM_URL = "https://url-fallback.test/v1";
    const fallbackUrl = llmConfigFromEnv();
    assert.ok(fallbackUrl);
    assert.equal(fallbackUrl.baseUrl, "https://url-fallback.test/v1");
  } finally {
    delete process.env.RADAR_LLM_URL;
    if (saved.key === undefined) delete process.env.RADAR_LLM_KEY;
    else process.env.RADAR_LLM_KEY = saved.key;
    if (saved.base === undefined) delete process.env.RADAR_LLM_BASE;
    else process.env.RADAR_LLM_BASE = saved.base;
    if (saved.model === undefined) delete process.env.RADAR_LLM_MODEL;
    else process.env.RADAR_LLM_MODEL = saved.model;
  }
});

test("llmConfigFromEnv: RADAR_LLM_OPTIONS parsed into config; bad JSON ignored", () => {
  const saved = {
    key: process.env.RADAR_LLM_KEY,
    opts: process.env.RADAR_LLM_OPTIONS,
  };
  try {
    process.env.RADAR_LLM_KEY = "sk-test";
    delete process.env.RADAR_LLM_OPTIONS;
    assert.equal(llmConfigFromEnv()?.options, undefined);

    process.env.RADAR_LLM_OPTIONS = '{"num_thread": 8}';
    assert.deepEqual(llmConfigFromEnv()?.options, { num_thread: 8 });

    process.env.RADAR_LLM_OPTIONS = "{not json";
    assert.equal(llmConfigFromEnv()?.options, undefined);
  } finally {
    if (saved.key === undefined) delete process.env.RADAR_LLM_KEY;
    else process.env.RADAR_LLM_KEY = saved.key;
    if (saved.opts === undefined) delete process.env.RADAR_LLM_OPTIONS;
    else process.env.RADAR_LLM_OPTIONS = saved.opts;
  }
});

test("llmConfigFromEnv: RADAR_LLM_TIMEOUT_MS parsed; invalid falls back to default", () => {
  const saved = {
    key: process.env.RADAR_LLM_KEY,
    to: process.env.RADAR_LLM_TIMEOUT_MS,
  };
  try {
    process.env.RADAR_LLM_KEY = "sk-test";
    delete process.env.RADAR_LLM_TIMEOUT_MS;
    assert.equal(llmConfigFromEnv()?.timeoutMs, 15_000);

    process.env.RADAR_LLM_TIMEOUT_MS = "30000";
    assert.equal(llmConfigFromEnv()?.timeoutMs, 30_000);

    process.env.RADAR_LLM_TIMEOUT_MS = "abc";
    assert.equal(llmConfigFromEnv()?.timeoutMs, 15_000);

    process.env.RADAR_LLM_TIMEOUT_MS = "-5";
    assert.equal(llmConfigFromEnv()?.timeoutMs, 15_000);
  } finally {
    if (saved.key === undefined) delete process.env.RADAR_LLM_KEY;
    else process.env.RADAR_LLM_KEY = saved.key;
    if (saved.to === undefined) delete process.env.RADAR_LLM_TIMEOUT_MS;
    else process.env.RADAR_LLM_TIMEOUT_MS = saved.to;
  }
});

test("llmDigest: RADAR_LLM_PATH configures endpoint; Ollama response shape parsed", async () => {
  const savedKey = process.env.RADAR_LLM_KEY;
  const savedOpts = process.env.RADAR_LLM_OPTIONS;
  const savedPath = process.env.RADAR_LLM_PATH;
  try {
    process.env.RADAR_LLM_KEY = "sk-test";
    delete process.env.RADAR_LLM_OPTIONS;
    process.env.RADAR_LLM_PATH = "chat";
    const cfg = llmConfigFromEnv();
    assert.ok(cfg);
    assert.equal(cfg.path, "chat");

    let seenUrl = "";
    const ollamaFetch: typeof fetch = async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ message: { content: "Ollama says hi." } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const out = await llmDigest(
      "W1",
      65,
      ANOMALIES,
      { baseUrl: "http://127.0.0.1:11434/api", apiKey: "k", model: "m", path: "chat" },
      ollamaFetch,
    );
    assert.equal(out, "Ollama says hi.");
    assert.equal(seenUrl, "http://127.0.0.1:11434/api/chat");
    assert.equal(cfg.path, "chat");
  } finally {
    if (savedKey === undefined) delete process.env.RADAR_LLM_KEY;
    else process.env.RADAR_LLM_KEY = savedKey;
    if (savedOpts === undefined) delete process.env.RADAR_LLM_OPTIONS;
    else process.env.RADAR_LLM_OPTIONS = savedOpts;
    if (savedPath === undefined) delete process.env.RADAR_LLM_PATH;
    else process.env.RADAR_LLM_PATH = savedPath;
  }
});

test("llmDigest: config options forwarded in request body", async () => {
  let seenBody: unknown;
  const captureFetch: typeof fetch = async (input, init) => {
    seenBody = JSON.parse(String(init?.body));
    return okFetch("ok")("https://llm.test/v1/chat/completions", init);
  };
  const cfg: LlmConfig = {
    baseUrl: "https://llm.test/v1",
    apiKey: "k",
    model: "test-model",
    options: { num_thread: 8 },
  };
  await llmDigest("W1", 65, ANOMALIES, cfg, captureFetch);
  assert.deepEqual((seenBody as Record<string, unknown>).options, { num_thread: 8 });
});

test("buildPrompt: deterministic, contains wallet/risk/anomalies", () => {
  const p = buildPrompt("W1", 65, ANOMALIES);
  assert.match(p, /Wallet: W1/);
  assert.match(p, /Risk score: 65\/100/);
  assert.match(p, /\[HIGH\] DORMANT_ACTIVE/);
  assert.match(p, /\[HIGH\] LARGE_SWAP/);
  assert.equal(buildPrompt("W1", 65, ANOMALIES), p);
});

test("llmDigest: success returns trimmed content", async () => {
  const out = await llmDigest("W1", 65, ANOMALIES, CFG, okFetch("  Whale woke up and made a big swap.  "));
  assert.equal(out, "Whale woke up and made a big swap.");
});

test("llmDigest: http error / network error / empty content -> null", async () => {
  const errFetch: typeof fetch = async () => new Response("boom", { status: 500 });
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, errFetch), null);

  const throwFetch: typeof fetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, throwFetch), null);

  const emptyFetch = okFetch("   ");
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, emptyFetch), null);
});

test("bestEffortDigest: no config -> template; failed call -> fallback; ok -> llm", async () => {
  const r0 = await bestEffortDigest("W1", 65, ANOMALIES, null);
  assert.equal(r0.source, "template");
  assert.match(r0.digest, /reactivated after ~82 days/);

  const r1 = await bestEffortDigest(
    "W1",
    65,
    ANOMALIES,
    CFG,
    (async () => {
      throw new Error("down");
    }) as typeof fetch,
  );
  assert.equal(r1.source, "template");

  const r2 = await bestEffortDigest("W1", 65, ANOMALIES, CFG, okFetch("Custom llm summary."));
  assert.equal(r2.source, "llm");
  assert.equal(r2.digest, "Custom llm summary.");
});

test("llmDigest: degrades gracefully on timeout (returns null)", async () => {
  const timeoutCfg: LlmConfig = {
    ...CFG,
    timeoutMs: 10,
  };
  const slowFetch: typeof fetch = async (_input, init) => {
    return new Promise((resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      }
    });
  };

  const res = await llmDigest("W1", 65, ANOMALIES, timeoutCfg, slowFetch);
  assert.equal(res, null);

  const bestEffort = await bestEffortDigest("W1", 65, ANOMALIES, timeoutCfg, slowFetch);
  assert.equal(bestEffort.source, "template");
  assert.match(bestEffort.digest, /reactivated after ~82 days/);
});

test("llmDigest: degrades gracefully on bad or unexpected JSON shapes", async () => {
  // 1. Invalid JSON syntax (e.g. HTML 502 / proxy page)
  const htmlFetch: typeof fetch = async () =>
    new Response("<html>Bad Gateway</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, htmlFetch), null);

  // 2. Non-object JSON (null, primitive string, number)
  const nullJsonFetch: typeof fetch = async () =>
    new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, nullJsonFetch), null);

  // 3. Empty object
  const emptyObjFetch: typeof fetch = async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, emptyObjFetch), null);

  // 4. Empty choices array
  const emptyChoicesFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, emptyChoicesFetch), null);

  // 5. Choices with empty or non-string message content
  const malformedChoiceFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, malformedChoiceFetch), null);

  // 6. Error payload from provider (e.g. { error: "overloaded" })
  const errorObjFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  assert.equal(await llmDigest("W1", 65, ANOMALIES, CFG, errorObjFetch), null);
});

test("bestEffortDigest: never throws into the watch loop on synchronous/non-Error exceptions", async () => {
  // Synchronous throw
  const syncThrowFetch: typeof fetch = () => {
    throw new TypeError("Failed to parse URL");
  };
  const r1 = await bestEffortDigest("W1", 65, ANOMALIES, CFG, syncThrowFetch);
  assert.equal(r1.source, "template");
  assert.ok(r1.digest.length > 0);

  // Non-Error rejection (string/primitive throw)
  const stringThrowFetch: typeof fetch = async () => {
    throw "unhandled promise rejection string";
  };
  const r2 = await bestEffortDigest("W1", 65, ANOMALIES, CFG, stringThrowFetch);
  assert.equal(r2.source, "template");
  assert.ok(r2.digest.length > 0);
});

