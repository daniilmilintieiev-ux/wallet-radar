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

// --- Edge-case unit tests: thresholds, boundaries, concentration, and median blending ---

function makeSwapTx(
  sig: string,
  ts: number,
  inMint: string,
  inAmount: number,
  outMint: string,
  outAmount: number,
  dex: string = "JUPITER",
): EnhancedTx {
  const inDecimals = inMint === SOL_MINT ? 9 : 6;
  const outDecimals = outMint === SOL_MINT ? 9 : 6;
  return {
    signature: sig,
    timestamp: ts,
    source: dex,
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: inMint, rawTokenAmount: { tokenAmount: String(Math.round(inAmount * 10 ** inDecimals)), decimals: inDecimals } }],
      tokenOutputs: [{ mint: outMint, rawTokenAmount: { tokenAmount: String(Math.round(outAmount * 10 ** outDecimals)), decimals: outDecimals } }],
    },
  };
}

test("LARGE_SWAP: USD threshold boundary (exact match fires, just below stays silent)", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    medianSwapAmount: 0,
    medianSwapAmountUsd: 1000, // 3x multiplier = $3000 threshold
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };

  // Exact threshold: $3,000 >= 3 * 1,000 -> fires
  const exactTx = [makeSwapTx("exact", 1_700_000_100, USDC_MINT, 3000, "MEME", 100)];
  const exactAnomalies = detectAnomalies(WALLET, exactTx, baseline, DEFAULT_CONFIG, {});
  assert.equal(exactAnomalies.filter((a) => a.type === "LARGE_SWAP").length, 1);

  // Just below threshold: $2,999.90 < 3 * 1,000 -> stays silent
  const belowTx = [makeSwapTx("below", 1_700_000_100, USDC_MINT, 2999.9, "MEME", 100)];
  const belowAnomalies = detectAnomalies(WALLET, belowTx, baseline, DEFAULT_CONFIG, {});
  assert.equal(belowAnomalies.filter((a) => a.type === "LARGE_SWAP").length, 0);
});

test("LARGE_SWAP: custom config multiplier (e.g. 5x) is respected", () => {
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 0,
    medianSwapAmountUsd: 1000,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };
  const customConfig = { ...DEFAULT_CONFIG, largeSwapMultiplier: 5 };

  // $4,000 (4x): fires on default 3x, but silent under 5x
  const tx4k = [makeSwapTx("tx4k", 1_700_000_100, USDC_MINT, 4000, "MEME", 100)];
  assert.equal(detectAnomalies(WALLET, tx4k, baseline, customConfig, {}).filter((a) => a.type === "LARGE_SWAP").length, 0);

  // $5,000 (5x): fires under 5x
  const tx5k = [makeSwapTx("tx5k", 1_700_000_100, USDC_MINT, 5000, "MEME", 100)];
  assert.equal(detectAnomalies(WALLET, tx5k, baseline, customConfig, {}).filter((a) => a.type === "LARGE_SWAP").length, 1);
});

test("ACTIVITY_BURST: boundary conditions and severity scaling (medium at threshold, high at 2x)", () => {
  const base = 1_700_000_000;
  const mkTxs = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      signature: "b" + i,
      timestamp: base + i * 30, // 30s apart, well within 10 min window
      source: "JUPITER",
    }));

  // 4 txs (< threshold 5): silent
  const res4 = detectAnomalies(WALLET, mkTxs(4), null);
  assert.equal(res4.some((a) => a.type === "ACTIVITY_BURST"), false);

  // 5 txs (== threshold 5): fires medium
  const res5 = detectAnomalies(WALLET, mkTxs(5), null);
  const burst5 = res5.find((a) => a.type === "ACTIVITY_BURST");
  assert.ok(burst5);
  assert.equal(burst5.severity, "medium");

  // 10 txs (>= 2 * threshold 5): fires high
  const res10 = detectAnomalies(WALLET, mkTxs(10), null);
  const burst10 = res10.find((a) => a.type === "ACTIVITY_BURST");
  assert.ok(burst10);
  assert.equal(burst10.severity, "high");
});

test("ACTIVITY_BURST: window boundary (inclusive at windowSec, exclusive at windowSec + 1)", () => {
  const base = 1_700_000_000;
  const windowSec = DEFAULT_CONFIG.burstWindowMin * 60; // 600s

  // 5 txs: 4 at base + 600, 1 at base (diff = 600s <= windowSec) -> fires
  const txsInclusive: EnhancedTx[] = [
    { signature: "t0", timestamp: base, source: "JUPITER" },
    { signature: "t1", timestamp: base + windowSec, source: "JUPITER" },
    { signature: "t2", timestamp: base + windowSec, source: "JUPITER" },
    { signature: "t3", timestamp: base + windowSec, source: "JUPITER" },
    { signature: "t4", timestamp: base + windowSec, source: "JUPITER" },
  ];
  assert.ok(detectAnomalies(WALLET, txsInclusive, null).some((a) => a.type === "ACTIVITY_BURST"));

  // 5 txs: 4 at base + 601, 1 at base (diff = 601s > windowSec) -> oldest is excluded, only 4 in window -> silent
  const txsExclusive: EnhancedTx[] = [
    { signature: "t0", timestamp: base, source: "JUPITER" },
    { signature: "t1", timestamp: base + windowSec + 1, source: "JUPITER" },
    { signature: "t2", timestamp: base + windowSec + 1, source: "JUPITER" },
    { signature: "t3", timestamp: base + windowSec + 1, source: "JUPITER" },
    { signature: "t4", timestamp: base + windowSec + 1, source: "JUPITER" },
  ];
  assert.equal(detectAnomalies(WALLET, txsExclusive, null).some((a) => a.type === "ACTIVITY_BURST"), false);
});

test("CONCENTRATION: fires at exact threshold, respects count and independent token tracking", () => {
  const base = 1_700_000_000;
  const TOKEN_A = "TokenA11111111111111111111111111111111111";
  const TOKEN_B = "TokenB22222222222222222222222222222222222";

  // Under default config (concentrationCount = 2):
  // 1 swap into TOKEN_A: below threshold (2) -> silent
  const txs1 = [
    makeSwapTx("c1", base, USDC_MINT, 10, TOKEN_A, 100),
  ];
  assert.equal(detectAnomalies(WALLET, txs1, null).filter((a) => a.type === "CONCENTRATION").length, 0);

  // 2 swaps into TOKEN_A: reaches default threshold (2) -> fires
  const txs2 = [
    ...txs1,
    makeSwapTx("c2", base + 60, USDC_MINT, 10, TOKEN_A, 100),
  ];
  const anom2 = detectAnomalies(WALLET, txs2, null).filter((a) => a.type === "CONCENTRATION");
  assert.equal(anom2.length, 1);
  assert.equal(anom2[0].evidence.token, TOKEN_A);
  assert.equal(anom2[0].evidence.count, 2);

  // Custom config with concentrationCount = 3: 2 swaps silent, 3 swaps fires
  const customConfig = { ...DEFAULT_CONFIG, concentrationCount: 3 };
  assert.equal(detectAnomalies(WALLET, txs2, null, customConfig).filter((a) => a.type === "CONCENTRATION").length, 0);

  const txs3 = [
    ...txs2,
    makeSwapTx("c3", base + 120, USDC_MINT, 10, TOKEN_A, 100),
  ];
  const anom3 = detectAnomalies(WALLET, txs3, null, customConfig).filter((a) => a.type === "CONCENTRATION");
  assert.equal(anom3.length, 1);
  assert.equal(anom3[0].evidence.token, TOKEN_A);
  assert.equal(anom3[0].evidence.count, 3);

  // 3 swaps into TOKEN_A and 2 into TOKEN_B under customConfig (count 3): fires only for TOKEN_A
  const mixed = [
    ...txs3,
    makeSwapTx("cb1", base + 30, USDC_MINT, 5, TOKEN_B, 50),
    makeSwapTx("cb2", base + 90, USDC_MINT, 5, TOKEN_B, 50),
  ];
  const mixedAnom = detectAnomalies(WALLET, mixed, null, customConfig).filter((a) => a.type === "CONCENTRATION");
  assert.equal(mixedAnom.length, 1);
  assert.equal(mixedAnom[0].evidence.token, TOKEN_A);
});

test("CONCENTRATION: window boundary (span == windowSec fires, span > windowSec silent)", () => {
  const base = 1_700_000_000;
  const windowSec = DEFAULT_CONFIG.concentrationWindowMin * 60; // 1800s (30 min)
  const TOKEN_A = "TokenA11111111111111111111111111111111111";

  // Span is exactly 1800s (30 min) -> fires
  const txsExact = [
    makeSwapTx("ce1", base, USDC_MINT, 10, TOKEN_A, 100),
    makeSwapTx("ce2", base + 300, USDC_MINT, 10, TOKEN_A, 100),
    makeSwapTx("ce3", base + windowSec, USDC_MINT, 10, TOKEN_A, 100),
  ];
  assert.equal(detectAnomalies(WALLET, txsExact, null).filter((a) => a.type === "CONCENTRATION").length, 1);

  // Span is 1801s (> 30 min) -> silent
  const txsWide = [
    makeSwapTx("cw1", base, USDC_MINT, 10, TOKEN_A, 100),
    makeSwapTx("cw2", base + 300, USDC_MINT, 10, TOKEN_A, 100),
    makeSwapTx("cw3", base + windowSec + 1, USDC_MINT, 10, TOKEN_A, 100),
  ];
  assert.equal(detectAnomalies(WALLET, txsWide, null).filter((a) => a.type === "CONCENTRATION").length, 0);
});

test("updateBaseline: weighted blending of swap medians (raw and USD)", () => {
  // Initial baseline with 10 txs: medianSwapAmount = 50, medianSwapAmountUsd = 500
  const prev: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 50,
    medianSwapAmountUsd: 500,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 10,
  };

  // New batch: 2 swaps with raw SOL inputs [100, 200] (median 150)
  // Priced at $20/SOL -> USD values [2000, 4000] (median 3000)
  const txs = [
    makeSwapTx("nb1", 1_700_000_100, SOL_MINT, 100, USDC_MINT, 2000),
    makeSwapTx("nb2", 1_700_000_200, SOL_MINT, 200, USDC_MINT, 4000),
  ];
  const prices = { [SOL_MINT]: 20 };

  const updated = updateBaseline(WALLET, prev, txs, 1_700_000_300, prices);

  // Blending formula: (prevMedian * prevCount + newMedian * newCount) / (prevCount + newCount)
  // Raw: (50 * 10 + 150 * 2) / (10 + 2) = 800 / 12 = 66.66666666666667
  const expectedRaw = (50 * 10 + 150 * 2) / 12;
  assert.equal(updated.medianSwapAmount, expectedRaw);

  // USD: (500 * 10 + 3000 * 2) / (10 + 2) = 11000 / 12 = 916.6666666666666
  const expectedUsd = (500 * 10 + 3000 * 2) / 12;
  assert.equal(updated.medianSwapAmountUsd, expectedUsd);

  assert.equal(updated.txCount, 12);
  assert.equal(updated.lastSeenAt, 1_700_000_200);
});

test("updateBaseline: non-swap transactions preserve existing medians untouched", () => {
  const prev: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["P1"],
    medianSwapAmount: 75,
    medianSwapAmountUsd: 1500,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 8,
  };

  // 2 transfer txs without swaps
  const nonSwapTxs: EnhancedTx[] = [
    { signature: "ns1", timestamp: 1_700_000_500, source: "SYSTEM_PROGRAM", type: "TRANSFER", programs: ["P2"] },
    { signature: "ns2", timestamp: 1_700_000_600, source: "SYSTEM_PROGRAM", type: "TRANSFER", programs: ["P3"] },
  ];

  const updated = updateBaseline(WALLET, prev, nonSwapTxs, 1_700_000_700);

  // Medians untouched
  assert.equal(updated.medianSwapAmount, 75);
  assert.equal(updated.medianSwapAmountUsd, 1500);

  // Programs and venues accumulated, txCount incremented, lastSeen updated
  assert.equal(updated.txCount, 10);
  assert.equal(updated.lastSeenAt, 1_700_000_600);
  assert.ok(updated.knownPrograms.includes("P1") && updated.knownPrograms.includes("P2") && updated.knownPrograms.includes("P3"));
});

test("DORMANT_ACTIVE: boundary conditions (exact dormantDays fires, just below stays silent)", () => {
  const base = 1_700_000_000;
  const dormantSec = DEFAULT_CONFIG.dormantDays * 86_400; // 7 days = 604,800s
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: base,
    knownVenues: ["JUPITER"],
    knownPrograms: [],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: base,
    txCount: 5,
  };

  // Exactly 7 days later -> fires
  const exactTxs = [swapTx("dExact", base + dormantSec, "JUPITER", 10)];
  assert.ok(detectAnomalies(WALLET, exactTxs, baseline).some((a) => a.type === "DORMANT_ACTIVE"));

  // 1 second before 7 days -> silent
  const belowTxs = [swapTx("dBelow", base + dormantSec - 1, "JUPITER", 10)];
  assert.equal(detectAnomalies(WALLET, belowTxs, baseline).some((a) => a.type === "DORMANT_ACTIVE"), false);
});

