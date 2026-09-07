import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, extractSwap, computeRiskScore, SOL_MINT, USDC_MINT, MAJOR_MINTS } from "../src/analyzer.js";
import { updateBaseline } from "../src/baseline.js";
import { EnhancedTx, Baseline, Anomaly, DEFAULT_CONFIG } from "../src/types.js";

const WALLET = "DemoWallet11111111111111111111111111111111";

function swapTx(sig: string, ts: number, source: string, amount: number): EnhancedTx {
  return {
    signature: sig,
    timestamp: ts,
    source,
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: SOL_MINT, rawTokenAmount: { tokenAmount: String(Math.round(amount * 1e9)), decimals: 9 } }],
      tokenOutputs: [{ mint: USDC_MINT, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }],
    },
  };
}

test("extractSwap decodes token + native legs", () => {
  const tx: EnhancedTx = {
    signature: "sigX",
    timestamp: 1,
    source: "RAY",
    swap: {
      nativeInput: { amount: 5_000_000_000 },
      tokenOutputs: [{ mint: "USDC", rawTokenAmount: { tokenAmount: "5000000", decimals: 6 } }],
    },
  };
  const s = extractSwap(tx);
  assert.ok(s);
  assert.equal(s.tokenIn.amount, 5);
  assert.equal(s.dex, "RAY");
});

test("no anomalies on first sight (no baseline)", () => {
  const txs = [swapTx("a", 1_700_000_000, "JUPITER", 1000)];
  assert.equal(detectAnomalies(WALLET, txs, null).length, 0);
});

test("NEW_VENUE fires for a venue not in baseline", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
  const txs = [swapTx("b", 1_700_000_600, "RAY", 10)];
  const anomalies = detectAnomalies(WALLET, txs, baseline);
  assert.ok(anomalies.some((a) => a.type === "NEW_VENUE"));
});

test("LARGE_SWAP fires above the median multiplier", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
  const txs = [swapTx("c", 1_700_000_600, "JUPITER", 100)]; // 100 >= 3*10
  const anomalies = detectAnomalies(WALLET, txs, baseline);
  assert.ok(anomalies.some((a) => a.type === "LARGE_SWAP"));
});

test("DORMANT_ACTIVE fires after a long quiet gap", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 5,
  };
  // New activity ~10 days later.
  const txs = [swapTx("d", 1_700_864_000, "JUPITER", 10)];
  const anomalies = detectAnomalies(WALLET, txs, baseline);
  assert.ok(anomalies.some((a) => a.type === "DORMANT_ACTIVE"));
});

test("updateBaseline accumulates venues and programs", () => {
  const txs = [
    { signature: "e", timestamp: 1_700_000_000, source: "JUPITER", programs: ["PROG_A"] },
    { signature: "f", timestamp: 1_700_000_300, source: "RAY", programs: ["PROG_B"] },
  ];
  const b = updateBaseline(WALLET, null, txs);
  assert.ok(b.knownVenues.includes("JUPITER") && b.knownVenues.includes("RAY"));
  assert.ok(b.knownPrograms.includes("PROG_A") && b.knownPrograms.includes("PROG_B"));
  assert.equal(b.txCount, 2);
});

test("LARGE_SWAP ignores non-major tokenIn mints", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
  const meme = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
  const txs: EnhancedTx[] = [{
    signature: "g",
    timestamp: 1_700_000_600,
    source: "JUPITER",
    swap: {
      tokenInputs: [{ mint: meme, rawTokenAmount: { tokenAmount: String(50_000_000 * 1e8), decimals: 8 } }],
      tokenOutputs: [{ mint: USDC_MINT, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }],
    },
  }];
  const anomalies = detectAnomalies(WALLET, txs, baseline);
  assert.equal(anomalies.some((a) => a.type === "LARGE_SWAP"), false);
});

test("ACTIVITY_BURST fires for >= threshold tx within window (seconds)", () => {
  const base = 1_700_000_000;
  const txs: EnhancedTx[] = [0, 60, 120, 180, 240].map((off, i) => ({
    signature: "burst" + i,
    timestamp: base + off,
    source: "JUPITER",
  }));
  const anomalies = detectAnomalies(WALLET, txs, null);
  assert.ok(anomalies.some((a) => a.type === "ACTIVITY_BURST"));
});

test("ACTIVITY_BURST does not fire when txs are spread out", () => {
  const base = 1_700_000_000;
  // 5 txs spread over 3 days — well outside the 10 min window.
  const txs: EnhancedTx[] = [0, 86_400, 2 * 86_400, 3 * 86_400, 4 * 86_400].map((off, i) => ({
    signature: "spread" + i,
    timestamp: base + off,
    source: "JUPITER",
  }));
  const anomalies = detectAnomalies(WALLET, txs, null);
  assert.equal(anomalies.some((a) => a.type === "ACTIVITY_BURST"), false);
});

test("DORMANT_ACTIVE fires even if batch contains an already-seen old tx", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 5,
  };
  // One old tx (pagination overlap) + one tx ~10 days later.
  const txs: EnhancedTx[] = [
    { signature: "old", timestamp: 1_700_000_000, source: "JUPITER" },
    { signature: "new", timestamp: 1_700_864_000, source: "JUPITER" },
  ];
  const anomalies = detectAnomalies(WALLET, txs, baseline);
  assert.ok(anomalies.some((a) => a.type === "DORMANT_ACTIVE"));
});

// --- Newer Helius response shape: no top-level `swap` field; legs come from
// tokenTransfers / nativeTransfers relative to the fee payer. ---

function newFormatTx(
  sig: string,
  ts: number,
  source: string,
  transfers: EnhancedTx["tokenTransfers"],
  native: EnhancedTx["nativeTransfers"] = [],
  programIds: string[] = ["PumpFun111Program"],
): EnhancedTx {
  return {
    signature: sig,
    timestamp: ts,
    source,
    type: "SWAP",
    feePayer: WALLET,
    tokenTransfers: transfers,
    nativeTransfers: native,
    instructions: programIds.map((programId) => ({ programId })),
  };
}

test("extractSwap reconstructs legs from new-format transfers", () => {
  const tx = newFormatTx("nf1", 1_700_000_000, "PUMP_FUN", [
    { fromUserAccount: WALLET, toUserAccount: "PoolAddr1111111111111111111111", tokenAmount: 1000, mint: "MemeMint11111111111111111111111111111" },
    { fromUserAccount: "PoolAddr1111111111111111111111", toUserAccount: WALLET, tokenAmount: 200000, mint: USDC_MINT },
  ], [
    { fromUserAccount: WALLET, toUserAccount: "FeeAddr1111111111111111111111111111111", amount: 100000 },
  ]);
  const s = extractSwap(tx);
  assert.ok(s);
  assert.equal(s.dex, "PUMP_FUN");
  assert.equal(s.tokenIn.mint, "MemeMint11111111111111111111111111111");
  assert.equal(s.tokenIn.amount, 1000);
  assert.equal(s.tokenOut.mint, USDC_MINT);
  assert.equal(s.tokenOut.amount, 200000);
});

test("extractSwap handles SOL-out sells in new format", () => {
  const tx = newFormatTx("nf2", 1_700_000_000, "PUMP_FUN", [
    { fromUserAccount: WALLET, toUserAccount: "PoolAddr1111111111111111111111", tokenAmount: 500, mint: "MemeMint11111111111111111111111111111" },
  ], [
    { fromUserAccount: "PoolAddr1111111111111111111111", toUserAccount: WALLET, amount: 7_500_000_000 },
  ]);
  const s = extractSwap(tx);
  assert.ok(s);
  assert.equal(s.tokenIn.mint, "MemeMint11111111111111111111111111111");
  assert.equal(s.tokenOut.mint, SOL_MINT);
  assert.equal(s.tokenOut.amount, 7.5);
});

test("extractSwap returns null for new-format non-SWAP tx", () => {
  const tx = newFormatTx("nf3", 1_700_000_000, "PUMP_FUN", []);
  tx.type = "TRANSFER";
  assert.equal(extractSwap(tx), null);
});

test("NEW_VENUE and NEW_PROTOCOL fire from new-format fields", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["OldProgram1111111111111111111111111111111"],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
  const txs = [
    newFormatTx("nf4", 1_700_000_600, "PUMP_FUN", [
      { fromUserAccount: WALLET, toUserAccount: "PoolAddr1111111111111111111111", tokenAmount: 1, mint: "MemeMint11111111111111111111111111111" },
    ], [], ["NewProgram2222222222222222222222222222222"]),
  ];
  const anomalies = detectAnomalies(WALLET, txs, baseline);
  assert.ok(anomalies.some((a) => a.type === "NEW_VENUE"));
  assert.ok(anomalies.some((a) => a.type === "NEW_PROTOCOL" && a.evidence.program === "NewProgram2222222222222222222222222222222"));
});

test("LARGE_SWAP fires on new-format swap via USD prices", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["PumpFun111Program"],
    medianSwapAmount: 10,
    medianSwapAmountUsd: 100,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
  const txs = [
    newFormatTx("nf5", 1_700_000_600, "PUMP_FUN", [
      { fromUserAccount: "PoolAddr1111111111111111111111", toUserAccount: WALLET, tokenAmount: 2000, mint: "MemeMint11111111111111111111111111111" },
    ], [
      { fromUserAccount: WALLET, toUserAccount: "PoolAddr1111111111111111111111", amount: 10_000_000_000 },
    ]),
  ];
  const prices = { [SOL_MINT]: 200 }; // 10 SOL in = $2000 >= 3 * $100
  const anomalies = detectAnomalies(WALLET, txs, baseline, DEFAULT_CONFIG, prices);
  assert.ok(anomalies.some((a) => a.type === "LARGE_SWAP"));
});

test("updateBaseline learns USD median from new-format swaps", () => {
  const mk = (sig: string, sol: number): EnhancedTx =>
    newFormatTx(sig, 1_700_000_000, "PUMP_FUN", [
      { fromUserAccount: "PoolAddr1111111111111111111111", toUserAccount: WALLET, tokenAmount: 10, mint: "MemeMint11111111111111111111111111111" },
    ], [
      { fromUserAccount: WALLET, toUserAccount: "PoolAddr1111111111111111111111", amount: sol * 1e9 },
    ]);
  const b = updateBaseline(WALLET, null, [mk("nf6a", 10), mk("nf6b", 20)], 1_700_000_000, { [SOL_MINT]: 100 });
  assert.equal(b.medianSwapAmountUsd, 1500); // median of [1000, 2000]
  assert.equal(b.medianSwapAmount, 15); // median of [10, 20] SOL
  assert.ok(b.knownPrograms.includes("PumpFun111Program"));
});

test("computeRiskScore aggregates severity and caps at 100", () => {
  const mk = (severity: Anomaly["severity"]): Anomaly => ({
    type: "NEW_VENUE",
    wallet: WALLET,
    severity,
    timestamp: 1,
    evidence: {},
    text: "t",
  });
  assert.equal(computeRiskScore([]), 0);
  assert.equal(computeRiskScore([mk("low"), mk("medium"), mk("high")]), 50);
  assert.equal(
    computeRiskScore([mk("high"), mk("high"), mk("high"), mk("high"), mk("high")]),
    100,
  );
});
