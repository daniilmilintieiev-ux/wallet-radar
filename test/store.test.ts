import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, calculateBackoffDelay } from "../src/store.js";
import { watchOnce } from "../src/watch.js";
import { formatAlert } from "../src/alerts.js";
import { Baseline, EnhancedTx, SOL_MINT, USDC_MINT } from "../src/types.js";
import { applyDefense } from "../src/http-server.js";

function tmpStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "radar-test-"));
  return { store: new Store(join(dir, "test.db")), dir };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const BASELINE: Baseline = {
  walletAddress: "W1",
  updatedAt: 1,
  knownVenues: ["JUPITER"],
  knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
  medianSwapAmount: 1.5,
  medianSwapAmountUsd: 150,
  medianTps: 1,
  activeHours: [],
  lastSeenAt: 1_699_305_600,
  txCount: 10,
};

test("store: watchlist add/list/remove", () => {
  const { store, dir } = tmpStore();
  store.addWallet("A");
  store.addWallet("B");
  store.addWallet("A");
  assert.deepEqual(store.listWallets(), ["A", "B"]);
  assert.equal(store.hasWallet("A"), true);
  store.removeWallet("A");
  assert.deepEqual(store.listWallets(), ["B"]);
  assert.equal(store.hasWallet("A"), false);
  store.close();
  cleanup(dir);
});

test("store: baseline round-trip", () => {
  const { store, dir } = tmpStore();
  store.addWallet("W1");
  assert.equal(store.getBaseline("W1"), null);
  store.saveBaseline(BASELINE);
  const loaded = store.getBaseline("W1");
  assert.deepEqual(loaded, BASELINE);
  store.close();
  cleanup(dir);
});

test("store: seen-tx dedupe and trim", () => {
  const { store, dir } = tmpStore();
  store.addWallet("W1");
  const sigs = Array.from({ length: 1200 }, (_, i) => ({ sig: `sig${i}`, ts: i }));
  store.markSeen("W1", sigs, 1000);
  assert.equal(store.allSeen("W1", ["sig1199", "sig200"]), true);
  assert.equal(store.allSeen("W1", ["sig50"]), false); // trimmed
  assert.equal(store.allSeen("W1", ["sig1199", "sig99999"]), false);
  store.close();
  cleanup(dir);
});

test("store: anomaly history, filter, alerted flag", () => {
  const { store, dir } = tmpStore();
  const a = (type: string, wallet: string, ts: number) => ({
    type: type as "NEW_VENUE",
    wallet,
    severity: "medium" as const,
    timestamp: ts,
    evidence: { x: 1 },
    text: `text ${type}`,
  });
  store.recordAnomalies([a("NEW_VENUE", "W1", 10), a("NEW_VENUE", "W1", 20)]);
  store.recordAnomalies([a("NEW_VENUE", "W2", 30)], 30);
  assert.equal(store.unalertedCount("W1"), 2);
  assert.equal(store.unalertedCount("W2"), 1);
  assert.equal(store.unalertedCount(null), 3);
  const w1 = store.recentAnomalies("W1", 20);
  assert.equal(w1.length, 2);
  assert.equal(w1[0].timestamp, 20); // newest first
  store.markAllAlerted("W1");
  assert.equal(store.unalertedCount("W1"), 0);
  assert.equal(store.unalertedCount(null), 1);
  store.close();
  cleanup(dir);
});

const BASE = 1_700_000_000;
function burstTxs(): EnhancedTx[] {
  return [
    { signature: "t1", timestamp: BASE, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    { signature: "t2", timestamp: BASE + 60, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    {
      signature: "t3",
      timestamp: BASE + 120,
      source: "ORCA",
      programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      swap: {
        tokenInputs: [{ mint: USDC_MINT, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }],
        tokenOutputs: [{ mint: SOL_MINT, rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }],
      },
    },
    { signature: "t4", timestamp: BASE + 180, source: "JUPITER", programs: ["NewProgram11111111111111111111111111111111"] },
    { signature: "t5", timestamp: BASE + 240, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    { signature: "old", timestamp: BASE - 3600, source: "JUPITER", programs: [] },
  ];
}

test("watchOnce: seed baseline silently, then alert on fresh activity", async () => {
  const { store, dir } = tmpStore();
  const sent: string[] = [];
  const sink = { sent, async send(text: string) { sent.push(text); } };
  const fetchTxs = async (wallet: string): Promise<EnhancedTx[]> => {
    if (wallet === "W1") return burstTxs();
    if (wallet === "W2")
      return [
        { signature: "w2a", timestamp: BASE, source: "JUPITER", programs: [] },
        { signature: "w2b", timestamp: BASE + 10, source: "JUPITER", programs: [] },
      ];
    return [];
  };
  const opts = { fetchTxs, sink, usePrices: false, nowSec: BASE + 300 };

  // W2 has no baseline yet: first-seed is silent.
  store.addWallet("W2");
  const r1 = await watchOnce(store, "", opts);
  const w2 = r1.wallets.find((w) => w.wallet === "W2");
  assert.ok(w2);
  assert.equal(w2.seeded, true);
  assert.equal(w2.anomalyCount, 0);
  assert.equal(sent.length, 0);
  assert.ok(store.getBaseline("W2") !== null);

  // W1 has a baseline: fresh batch is evaluated against it.
  store.addWallet("W1");
  store.saveBaseline(BASELINE);
  const r2 = await watchOnce(store, "", opts);
  const w1 = r2.wallets.find((w) => w.wallet === "W1");
  assert.ok(w1);
  assert.equal(w1.seeded, false);
  assert.equal(w1.freshTxCount, 6);
  // DORMANT_ACTIVE(30) + ACTIVITY_BURST(15) + NEW_VENUE(15) + NEW_PROTOCOL(5) + REGIME_SHIFT(30)
  assert.equal(w1.anomalyCount, 5);
  assert.equal(w1.riskScore, 95);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /risk 95\/100/);
  assert.match(sent[0], /DORMANT_ACTIVE/);
  assert.equal(store.recentAnomalies("W1").length, 5);
  assert.equal(store.unalertedCount("W1"), 0); // marked alerted after send

  // Same txs again: signature dedupe -> nothing new, no new alerts.
  const r3 = await watchOnce(store, "", opts);
  assert.deepEqual(r3.wallets, []);
  assert.equal(sent.length, 1);

  store.close();
  cleanup(dir);
});

test("formatAlert: compact one-message digest", () => {
  const anomalies = [
    {
      type: "ACTIVITY_BURST" as const,
      wallet: "W1",
      severity: "medium" as const,
      timestamp: 1,
      evidence: {},
      text: "5 transactions in 10 min.",
    },
    {
      type: "LARGE_SWAP" as const,
      wallet: "W1",
      severity: "high" as const,
      timestamp: 2,
      evidence: {},
      text: "Swap of ~$3000 is 3x the median.",
    },
  ];
  const msg = formatAlert("W1", 45, anomalies);
  assert.match(msg, /W1 — risk 45\/100, 2 anomalies/);
  assert.match(msg, /\[MEDIUM\] ACTIVITY_BURST/);
  assert.match(msg, /\[HIGH\] LARGE_SWAP/);
});

test("store: calculateBackoffDelay exponential schedule", () => {
  assert.equal(calculateBackoffDelay(0), 300); // 5m
  assert.equal(calculateBackoffDelay(1), 300); // 5m
  assert.equal(calculateBackoffDelay(2), 900); // 15m
  assert.equal(calculateBackoffDelay(3), 2700); // 45m
  assert.equal(calculateBackoffDelay(4), 8100); // 135m
  assert.equal(calculateBackoffDelay(5), 14400); // capped at 4h
  assert.equal(calculateBackoffDelay(10), 14400); // capped at 4h
});

test("store: wallet backoff tracking and cleanup", () => {
  const { store, dir } = tmpStore();
  const wallet = "W_BACKOFF";
  store.addWallet(wallet);

  assert.equal(store.getBackoff(wallet), null);
  assert.equal(store.isBackingOff(wallet, 1000), false);

  // Attempt 1: backoff recorded
  const b1 = store.recordBackoff(wallet, 1000);
  assert.equal(b1.attempt, 1);
  assert.equal(b1.backoffUntil, 1000 + 300); // +5m
  assert.equal(store.isBackingOff(wallet, 1200), true);
  assert.equal(store.isBackingOff(wallet, 1300), false);

  // Attempt 2: backoff increased
  const b2 = store.recordBackoff(wallet, 1300);
  assert.equal(b2.attempt, 2);
  assert.equal(b2.backoffUntil, 1300 + 900); // +15m
  assert.equal(store.isBackingOff(wallet, 2000), true);

  // Clear backoff
  store.clearBackoff(wallet);
  assert.equal(store.getBackoff(wallet), null);
  assert.equal(store.isBackingOff(wallet, 2000), false);

  // Re-record and removeWallet cleanup
  store.recordBackoff(wallet, 3000);
  assert.ok(store.getBackoff(wallet) !== null);
  store.removeWallet(wallet);
  assert.equal(store.getBackoff(wallet), null);

  store.close();
  cleanup(dir);
});

test("store: wallet pacing tracking and cleanup", () => {
  const { store, dir } = tmpStore();
  const wallet = "W_PACING";
  store.addWallet(wallet);

  assert.equal(store.getPacing(wallet), null);

  // Record streak 3 and nextPollAt 1200
  store.recordPacing(wallet, 3, 1200);
  const p1 = store.getPacing(wallet);
  assert.ok(p1 !== null);
  assert.equal(p1.quietStreak, 3);
  assert.equal(p1.nextPollAt, 1200);

  // Update streak 0 and nextPollAt 1500 (reset)
  store.recordPacing(wallet, 0, 1500);
  const p2 = store.getPacing(wallet);
  assert.ok(p2 !== null);
  assert.equal(p2.quietStreak, 0);
  assert.equal(p2.nextPollAt, 1500);

  // Clear pacing
  store.clearPacing(wallet);
  assert.equal(store.getPacing(wallet), null);

  // Remove wallet cleans up pacing
  store.recordPacing(wallet, 5, 2000);
  assert.ok(store.getPacing(wallet) !== null);
  store.removeWallet(wallet);
  assert.equal(store.getPacing(wallet), null);

  store.close();
  cleanup(dir);
});

test("store: backoff persistence across restart", () => {
  const { store, dir } = tmpStore();
  const dbPath = join(dir, "test.db");
  const wallet = "W_RESTART_BACKOFF";
  store.addWallet(wallet);

  // Record attempt 1 at t=1000
  const b1 = store.recordBackoff(wallet, 1000);
  assert.equal(b1.attempt, 1);
  assert.equal(b1.backoffUntil, 1000 + 300);

  // Close and reopen database
  store.close();
  const store2 = new Store(dbPath);

  // State survived restart
  const bPersisted = store2.getBackoff(wallet);
  assert.ok(bPersisted !== null);
  assert.equal(bPersisted.attempt, 1);
  assert.equal(bPersisted.backoffUntil, 1300);
  assert.equal(store2.isBackingOff(wallet, 1200), true);
  assert.equal(store2.isBackingOff(wallet, 1350), false);

  // Attempt 2 increments from persisted attempt count
  const b2 = store2.recordBackoff(wallet, 1350);
  assert.equal(b2.attempt, 2);
  assert.equal(b2.backoffUntil, 1350 + 900); // +15m

  store2.close();
  cleanup(dir);
});

test("store: settled payments tracking and replay prevention across restart", () => {
  const { store, dir } = tmpStore();
  const dbPath = join(dir, "test.db");
  const sig = "5fakeSignatureForPayment11111111111111111111111111111111";
  const payer = "PayerWallet1111111111111111111111111111111";
  const recipient = "RecipientWallet111111111111111111111111111";

  assert.equal(store.hasSettledPayment(sig), false);
  assert.equal(store.getSettledPayment(sig), null);

  store.recordSettledPayment({
    signature: sig,
    payer,
    recipient,
    amount: 0.005,
    endpoint: "/scan",
  }, 1700000000);

  assert.equal(store.hasSettledPayment(sig), true);
  const settled = store.getSettledPayment(sig);
  assert.ok(settled !== null);
  assert.equal(settled.signature, sig);
  assert.equal(settled.payer, payer);
  assert.equal(settled.recipient, recipient);
  assert.equal(settled.amount, 0.005);
  assert.equal(settled.endpoint, "/scan");
  assert.equal(settled.settledAt, 1700000000);

  // Close and reopen to verify persistence
  store.close();
  const store2 = new Store(dbPath);
  assert.equal(store2.hasSettledPayment(sig), true);
  const settled2 = store2.getSettledPayment(sig);
  assert.ok(settled2 !== null);
  assert.equal(settled2.signature, sig);
  assert.equal(settled2.amount, 0.005);

  store2.close();
  cleanup(dir);
});

test("store: recordCostEvent and getCostSummary aggregation", () => {
  const { store, dir } = tmpStore();
  const ts = 1700000000;
  store.recordCostEvent({ ts, category: "helius", quantity: 10, unitPriceUsd: 0.0001, totalUsd: 0.001, detail: "10 RPC calls" });
  store.recordCostEvent({ ts: ts + 10, category: "helius", quantity: 5, unitPriceUsd: 0.0001, totalUsd: 0.0005 });
  store.recordCostEvent({ ts: ts + 20, category: "compute", quantity: 1, unitPriceUsd: 0.05, totalUsd: 0.05 });

  const summary = store.getCostSummary();
  assert.equal(summary.events, 3);
  assert.equal(summary.totalUsd, 0.0515);
  assert.equal(summary.byCategory["helius"], 0.0015);
  assert.equal(summary.byCategory["compute"], 0.05);

  store.close();
  cleanup(dir);
});

test("store: getRevenueSummary and getRevenuePerDay metrics", () => {
  const { store, dir } = tmpStore();
  const ts = 1700000000;
  store.recordSettledPayment({ signature: "sig1", payer: "p1", recipient: "r1", amount: 0.005, endpoint: "/scan" }, ts);
  store.recordSettledPayment({ signature: "sig2", payer: "p2", recipient: "r1", amount: 0.005, endpoint: "/scan" }, ts + 100);
  store.recordSettledPayment({ signature: "sig3", payer: "p3", recipient: "r1", amount: 0.001, endpoint: "/analyze" }, ts + 200);

  const rev = store.getRevenueSummary();
  assert.equal(rev.payments, 3);
  assert.equal(rev.totalUsdc, 0.011);
  assert.equal(rev.byEndpoint["/scan"].count, 2);
  assert.equal(rev.byEndpoint["/scan"].amountUsdc, 0.01);
  assert.equal(rev.byEndpoint["/analyze"].count, 1);
  assert.equal(rev.byEndpoint["/analyze"].amountUsdc, 0.001);

  store.close();
  cleanup(dir);
});

test("store: cleanExpiredMintCache cleans stale mints only", () => {
  const { store, dir } = tmpStore();
  const now = 1700000000;
  store.saveMintMetadata(
    {
      mint: "StaleMint11111111111111111111111111111111111",
      mintAuthority: null,
      freezeAuthority: null,
      top10Pct: null,
    },
    now - 20000,
    14400, // expired (20000 > 14400)
  );
  store.saveMintMetadata(
    {
      mint: "FreshMint11111111111111111111111111111111111",
      mintAuthority: null,
      freezeAuthority: null,
      top10Pct: null,
    },
    now - 1000,
    14400, // fresh
  );

  assert.ok(store.getMintMetadata("StaleMint11111111111111111111111111111111111", now) === null);
  assert.ok(store.getMintMetadata("FreshMint11111111111111111111111111111111111", now) !== null);

  const cleaned = store.cleanExpiredMintCache(now);
  assert.equal(cleaned, 1);

  store.close();
  cleanup(dir);
});

test("store: getCostPerDay and getRevenuePerDay aggregate across days", () => {
  const { store, dir } = tmpStore();
  const now = Math.floor(Date.now() / 1000);
  const day1 = now - 2 * 86400;
  const day2 = now - 86400;

  // Cost events on day1 and day2
  store.recordCostEvent({ ts: day1, category: "helius", quantity: 1, unitPriceUsd: 0.01, totalUsd: 0.01 });
  store.recordCostEvent({ ts: day1 + 10, category: "helius", quantity: 1, unitPriceUsd: 0.02, totalUsd: 0.02 });
  store.recordCostEvent({ ts: day2, category: "helius", quantity: 1, unitPriceUsd: 0.05, totalUsd: 0.05 });

  const costPerDay = store.getCostPerDay(365);
  assert.ok(costPerDay.length >= 2);
  assert.equal(costPerDay[costPerDay.length - 2].costUsd, 0.03);
  assert.equal(costPerDay[costPerDay.length - 1].costUsd, 0.05);

  // Revenue payments on day1 and day2
  store.recordSettledPayment({ signature: "s1", payer: "p1", recipient: "r1", amount: 0.005, endpoint: "/scan" }, day1);
  store.recordSettledPayment({ signature: "s2", payer: "p2", recipient: "r1", amount: 0.010, endpoint: "/scan" }, day1 + 50);
  store.recordSettledPayment({ signature: "s3", payer: "p3", recipient: "r1", amount: 0.020, endpoint: "/scan" }, day2);

  const revPerDay = store.getRevenuePerDay(365);
  assert.ok(revPerDay.length >= 2);
  assert.equal(revPerDay[revPerDay.length - 2].revenueUsdc, 0.015);
  assert.equal(revPerDay[revPerDay.length - 1].revenueUsdc, 0.020);

  store.close();
  cleanup(dir);
});

test("store: removeWallet cleans up all associated tables completely", () => {
  const { store, dir } = tmpStore();
  const wallet = "W_FULL_CASCADE";
  const now = 1700000000;

  store.addWallet(wallet, now);
  store.saveBaseline({ ...BASELINE, walletAddress: wallet });
  store.markSeen(wallet, [{ sig: "sig1", ts: now }]);
  store.recordBackoff(wallet, now);
  store.recordPacing(wallet, 2, now + 100);
  store.setDefenseState(wallet, { state: "gated", riskAt: 60, setAt: now, quietStreak: 0, actions: 1 });
  store.recordDefenseEvent({ wallet, ts: now, fromState: "armed", toState: "gated", action: "escalate", risk: 60, reason: "risk" });

  assert.equal(store.hasWallet(wallet), true);
  assert.ok(store.getBaseline(wallet) !== null);
  assert.equal(store.allSeen(wallet, ["sig1"]), true);
  assert.ok(store.getBackoff(wallet) !== null);
  assert.ok(store.getPacing(wallet) !== null);
  assert.ok(store.getDefenseState(wallet) !== null);
  assert.equal(store.recentDefenseEvents(wallet).length, 1);

  // Remove wallet
  store.removeWallet(wallet);

  assert.equal(store.hasWallet(wallet), false);
  assert.equal(store.getBaseline(wallet), null);
  assert.equal(store.allSeen(wallet, ["sig1"]), false);
  assert.equal(store.getBackoff(wallet), null);
  assert.equal(store.getPacing(wallet), null);
  assert.equal(store.getDefenseState(wallet), null);
  assert.equal(store.recentDefenseEvents(wallet).length, 0);

  store.close();
  cleanup(dir);
});

test("audit 2.4: getLatestSettledPaymentForWallet matches only target wallet, not unrelated payer", () => {
  const { store, dir } = tmpStore();
  const alice = "AliceWallet1111111111111111111111111111";
  const bob = "BobWallet1111111111111111111111111111111";
  const carl = "CarlWallet11111111111111111111111111111";

  // Bob pays for Carl's scan
  store.recordSettledPayment({
    signature: "sig_bob_pays_carl",
    payer: bob,
    recipient: "Recipient111",
    amount: 0.005,
    endpoint: "/scan",
    wallet: carl,
  });

  // Querying Carl finds the payment
  const carlPayment = store.getLatestSettledPaymentForWallet(carl);
  assert.ok(carlPayment !== null);
  assert.equal(carlPayment.signature, "sig_bob_pays_carl");
  assert.equal(carlPayment.wallet, carl);

  // Querying Bob must return null: Bob's payment for Carl was NOT a scan of Bob!
  const bobPayment = store.getLatestSettledPaymentForWallet(bob);
  assert.equal(bobPayment, null, "Bob should not receive Carl's scan receipt as his own");

  store.close();
  cleanup(dir);
});

test("audit 2.3: applyDefense directly hardens /scan response verdict and riskScore", () => {
  const { store, dir } = tmpStore();
  const wallet = "W_DEFENSE_SCAN";
  const now = 1700000000;

  // 1. Stance: blocked -> /scan verdict must become HIGH RISK and riskScore >= 85
  store.setDefenseState(wallet, { state: "blocked", riskAt: 90, setAt: now, quietStreak: 0, actions: 1 });
  const scanBlocked: Record<string, unknown> = {
    wallet,
    riskScore: 10,
    verdict: "SAFE",
  };
  applyDefense(store, { wallet }, scanBlocked);
  assert.equal(scanBlocked.verdict, "HIGH RISK");
  assert.equal(scanBlocked.riskScore, 85);
  assert.equal(scanBlocked.enforcedByDefense, true);

  // 2. Stance: gated -> /scan verdict SAFE must become SUSPICIOUS and riskScore >= 60
  store.setDefenseState(wallet, { state: "gated", riskAt: 65, setAt: now, quietStreak: 0, actions: 2 });
  const scanGated: Record<string, unknown> = {
    wallet,
    riskScore: 20,
    verdict: "SAFE",
  };
  applyDefense(store, { wallet }, scanGated);
  assert.equal(scanGated.verdict, "SUSPICIOUS");
  assert.equal(scanGated.riskScore, 60);
  assert.equal(scanGated.enforcedByDefense, true);

  store.close();
  cleanup(dir);
});

test("audit revision 9: seen_txs has idx_seen_txs_wallet_ts index", () => {
  const { store, dir } = tmpStore();
  const indexes = (store as any).db.prepare("PRAGMA index_list(seen_txs)").all() as Array<{ name: string }>;
  assert.ok(indexes.some((idx) => idx.name === "idx_seen_txs_wallet_ts"), "idx_seen_txs_wallet_ts must exist");
  store.close();
  cleanup(dir);
});

