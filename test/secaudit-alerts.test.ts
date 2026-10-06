import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TelegramSink, WebhookSink, formatAlert, formatAlertHtml } from "../src/alerts.js";
import type { Anomaly } from "../src/types.js";

// SECAUDIT step 5(c): alert sinks. No network: fetch is injected. WEBHOOK_URL, TG_BOT_TOKEN and
// TG_CHAT_ID come only from the operator environment (grep over src: no HTTP route or tool sets them),
// so SSRF through them requires control of the operator's env, not external input.

const TOKEN = "123456:SECRET_TOKEN_VALUE";
const evil = (text: string): Anomaly =>
  ({ type: "NEW_VENUE", wallet: "W", severity: "high", timestamp: 1, evidence: {}, text }) as Anomaly;

function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  return fn().then(
    () => {
      console.error = orig;
      return { lines };
    },
    (e) => {
      console.error = orig;
      throw e;
    },
  );
}

describe("secaudit alerts", () => {
  test("formatAlertHtml escapes anomaly text, type, label, digest and defense state", () => {
    const html = formatAlertHtml("W".repeat(40), 80, [evil(`<a href="https://evil.example">x</a>`)], {
      label: `<b>l</b>`,
      digest: `<script>x</script>`,
      defenseState: `<i>s</i>`,
    });
    assert.ok(!html.includes(`<a href="https://evil.example">`));
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<i>s</i>"));
    assert.ok(html.includes("&lt;a href=&quot;https://evil.example&quot;&gt;"));
  });

  test("a failed Telegram send never prints the bot token (status + response body only)", async () => {
    const sink = new TelegramSink(TOKEN, "1", (async () => ({ ok: false, status: 401, text: async () => '{"ok":false,"description":"Unauthorized"}' })) as unknown as typeof fetch);
    const { lines } = await captureConsoleError(() => sink.send("hello"));
    assert.ok(lines.length > 0);
    assert.ok(!lines.join("\n").includes("SECRET_TOKEN_VALUE"));
  });

  test("a throwing Telegram fetch is swallowed (alerts must not break the watch loop) and logs only the message", async () => {
    const sink = new TelegramSink(TOKEN, "1", (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch);
    const { lines } = await captureConsoleError(() => sink.send("hello"));
    assert.deepEqual(lines, ["telegram alert failed: fetch failed"]);
  });

  test("WebhookSink posts only {wallet,risk,anomalies} to the configured URL, with a timeout and no extra fields", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const sink = new WebhookSink("https://hooks.example.test/in", (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch);
    process.env.HELIUS_API_KEY = "must-not-leak";
    try {
      await sink.send("text", { wallet: "W", risk: 5, anomalies: [] });
    } finally {
      delete process.env.HELIUS_API_KEY;
    }
    assert.ok(seen);
    const s = seen as { url: string; init: RequestInit };
    assert.equal(s.url, "https://hooks.example.test/in");
    assert.deepEqual(Object.keys(JSON.parse(String(s.init.body))).sort(), ["anomalies", "risk", "wallet"]);
    assert.ok(s.init.signal, "request must carry a timeout signal");
    assert.ok(!String(s.init.body).includes("must-not-leak"));
  });
});

describe("secaudit alerts: KNOWN GAP (Low, see docs/KNOWN-ISSUES.md)", () => {
  // TelegramSink switches to parse_mode=HTML whenever the plain-text message contains "<b>" or "<code>".
  // formatAlert() (plain text) does not escape anomaly text, so text carrying markup would be parsed as
  // Telegram HTML (link injection into the operator's alert channel, or a 400 that drops the alert).
  // Current anomaly texts embed only numbers, base58 addresses and Helius venue names, so reaching this
  // needs hostile text in the upstream data. Not fixed in this pass (Low).
  test("plain-text alerts must not be sent with parse_mode HTML because of attacker-supplied markup", { todo: "Low: parse mode auto-detect on unescaped text" }, async () => {
    let body: Record<string, unknown> = {};
    const sink = new TelegramSink(TOKEN, "1", (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch);
    await sink.send(formatAlert("W", 50, [evil(`<b>x</b><a href="https://evil.example">y</a>`)]));
    assert.notEqual(body.parse_mode, "HTML");
  });
});

import { renderHtmlReport } from "../src/htmlreport.js";

describe("secaudit CLI export: HTML report escapes hostile values (step 5(г))", () => {
  test("wallet, anomaly type and text cannot inject markup into `radar history --export`", () => {
    const html = renderHtmlReport({
      wallet: `<img src=x onerror=alert(1)>`,
      riskScore: 50,
      verdict: "SUSPICIOUS",
      baseline: null,
      anomalies: [{ type: "X<script>", wallet: "W", severity: "high", timestamp: 1, evidence: {}, text: `<svg onload=alert(1)>` } as never],
      window: { sinceSec: null, untilSec: null },
      generatedAt: 1,
    } as never);
    assert.ok(!html.includes("<img src=x onerror=alert(1)>"));
    assert.ok(!html.includes("<svg onload=alert(1)>"));
    assert.ok(!html.includes("X<script>"));
  });
});
