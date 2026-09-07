import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { watchOnce } from "../src/watch.js";
import { formatAlert } from "../src/alerts.js";
import { Baseline, EnhancedTx, SOL_MINT, USDC_MINT } from "../src/types.js";

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
  // DORMANT_ACTIVE(30) + ACTIVITY_BURST(15) + NEW_VENUE(15) + NEW_PROTOCOL(5)
  assert.equal(w1.anomalyCount, 4);
  assert.equal(w1.riskScore, 65);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /risk 65\/100/);
  assert.match(sent[0], /DORMANT_ACTIVE/);
  assert.equal(store.recentAnomalies("W1").length, 4);
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
