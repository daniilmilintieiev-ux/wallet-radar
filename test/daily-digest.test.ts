import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  buildDailyDigestData,
  formatDailyDigestHtml,
  sendDailyDigest,
  shortAddress,
  escapeHtml,
} from "../src/daily-digest.js";
import { TelegramSink, makeSink } from "../src/alerts.js";

function withTempStore(fn: (store: Store) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "radar-digest-test-"));
  const store = new Store(join(dir, "radar.db"));
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("shortAddress: abbreviates addresses to 4...4", () => {
  assert.equal(shortAddress("GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f"), "GG5A...8Y7f");
  assert.equal(shortAddress("short"), "short");
});

test("escapeHtml: sanitizes HTML entities", () => {
  assert.equal(escapeHtml('<script>alert("1" & \'2\')</script>'), "&lt;script&gt;alert(&quot;1&quot; &amp; &#039;2&#039;)&lt;/script&gt;");
});

test("buildDailyDigestData: handles empty store gracefully", () => {
  withTempStore((store) => {
    const data = buildDailyDigestData(store, { windowHours: 24 });
    assert.equal(data.totalWatched, 0);
    assert.equal(data.totalAnomaliesCount, 0);
    assert.equal(data.flaggedWallets.length, 0);
    assert.equal(data.defenseStats.armed, 0);
    assert.equal(data.economics.revenueUsdc, 0);
  });
});

test("buildDailyDigestData & formatDailyDigestHtml: full aggregation and visual rendering", () => {
  withTempStore((store) => {
    const now = 1_700_000_000;
    const walletPump = "GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f";
    const walletSafe = "scs1NCSTafrUX6RBx113B9YDCepo1QdEzU8WwEkf25i";

    store.addWallet(walletPump);
    store.addWallet(walletSafe);

    // Seen transactions
    store.markSeen(walletPump, [
      { sig: "sig1", ts: now - 3600 },
      { sig: "sig2", ts: now - 1800 },
    ]);
    store.markSeen(walletSafe, [{ sig: "sig3", ts: now - 5000 }]);

    // Anomalies
    store.recordAnomalies(
      [
        {
          type: "TOXIC_MINT",
          wallet: walletPump,
          severity: "high",
          timestamp: now - 3600,
          evidence: { mint: "fakeMint" },
          text: "Token fakeMint has freeze authority",
        },
        {
          type: "REGIME_SHIFT",
          wallet: walletPump,
          severity: "high",
          timestamp: now - 3500,
          evidence: { count: 3 },
          text: "Regime shift detected",
        },
      ],
      now - 3600,
    );

    // Defense state
    store.setDefenseState(walletPump, {
      state: "blocked",
      riskAt: 100,
      setAt: now - 3500,
      quietStreak: 0,
      actions: 1,
    });

    // Economics
    store.recordSettledPayment(
      {
        signature: "paySig1",
        payer: "payer111",
        recipient: "recip111",
        amount: 0.005,
        endpoint: "/scan",
        wallet: walletPump,
      },
      now - 1000,
    );

    store.recordCostEvent({
      ts: now - 1000,
      category: "helius",
      quantity: 1,
      unitPriceUsd: 0.0005,
      totalUsd: 0.0005,
      detail: "scan",
    });

    const data = buildDailyDigestData(store, { nowSec: now, windowHours: 24 });
    assert.equal(data.totalWatched, 2);
    assert.equal(data.activeInWindow, 2);
    assert.equal(data.txsCount, 3);
    assert.equal(data.totalAnomaliesCount, 2);
    assert.equal(data.severityCounts.high, 2);
    assert.equal(data.flaggedWallets.length, 1);
    assert.equal(data.flaggedWallets[0].wallet, walletPump);
    assert.equal(data.flaggedWallets[0].label, "Pump.fun Trader");
    assert.equal(data.flaggedWallets[0].defenseState, "blocked");
    assert.equal(data.defenseStats.blocked, 1);
    assert.equal(data.defenseStats.armed, 1);
    assert.equal(data.economics.revenueUsdc, 0.005);
    assert.equal(data.economics.costUsd, 0.0005);
    assert.equal(data.economics.netUsd, 0.0045);

    // Format HTML
    const html = formatDailyDigestHtml(data);
    assert.ok(html.includes("WALLET RADAR · DAILY DIGEST"));
    assert.ok(html.includes("Pump.fun Trader"));
    assert.ok(html.includes("BLOCKED"));
    assert.ok(html.includes("0.005 USDC"));
    assert.ok(html.includes("radar.cbellory.xyz/dashboard"));
  });
});

test("sendDailyDigest: sends via TelegramSink with HTML mode", async () => {
  await withTempStore(async (store) => {
    let capturedBody: any = null;
    const mockFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const sink = new TelegramSink("fake-token", "12345", mockFetch);
    const res = await sendDailyDigest(store, { sink, windowHours: 24 });

    assert.equal(res.ok, true);
    assert.equal(capturedBody?.chat_id, "12345");
    assert.equal(capturedBody?.parse_mode, "HTML");
    assert.ok(capturedBody?.text.includes("WALLET RADAR · DAILY DIGEST"));
  });
});

test("makeSink: honors RADAR_ALERT_MODE=daily to silence instant watch spam", () => {
  const origMode = process.env.RADAR_ALERT_MODE;
  const origToken = process.env.TG_BOT_TOKEN;
  const origChatId = process.env.TG_CHAT_ID;

  try {
    process.env.TG_BOT_TOKEN = "test-token";
    process.env.TG_CHAT_ID = "12345";

    // 1. Default mode -> TelegramSink active
    delete process.env.RADAR_ALERT_MODE;
    delete process.env.RADAR_INSTANT_ALERTS;
    const activeSink = makeSink();
    assert.ok(activeSink instanceof TelegramSink);

    // 2. Daily mode -> ConsoleSink (instant alerts silenced)
    process.env.RADAR_ALERT_MODE = "daily";
    const quietSink = makeSink();
    assert.equal(quietSink instanceof TelegramSink, false);

    // 3. RADAR_INSTANT_ALERTS=0 -> ConsoleSink (silenced)
    delete process.env.RADAR_ALERT_MODE;
    process.env.RADAR_INSTANT_ALERTS = "0";
    const silencedSink = makeSink();
    assert.equal(silencedSink instanceof TelegramSink, false);
  } finally {
    if (origMode) process.env.RADAR_ALERT_MODE = origMode; else delete process.env.RADAR_ALERT_MODE;
    if (origToken) process.env.TG_BOT_TOKEN = origToken; else delete process.env.TG_BOT_TOKEN;
    if (origChatId) process.env.TG_CHAT_ID = origChatId; else delete process.env.TG_CHAT_ID;
    delete process.env.RADAR_INSTANT_ALERTS;
  }
});
