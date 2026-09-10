import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AlertPayload,
  ConsoleSink,
  MultiSink,
  TelegramSink,
  WebhookSink,
  makeSink,
} from "../src/alerts.js";
import { Anomaly } from "../src/types.js";

const SAMPLE_ANOMALIES: Anomaly[] = [
  {
    type: "ACTIVITY_BURST",
    wallet: "W1",
    severity: "medium",
    timestamp: 1000,
    evidence: { txCount: 5, windowSec: 600 },
    text: "5 transactions in 10 min.",
  },
  {
    type: "LARGE_SWAP",
    wallet: "W1",
    severity: "high",
    timestamp: 1005,
    evidence: { usd: 5000, medianUsd: 1000 },
    text: "Swap of ~$5000 is 5x the median.",
  },
];

test("WebhookSink: POSTs compact JSON {wallet, risk, anomalies} to WEBHOOK_URL", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const mockFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const sink = new WebhookSink("https://hooks.example.com/alerts", mockFetch);
  const payload: AlertPayload = {
    wallet: "W1",
    risk: 65,
    anomalies: SAMPLE_ANOMALIES,
  };

  await sink.send("wallet-radar: W1 — risk 65/100", payload);

  assert.equal(capturedUrl, "https://hooks.example.com/alerts");
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(capturedInit?.headers, { "Content-Type": "application/json" });

  const body = JSON.parse(String(capturedInit?.body));
  assert.deepEqual(body, {
    wallet: "W1",
    risk: 65,
    anomalies: SAMPLE_ANOMALIES,
  });
});

test("WebhookSink: fallback to { text } when payload is omitted", async () => {
  let capturedBody: unknown;

  const mockFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response("ok", { status: 200 });
  };

  const sink = new WebhookSink("https://hooks.example.com/alerts", mockFetch);
  await sink.send("raw alert text");

  assert.deepEqual(capturedBody, { text: "raw alert text" });
});

test("WebhookSink: best-effort on HTTP error status (does not throw)", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response("Internal Server Error", { status: 500 });

  const sink = new WebhookSink("https://hooks.example.com/alerts", mockFetch);
  // Must resolve cleanly without throwing
  await assert.doesNotReject(async () => {
    await sink.send("test", { wallet: "W1", risk: 50, anomalies: [] });
  });
});

test("WebhookSink: best-effort on network failure (does not throw)", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
  };

  const sink = new WebhookSink("https://hooks.example.com/alerts", mockFetch);
  // Must resolve cleanly without throwing
  await assert.doesNotReject(async () => {
    await sink.send("test", { wallet: "W1", risk: 50, anomalies: [] });
  });
});

test("TelegramSink: POSTs chat_id and text, best-effort on errors", async () => {
  let capturedUrl = "";
  let capturedBody: unknown;

  const mockFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const sink = new TelegramSink("test-token", "12345", mockFetch);
  await sink.send("alert message");

  assert.equal(capturedUrl, "https://api.telegram.org/bottest-token/sendMessage");
  assert.deepEqual(capturedBody, { chat_id: "12345", text: "alert message" });

  // Test failure does not throw
  const errorFetch: typeof fetch = async () => {
    throw new Error("Telegram timeout");
  };
  const failingSink = new TelegramSink("test-token", "12345", errorFetch);
  await assert.doesNotReject(async () => {
    await failingSink.send("alert message");
  });
});

test("MultiSink: delivers to multiple sinks concurrently", async () => {
  const calls: string[] = [];
  const sinkA = {
    async send(text: string, payload?: AlertPayload) {
      calls.push(`A:${text}:${payload?.wallet}`);
    },
  };
  const sinkB = {
    async send(text: string, payload?: AlertPayload) {
      calls.push(`B:${text}:${payload?.wallet}`);
    },
  };

  const multi = new MultiSink([sinkA, sinkB]);
  await multi.send("msg", { wallet: "W1", risk: 40, anomalies: [] });

  assert.deepEqual(calls, ["A:msg:W1", "B:msg:W1"]);
});

test("makeSink: picks sink based on environment variables", () => {
  const saved = {
    tgToken: process.env.TG_BOT_TOKEN,
    tgChat: process.env.TG_CHAT_ID,
    webhook: process.env.WEBHOOK_URL,
  };

  try {
    delete process.env.TG_BOT_TOKEN;
    delete process.env.TG_CHAT_ID;
    delete process.env.WEBHOOK_URL;

    // Default: console
    const s1 = makeSink();
    assert.ok(s1 instanceof ConsoleSink);

    // Only Webhook
    process.env.WEBHOOK_URL = "https://example.com/webhook";
    const s2 = makeSink();
    assert.ok(s2 instanceof WebhookSink);

    // Only Telegram
    delete process.env.WEBHOOK_URL;
    process.env.TG_BOT_TOKEN = "tok";
    process.env.TG_CHAT_ID = "chat";
    const s3 = makeSink();
    assert.ok(s3 instanceof TelegramSink);

    // Both Telegram and Webhook -> MultiSink
    process.env.WEBHOOK_URL = "https://example.com/webhook";
    const s4 = makeSink();
    assert.ok(s4 instanceof MultiSink);
  } finally {
    if (saved.tgToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = saved.tgToken;
    if (saved.tgChat === undefined) delete process.env.TG_CHAT_ID;
    else process.env.TG_CHAT_ID = saved.tgChat;
    if (saved.webhook === undefined) delete process.env.WEBHOOK_URL;
    else process.env.WEBHOOK_URL = saved.webhook;
  }
});
