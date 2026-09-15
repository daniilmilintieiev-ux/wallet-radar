import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeedPages, defaultQuietPolls, defaultMaxPollMs, calculateAdaptiveInterval, watchOnce, watchLoop } from "../src/watch.js";
import { Store } from "../src/store.js";
import { HttpError } from "../src/collector.js";
import { EnhancedTx } from "../src/types.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME_MINT = "Meme111111111111111111111111111111111111111";

function tmpStore() {
  const dir = fs.mkdtempSync(join(tmpdir(), "radar-watch-test-"));
  const dbPath = join(dir, "radar.db");
  const store = new Store(dbPath);
  return { store, dir };
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function makeSwapTx(
  sig: string,
  timestamp: number,
  inMint: string,
  inAmount: number,
  outMint: string,
  outAmount: number,
): EnhancedTx {
  return {
    signature: sig,
    timestamp,
    source: "JUPITER",
    type: "SWAP",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: inMint, rawTokenAmount: { tokenAmount: String(Math.round(inAmount * 1_000_000)), decimals: 6 } }],
      tokenOutputs: [{ mint: outMint, rawTokenAmount: { tokenAmount: String(Math.round(outAmount * 1_000_000)), decimals: 6 } }],
    },
  };
}

test("defaultSeedPages: env parsing and boundary clamping (1..20, default 3)", () => {
  const prevEnv = process.env.RADAR_SEED_PAGES;
  try {
    delete process.env.RADAR_SEED_PAGES;
    assert.equal(defaultSeedPages(), 3);

    process.env.RADAR_SEED_PAGES = "garbage";
    assert.equal(defaultSeedPages(), 3);

    process.env.RADAR_SEED_PAGES = "5";
    assert.equal(defaultSeedPages(), 5);

    // Clamps to 1
    process.env.RADAR_SEED_PAGES = "0";
    assert.equal(defaultSeedPages(), 1);
    process.env.RADAR_SEED_PAGES = "-10";
    assert.equal(defaultSeedPages(), 1);

    // Clamps to 20
    process.env.RADAR_SEED_PAGES = "25";
    assert.equal(defaultSeedPages(), 20);
    process.env.RADAR_SEED_PAGES = "100";
    assert.equal(defaultSeedPages(), 20);
  } finally {
    if (prevEnv !== undefined) process.env.RADAR_SEED_PAGES = prevEnv;
    else delete process.env.RADAR_SEED_PAGES;
  }
});

test("watchOnce: seeded baseline has medianSwapAmountUsd set when prices available", async () => {
  const { store, dir } = tmpStore();
  const wallet = "W_SEED";
  store.addWallet(wallet);

  let seedPagesRequested = 0;
  // Seed history contains 2 swaps: $500 and $700 USDC (median $600)
  const seedBatch: EnhancedTx[] = [
    makeSwapTx("s1", 1_700_000_100, USDC_MINT, 500, MEME_MINT, 50_000),
    makeSwapTx("s2", 1_700_000_200, USDC_MINT, 700, MEME_MINT, 70_000),
  ];

  const fetchSeedHistory = async (w: string, maxPages: number) => {
    seedPagesRequested = maxPages;
    return seedBatch;
  };

  const pricesCalledWith: EnhancedTx[][] = [];
  const fetchPrices = async (txs: EnhancedTx[]) => {
    pricesCalledWith.push(txs);
    return { [USDC_MINT]: 1.0, [MEME_MINT]: 0.01 };
  };

  const sent: string[] = [];
  const sink = { sent, async send(text: string) { sent.push(text); } };

  const report = await watchOnce(store, "dummy_key", {
    seedPages: 4,
    fetchSeedHistory,
    fetchPrices,
    sink,
    usePrices: true,
    nowSec: 1_700_000_300,
  });

  // Verification
  assert.equal(seedPagesRequested, 4);
  assert.equal(report.wallets.length, 1);
  const wReport = report.wallets[0];
  assert.equal(wReport.wallet, wallet);
  assert.equal(wReport.seeded, true);
  assert.equal(wReport.anomalyCount, 0);
  assert.equal(wReport.riskScore, 0);
  assert.equal(sent.length, 0);

  // Prices were fetched during seed!
  assert.equal(pricesCalledWith.length, 1);

  // Baseline has medianSwapAmountUsd set immediately!
  const baseline = store.getBaseline(wallet);
  assert.ok(baseline !== null);
  assert.equal(baseline.medianSwapAmountUsd, 600);
  assert.equal(baseline.txCount, 2);

  store.close();
  cleanup(dir);
});

test("watchOnce: no alerts fire during seed even if seed batch contains burst and large swap patterns", async () => {
  const { store, dir } = tmpStore();
  const wallet = "W_SILENT";
  store.addWallet(wallet);

  // Batch with 10 rapid swaps within 60 seconds (burst) and $10,000 swap
  const burstBatch: EnhancedTx[] = Array.from({ length: 10 }, (_, i) =>
    makeSwapTx(`burst_${i}`, 1_700_000_000 + i * 5, USDC_MINT, i === 9 ? 10_000 : 100, MEME_MINT, 1000),
  );

  const sent: string[] = [];
  const sink = { sent, async send(text: string) { sent.push(text); } };

  const report = await watchOnce(store, "key", {
    fetchSeedHistory: async () => burstBatch,
    sink,
    usePrices: true,
    nowSec: 1_700_000_100,
  });

  assert.equal(report.wallets[0].seeded, true);
  assert.equal(report.wallets[0].anomalyCount, 0);
  assert.equal(sent.length, 0);
  assert.equal(store.recentAnomalies(wallet).length, 0);
  assert.equal(store.unalertedCount(wallet), 0);

  store.close();
  cleanup(dir);
});

test("watchOnce: non-seed path unchanged (subsequent poll alerts on live anomaly against seeded baseline)", async () => {
  const { store, dir } = tmpStore();
  const wallet = "W_LIVE";
  store.addWallet(wallet);

  // 1. First poll: seed with modest $100 swap
  const seedBatch = [
    makeSwapTx("seed1", 1_700_000_000, USDC_MINT, 100, MEME_MINT, 1000),
  ];

  const sent: string[] = [];
  const sink = { sent, async send(text: string) { sent.push(text); } };

  await watchOnce(store, "key", {
    fetchSeedHistory: async () => seedBatch,
    sink,
    usePrices: true,
    nowSec: 1_700_000_050,
  });

  const base = store.getBaseline(wallet);
  assert.ok(base !== null);
  assert.equal(base.medianSwapAmountUsd, 100);

  // 2. Second poll: live fetch yields a 5x swap ($500 vs $100 median) -> LARGE_SWAP alert!
  const liveBatch = [
    makeSwapTx("live1", 1_700_000_100, USDC_MINT, 500, MEME_MINT, 5000),
  ];

  let seedCalledOnPoll2 = false;
  const report2 = await watchOnce(store, "key", {
    fetchSeedHistory: async () => {
      seedCalledOnPoll2 = true;
      return [];
    },
    fetchTxs: async () => liveBatch,
    sink,
    usePrices: true,
    nowSec: 1_700_000_200,
  });

  assert.equal(seedCalledOnPoll2, false); // did not use seed history
  assert.equal(report2.wallets[0].seeded, false);
  assert.equal(report2.wallets[0].anomalyCount, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /LARGE_SWAP/);

  store.close();
  cleanup(dir);
});

test("watchOnce: 429 backoff isolation, skip while active, recovery and reset", async () => {
  const { store, dir } = tmpStore();
  const wErr = "W_ERR";
  const wOk = "W_OK";
  store.addWallet(wErr);
  store.addWallet(wOk);

  // Pre-seed baselines so both wallets go down fetchTxs path
  store.saveBaseline({
    walletAddress: wErr,
    updatedAt: 1,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_000,
    txCount: 1,
  });
  store.saveBaseline({
    walletAddress: wOk,
    updatedAt: 1,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_000,
    txCount: 1,
  });

  let shouldFailWErr = true;
  const fetchTxs = async (wallet: string): Promise<EnhancedTx[]> => {
    if (wallet === wErr && shouldFailWErr) {
      throw new HttpError("Helius fetch failed: 429 Too Many Requests", 429);
    }
    return [
      {
        signature: `sig_${wallet}_${Date.now()}`,
        timestamp: 1_700_000_100,
        source: "JUPITER",
        programs: [],
      },
    ];
  };

  // Turn 1: wErr fails with 429, wOk succeeds. Iteration survives.
  const t1Sec = 1_700_000_000;
  const r1 = await watchOnce(store, "key", {
    fetchTxs,
    nowSec: t1Sec,
    usePrices: false,
  });

  assert.equal(r1.wallets.length, 2);
  const r1Err = r1.wallets.find((w) => w.wallet === wErr);
  const r1Ok = r1.wallets.find((w) => w.wallet === wOk);

  assert.ok(r1Err);
  assert.equal(r1Err.error, "Helius fetch failed: 429 Too Many Requests");
  assert.equal(r1Err.backoffUntil, t1Sec + 300); // 5 min backoff
  assert.ok(r1Ok);
  assert.equal(r1Ok.error, undefined);
  assert.equal(r1Ok.freshTxCount, 1);

  // Check store state
  assert.equal(store.isBackingOff(wErr, t1Sec + 100), true);
  assert.equal(store.isBackingOff(wOk, t1Sec + 100), false);

  // Turn 2: before backoff expires (100s later) -> wErr skipped without calling fetchTxs
  const t2Sec = t1Sec + 100;
  const r2 = await watchOnce(store, "key", {
    fetchTxs: async (wallet: string) => {
      if (wallet === wErr) {
        throw new Error("Should not be called during backoff!");
      }
      return [
        {
          signature: `sig_${wallet}_poll2`,
          timestamp: t2Sec,
          source: "JUPITER",
          programs: [],
        },
      ];
    },
    nowSec: t2Sec,
    usePrices: false,
  });

  const r2Err = r2.wallets.find((w) => w.wallet === wErr);
  const r2Ok = r2.wallets.find((w) => w.wallet === wOk);
  assert.ok(r2Err);
  assert.equal(r2Err.skipped, true);
  assert.equal(r2Err.backoffUntil, t1Sec + 300);
  assert.ok(r2Ok);
  assert.equal(r2Ok.freshTxCount, 1);

  // Turn 3: after backoff expires (400s later) -> wErr succeeds, backoff is cleared
  shouldFailWErr = false;
  const t3Sec = t1Sec + 400;
  const r3 = await watchOnce(store, "key", {
    fetchTxs,
    nowSec: t3Sec,
    usePrices: false,
  });

  const r3Err = r3.wallets.find((w) => w.wallet === wErr);
  const r3Ok = r3.wallets.find((w) => w.wallet === wOk);
  assert.ok(r3Err);
  assert.equal(r3Err.error, undefined);
  assert.equal(r3Err.skipped, undefined);
  assert.equal(store.getBackoff(wErr), null);
  assert.equal(store.isBackingOff(wErr, t3Sec), false);

  store.close();
  cleanup(dir);
});

test("watchOnce: 5xx records backoff; non-http error does not record backoff but isolates error", async () => {
  const { store, dir } = tmpStore();
  const w5xx = "W_5XX";
  const wNet = "W_NET";
  store.addWallet(w5xx);
  store.addWallet(wNet);

  store.saveBaseline({
    walletAddress: w5xx,
    updatedAt: 1,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_000,
    txCount: 1,
  });
  store.saveBaseline({
    walletAddress: wNet,
    updatedAt: 1,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_000,
    txCount: 1,
  });

  const fetchTxs = async (wallet: string): Promise<EnhancedTx[]> => {
    if (wallet === w5xx) {
      throw new HttpError("Helius history fetch failed: 503 Service Unavailable", 503);
    }
    if (wallet === wNet) {
      throw new Error("ECONNRESET: Connection lost");
    }
    return [];
  };

  const nowSec = 1_700_000_000;
  const r = await watchOnce(store, "key", { fetchTxs, nowSec, usePrices: false });

  assert.equal(r.wallets.length, 2);
  const r5xx = r.wallets.find((w) => w.wallet === w5xx);
  const rNet = r.wallets.find((w) => w.wallet === wNet);

  assert.ok(r5xx);
  assert.equal(r5xx.error, "Helius history fetch failed: 503 Service Unavailable");
  assert.equal(r5xx.backoffUntil, nowSec + 300);
  assert.ok(store.getBackoff(w5xx) !== null);

  assert.ok(rNet);
  assert.equal(rNet.error, "ECONNRESET: Connection lost");
  assert.equal(rNet.backoffUntil, undefined);
  assert.equal(store.getBackoff(wNet), null); // no backoff for non-429/5xx

  store.close();
  cleanup(dir);
});

test("watchLoop: survives wallet errors across iterations", async () => {
  const { store, dir } = tmpStore();
  const wallet = "W_LOOP";
  store.addWallet(wallet);

  let iterations = 0;
  let failCount = 0;

  const fetchSeedHistory = async () => {
    if (failCount === 0) {
      failCount++;
      throw new HttpError("Rate limited", 429);
    }
    return [
      {
        signature: "sig_loop_1",
        timestamp: 1_700_000_000,
        source: "JUPITER",
        programs: [],
      },
    ];
  };

  await new Promise<void>((resolve, reject) => {
    watchLoop(
      store,
      "key",
      {
        pollMs: 1,
        fetchSeedHistory,
        fetchTxs: async () => [],
        usePrices: false,
      },
      (report) => {
        iterations++;
        if (iterations === 1) {
          // First iteration saw the 429 error and didn't crash
          assert.equal(report.wallets[0].error, "Rate limited");
          // Clear backoff so poll 2 can proceed immediately
          store.clearBackoff(wallet);
        } else if (iterations === 2) {
          // Second iteration succeeded
          assert.equal(report.wallets[0].seeded, true);
          resolve();
        }
      },
    ).catch((err) => {
      reject(err);
    });
  });

  assert.equal(iterations, 2);
  store.close();
  cleanup(dir);
});

test("defaultQuietPolls and defaultMaxPollMs: env parsing and fallbacks", () => {
  const prevQuiet = process.env.RADAR_QUIET_POLLS;
  const prevMax = process.env.RADAR_MAX_POLL_MS;
  try {
    delete process.env.RADAR_QUIET_POLLS;
    delete process.env.RADAR_MAX_POLL_MS;
    assert.equal(defaultQuietPolls(), 3);
    assert.equal(defaultMaxPollMs(), 3_600_000);

    process.env.RADAR_QUIET_POLLS = "5";
    process.env.RADAR_MAX_POLL_MS = "7200000";
    assert.equal(defaultQuietPolls(), 5);
    assert.equal(defaultMaxPollMs(), 7_200_000);

    process.env.RADAR_QUIET_POLLS = "-2";
    process.env.RADAR_MAX_POLL_MS = "invalid";
    assert.equal(defaultQuietPolls(), 3);
    assert.equal(defaultMaxPollMs(), 3_600_000);
  } finally {
    if (prevQuiet !== undefined) process.env.RADAR_QUIET_POLLS = prevQuiet;
    else delete process.env.RADAR_QUIET_POLLS;
    if (prevMax !== undefined) process.env.RADAR_MAX_POLL_MS = prevMax;
    else delete process.env.RADAR_MAX_POLL_MS;
  }
});

test("calculateAdaptiveInterval: progressively doubles interval up to cap", () => {
  const base = 300; // 5 min
  const max = 3600; // 60 min (12x)
  const threshold = 3;

  assert.equal(calculateAdaptiveInterval(base, max, 0, threshold), 300);
  assert.equal(calculateAdaptiveInterval(base, max, 1, threshold), 300);
  assert.equal(calculateAdaptiveInterval(base, max, 2, threshold), 300);

  // Threshold reached: 2x (10 min)
  assert.equal(calculateAdaptiveInterval(base, max, 3, threshold), 600);
  // 4x (20 min)
  assert.equal(calculateAdaptiveInterval(base, max, 4, threshold), 1200);
  // 8x (40 min)
  assert.equal(calculateAdaptiveInterval(base, max, 5, threshold), 2400);
  // Capped at max (60 min = 12x)
  assert.equal(calculateAdaptiveInterval(base, max, 6, threshold), 3600);
  assert.equal(calculateAdaptiveInterval(base, max, 10, threshold), 3600);
});

test("watchOnce: adaptive pacing skips quiet wallets, stretches up to cap, and resets on activity", async () => {
  const { store, dir } = tmpStore();
  const dbPath = join(dir, "radar.db");
  const wQuiet = "W_QUIET";
  const wActive = "W_ACTIVE";
  store.addWallet(wQuiet);
  store.addWallet(wActive);

  store.saveBaseline({
    walletAddress: wQuiet,
    updatedAt: 1,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_000,
    txCount: 1,
  });
  store.saveBaseline({
    walletAddress: wActive,
    updatedAt: 1,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_000,
    txCount: 1,
  });

  let fetchCallsQuiet = 0;
  let fetchCallsActive = 0;
  let quietYieldFresh = false;

  const fetchTxs = async (wallet: string): Promise<EnhancedTx[]> => {
    if (wallet === wQuiet) {
      fetchCallsQuiet++;
      if (quietYieldFresh) {
        return [{ signature: "sig_quiet_fresh", timestamp: 3400, source: "JUPITER", programs: [] }];
      }
      return [];
    }
    if (wallet === wActive) {
      fetchCallsActive++;
      return [{ signature: `sig_act_${fetchCallsActive}`, timestamp: 1000 + fetchCallsActive, source: "JUPITER", programs: [] }];
    }
    return [];
  };

  const watchOpts = {
    fetchTxs,
    pollMs: 300_000, // 300s
    maxPollMs: 3_600_000, // 3600s
    quietPolls: 3,
    usePrices: false,
  };

  // Poll 1 (t=1000): both polled. wQuiet has 0 fresh txs -> streak 1.
  await watchOnce(store, "key", { ...watchOpts, nowSec: 1000 });
  assert.equal(fetchCallsQuiet, 1);
  assert.equal(fetchCallsActive, 1);
  let pQuiet = store.getPacing(wQuiet);
  assert.equal(pQuiet?.quietStreak, 1);
  assert.equal(pQuiet?.nextPollAt, 1000 + 300);

  // Poll 2 (t=1300): both polled. wQuiet has 0 fresh txs -> streak 2.
  await watchOnce(store, "key", { ...watchOpts, nowSec: 1300 });
  assert.equal(fetchCallsQuiet, 2);
  assert.equal(fetchCallsActive, 2);
  pQuiet = store.getPacing(wQuiet);
  assert.equal(pQuiet?.quietStreak, 2);
  assert.equal(pQuiet?.nextPollAt, 1300 + 300);

  // Poll 3 (t=1600): both polled. wQuiet reaches streak 3 (threshold!) -> nextPollAt stretched by 2x (+600s = 2200).
  await watchOnce(store, "key", { ...watchOpts, nowSec: 1600 });
  assert.equal(fetchCallsQuiet, 3);
  assert.equal(fetchCallsActive, 3);
  pQuiet = store.getPacing(wQuiet);
  assert.equal(pQuiet?.quietStreak, 3);
  assert.equal(pQuiet?.nextPollAt, 1600 + 600); // 2200

  // Poll 4 (t=1900, normal 5m cycle): wQuiet is quiet and NOT due (1900 < 2200).
  // wQuiet must be SKIPPED without querying fetchTxs! wActive must still be polled!
  const r4 = await watchOnce(store, "key", { ...watchOpts, nowSec: 1900 });
  assert.equal(fetchCallsQuiet, 3); // NOT incremented!
  assert.equal(fetchCallsActive, 4); // active wallet still polled
  const r4Quiet = r4.wallets.find((w) => w.wallet === wQuiet);
  const r4Active = r4.wallets.find((w) => w.wallet === wActive);
  assert.ok(r4Quiet);
  assert.equal(r4Quiet.skipped, true);
  assert.equal(r4Quiet.quiet, true);
  assert.equal(r4Quiet.nextPollAt, 2200);
  assert.ok(r4Active);
  assert.equal(r4Active.freshTxCount, 1);

  // Pacing survives restarts: close store and reload from disk
  store.close();
  const store2 = new Store(dbPath);
  const pReloaded = store2.getPacing(wQuiet);
  assert.equal(pReloaded?.quietStreak, 3);
  assert.equal(pReloaded?.nextPollAt, 2200);

  // At t=2000 (still < 2200) on store2: still skipped
  const rRestart = await watchOnce(store2, "key", { ...watchOpts, nowSec: 2000 });
  assert.equal(fetchCallsQuiet, 3); // still not called
  assert.equal(rRestart.wallets.find((w) => w.wallet === wQuiet)?.skipped, true);

  // Poll 5 (t=2200): wQuiet is now due! Polled again.
  // 0 fresh txs -> streak 4, interval stretched by 4x (+1200s = 3400).
  const r5 = await watchOnce(store2, "key", { ...watchOpts, nowSec: 2200 });
  assert.equal(fetchCallsQuiet, 4); // fetch was called
  pQuiet = store2.getPacing(wQuiet);
  assert.equal(pQuiet?.quietStreak, 4);
  assert.equal(pQuiet?.nextPollAt, 2200 + 1200); // 3400

  // At t=2500 (< 3400): skipped again
  const r6 = await watchOnce(store2, "key", { ...watchOpts, nowSec: 2500 });
  assert.equal(fetchCallsQuiet, 4);
  assert.equal(r6.wallets.find((w) => w.wallet === wQuiet)?.skipped, true);

  // Poll 6 (t=3400): wQuiet is due and now yields a fresh transaction!
  quietYieldFresh = true;
  const r7 = await watchOnce(store2, "key", { ...watchOpts, nowSec: 3400 });
  assert.equal(fetchCallsQuiet, 5);
  const r7Quiet = r7.wallets.find((w) => w.wallet === wQuiet);
  assert.ok(r7Quiet);
  assert.equal(r7Quiet.freshTxCount, 1);
  assert.equal(r7Quiet.skipped, undefined);

  // Quiet streak has reset to 0, nextPollAt reset to base interval (+300s = 3700)!
  pQuiet = store2.getPacing(wQuiet);
  assert.equal(pQuiet?.quietStreak, 0);
  assert.equal(pQuiet?.nextPollAt, 3400 + 300);

  // Next poll at t=3700 polls normally at base interval
  await watchOnce(store2, "key", { ...watchOpts, nowSec: 3700 });
  assert.equal(fetchCallsQuiet, 6);

  store2.close();
  cleanup(dir);
});

test("watchOnce: backoff survives store restart", async () => {
  const { store, dir } = tmpStore();
  const dbPath = join(dir, "radar.db");
  const wallet = "W_RESTART_429";
  store.addWallet(wallet);

  let fetchCalls = 0;
  const fetchTxs = async (): Promise<EnhancedTx[]> => {
    fetchCalls++;
    throw new HttpError("429 Too Many Requests", 429);
  };

  // Iteration 1: triggers 429 and records backoff until 1000 + 300 = 1300
  const r1 = await watchOnce(store, "k", { fetchTxs, nowSec: 1000, pollMs: 300_000 });
  assert.equal(fetchCalls, 1);
  const w1 = r1.wallets.find((w) => w.wallet === wallet);
  assert.ok(w1);
  assert.equal(w1.backoffUntil, 1300);

  // Close and reload store from disk
  store.close();
  const store2 = new Store(dbPath);

  // Iteration 2 (t=1100 < 1300): must be skipped from persisted SQLite backoff without calling fetchTxs
  const r2 = await watchOnce(store2, "k", { fetchTxs, nowSec: 1100, pollMs: 300_000 });
  assert.equal(fetchCalls, 1); // fetchTxs was NOT called
  const w2 = r2.wallets.find((w) => w.wallet === wallet);
  assert.ok(w2);
  assert.equal(w2.skipped, true);
  assert.equal(w2.backoffUntil, 1300);

  store2.close();
  cleanup(dir);
});

test("watchOnce: seed pricing handles null price response gracefully", async () => {
  const { store, dir } = tmpStore();
  const wallet = "W_SEED_UNPRICED";
  store.addWallet(wallet);

  let priceCalls = 0;
  const fetchSeedHistory = async (): Promise<EnhancedTx[]> => [
    {
      signature: "seed_swap_1",
      timestamp: 1000,
      source: "JUPITER",
      programs: [],
      swap: {
        tokenInputs: [{ mint: "MEME_MINT", rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }],
        tokenOutputs: [{ mint: "SOL_MINT", rawTokenAmount: { tokenAmount: "500000000", decimals: 9 } }],
      },
    },
  ];
  const fetchPrices = async (): Promise<Record<string, number> | null> => {
    priceCalls++;
    return null; // Jupiter unavailable or unpriced token
  };

  // Seed with null price response
  const rSeed = await watchOnce(store, "key", { fetchSeedHistory, fetchPrices, nowSec: 1000 });
  assert.equal(priceCalls, 1);
  const wSeed = rSeed.wallets.find((w) => w.wallet === wallet);
  assert.ok(wSeed);
  assert.equal(wSeed.seeded, true);
  assert.equal(wSeed.anomalyCount, 0);

  // Baseline was saved without USD median
  const baseline = store.getBaseline(wallet);
  assert.ok(baseline !== null);
  assert.equal(baseline.medianSwapAmountUsd, undefined);
  assert.ok(baseline.medianSwapAmount !== undefined);

  // Next live poll where prices ARE available updates medianSwapAmountUsd
  const fetchTxs = async (): Promise<EnhancedTx[]> => [
    {
      signature: "live_swap_2",
      timestamp: 2000,
      source: "JUPITER",
      programs: [],
      swap: {
        tokenInputs: [{ mint: "SOL_MINT", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }],
        tokenOutputs: [{ mint: "USDC_MINT", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }],
      },
    },
  ];
  const fetchPricesLive = async (): Promise<Record<string, number> | null> => ({
    SOL_MINT: 150,
    USDC_MINT: 1,
  });

  const rLive = await watchOnce(store, "key", { fetchTxs, fetchPrices: fetchPricesLive, nowSec: 2000 });
  const wLive = rLive.wallets.find((w) => w.wallet === wallet);
  assert.ok(wLive);
  assert.equal(wLive.seeded, false);

  const updatedBaseline = store.getBaseline(wallet);
  assert.ok(updatedBaseline !== null);
  assert.equal(updatedBaseline.medianSwapAmountUsd, 150);

  store.close();
  cleanup(dir);
});

test("watchOnce: seed with usePrices: false bypasses price fetcher", async () => {
  const { store, dir } = tmpStore();
  const wallet = "W_NO_PRICES";
  store.addWallet(wallet);

  let priceCalls = 0;
  const fetchSeedHistory = async (): Promise<EnhancedTx[]> => [
    {
      signature: "seed_1",
      timestamp: 1000,
      source: "JUPITER",
      programs: [],
      swap: {
        tokenInputs: [{ mint: "SOL", rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }],
        tokenOutputs: [{ mint: "USDC", rawTokenAmount: { tokenAmount: "100000000", decimals: 6 } }],
      },
    },
  ];
  const fetchPrices = async () => {
    priceCalls++;
    return { SOL: 100 };
  };

  await watchOnce(store, "key", {
    fetchSeedHistory,
    fetchPrices,
    usePrices: false,
    nowSec: 1000,
  });

  assert.equal(priceCalls, 0); // never called
  const baseline = store.getBaseline(wallet);
  assert.ok(baseline !== null);
  assert.equal(baseline.medianSwapAmountUsd, undefined);

  store.close();
  cleanup(dir);
});

test("watchOnce: adaptive pacing with quietPolls=1 stretches on first quiet poll", async () => {
  const { store, dir } = tmpStore();
  const wallet = "W_PACING_ONE";
  store.addWallet(wallet);
  store.saveBaseline({
    walletAddress: wallet,
    updatedAt: 1,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_000,
    txCount: 1,
  });

  let fetchCalls = 0;
  const fetchTxs = async () => {
    fetchCalls++;
    return [];
  };

  const opts = {
    fetchTxs,
    pollMs: 300_000, // 300s base
    quietPolls: 1, // threshold = 1
    nowSec: 1000,
  };

  // Poll 1: yields 0 txs -> streak 1 (>= threshold 1!) -> nextPollAt stretched by 2x (+600s = 1600)
  await watchOnce(store, "key", opts);
  assert.equal(fetchCalls, 1);
  const pacing = store.getPacing(wallet);
  assert.equal(pacing?.quietStreak, 1);
  assert.equal(pacing?.nextPollAt, 1000 + 600); // stretched immediately

  // Poll at t=1300 (< 1600): skipped!
  const r2 = await watchOnce(store, "key", { ...opts, nowSec: 1300 });
  assert.equal(fetchCalls, 1);
  assert.equal(r2.wallets.find((w) => w.wallet === wallet)?.skipped, true);

  store.close();
  cleanup(dir);
});



