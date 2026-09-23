import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, extractSwap, computeRiskScore, txCounterparties, SOL_MINT, USDC_MINT, MAJOR_MINTS, OFF_HOURS_MIN_BASELINE_TXS } from "../src/analyzer.js";
import { updateBaseline, RECENT_SWAP_WINDOW } from "../src/baseline.js";
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

test("audit 2.2: relayer txs attribute swap legs and counterparties to the wallet, not the feePayer", () => {
  const relayer = "Relayer111111111111111111111111111111111111";
  const pool = "Pool11111111111111111111111111111111111111111";
  const meme = "Meme111111111111111111111111111111111111111";
  const tx: EnhancedTx = {
    signature: "relayer-sig",
    timestamp: 1_700_000_000,
    source: "JUPITER",
    type: "SWAP",
    feePayer: relayer,
    tokenTransfers: [
      { mint: USDC_MINT, fromUserAccount: WALLET, toUserAccount: pool, tokenAmount: 5_000_000 },
      { mint: meme, fromUserAccount: pool, toUserAccount: WALLET, tokenAmount: 999 },
    ],
  };
  // Without a wallet, the feePayer (relayer) is treated as "self": the user's
  // swap is not recognized...
  assert.equal(extractSwap(tx), null);
  // ...and the user's own address ends up in their own counterparties.
  assert.ok(txCounterparties(tx).includes(WALLET));
  // Passing the wallet under analysis fixes both.
  const s = extractSwap(tx, WALLET);
  assert.ok(s);
  assert.equal(s.tokenIn.mint, USDC_MINT);
  assert.equal(s.tokenIn.amount, 5_000_000);
  assert.equal(s.tokenOut.mint, meme);
  const cps = txCounterparties(tx, WALLET);
  assert.deepEqual(cps, [pool, pool]);
  assert.ok(!cps.includes(WALLET));
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

test("updateBaseline: swap medians track the most-recent window (raw and USD)", () => {
  // Initial baseline with 10 txs: stored medians 50 / $500, no recent window yet
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

  // New batch: 2 swaps with raw SOL inputs [100, 200]
  // Priced at $20/SOL -> USD values [2000, 4000]
  const txs = [
    makeSwapTx("nb1", 1_700_000_100, SOL_MINT, 100, USDC_MINT, 2000),
    makeSwapTx("nb2", 1_700_000_200, SOL_MINT, 200, USDC_MINT, 4000),
  ];
  const prices = { [SOL_MINT]: 20 };

  const updated = updateBaseline(WALLET, prev, txs, 1_700_000_300, prices);

  // The reference size is the median of the most-recent window, NOT a blend
  // with the historical value: raw median([100,200]) = 150, USD median([2000,4000]) = 3000.
  assert.equal(updated.medianSwapAmount, 150);
  assert.equal(updated.medianSwapAmountUsd, 3000);
  assert.deepEqual(updated.recentSwapAmounts, [100, 200]);
  assert.deepEqual(updated.recentSwapAmountsUsd!, [2000, 4000]);

  assert.equal(updated.txCount, 12);
  assert.equal(updated.lastSeenAt, 1_700_000_200);
});

test("updateBaseline: recent window is bounded and old outliers fall out (no median drift)", () => {
  // Previous window is full of large swaps; the wallet now swaps small amounts.
  const prev: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 1000,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 40,
    recentSwapAmounts: Array.from({ length: RECENT_SWAP_WINDOW }, () => 1000),
  };

  // 40 small swaps in the new batch push every large sample out of the window.
  const txs = Array.from({ length: RECENT_SWAP_WINDOW }, (_, i) =>
    makeSwapTx(`sm${i}`, 1_700_001_000 + i * 10, SOL_MINT, 2, USDC_MINT, 40),
  );

  const updated = updateBaseline(WALLET, prev, txs, 1_700_002_000);

  assert.equal(updated.medianSwapAmount, 2);
  assert.equal(updated.recentSwapAmounts!.length, RECENT_SWAP_WINDOW);
});

test("updateBaseline: medianTps is lifetime tx-per-minute and activeHours is a 24-bucket UTC histogram", () => {
  // First batch: 12 txs spanning 30 minutes (1800s).
  const t0 = 1_700_000_000;
  const txs = Array.from({ length: 12 }, (_, i) => ({
    signature: `t${i}`,
    timestamp: t0 + i * 150, // 0..1650s span
  }) as EnhancedTx);

  const b1 = updateBaseline(WALLET, null, txs, t0 + 1800);

  // Span 1650s = 27.5 min -> 12 / 27.5 = 0.43636... tx/min
  assert.ok(Math.abs(b1.medianTps - 12 / 27.5) < 1e-9);
  assert.equal(b1.firstSeenAt, t0);
  assert.equal(b1.lastSeenAt, t0 + 1650);
  assert.equal(b1.activeHours.length, 24);
  assert.equal(b1.activeHours.reduce((s, v) => s + v, 0), 12);

  // Second batch: 3 more txs -> lifetime rate uses the full span.
  const txs2 = [
    { signature: "x1", timestamp: t0 + 1800 } as EnhancedTx,
    { signature: "x2", timestamp: t0 + 1900 } as EnhancedTx,
    { signature: "x3", timestamp: t0 + 2000 } as EnhancedTx,
  ];
  const b2 = updateBaseline(WALLET, b1, txs2, t0 + 2100);
  const spanMin = (b2.lastSeenAt! - b2.firstSeenAt!) / 60; // (t0+2000 - t0)/60 = 33.333
  assert.ok(Math.abs(b2.medianTps - 15 / spanMin) < 1e-9);
  assert.equal(b2.activeHours.reduce((s, v) => s + v, 0), 15);

  // A single-tx baseline never reports a rate (span 0, one sample).
  const single = updateBaseline(WALLET, null, [{ signature: "solo", timestamp: t0 }] as EnhancedTx[], t0);
  assert.equal(single.medianTps, 0);
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

test("LARGE_SWAP (poisoning defense): uses the recent-window median, not a poisoned full-history median", () => {
  // History was dominated by big 1000-unit swaps (full-history median 1000),
  // but the recent window has been all 1-unit swaps. A 10-unit swap is 10x the
  // recent median -> must fire, even though it's tiny vs the old full median.
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    medianSwapAmount: 1000,
    recentSwapAmounts: Array.from({ length: 32 }, () => 1),
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 72,
  };
  const txs = [swapTx("poison", 1_700_000_600, "JUPITER", 10)];
  const anomalies = detectAnomalies(WALLET, txs, baseline);
  assert.ok(anomalies.some((a) => a.type === "LARGE_SWAP"), "10-unit swap should fire against a 1-unit recent median");
});

test("LARGE_SWAP (poisoning defense): raw-path sample floor suppresses a thin baseline", () => {
  // Only 2 major-mint samples (< MIN_BASELINE_SAMPLES=3) -> the raw fallback
  // path must not trust the median, so no LARGE_SWAP even for a 100x swap.
  const baseline: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: ["JUPITER"],
    knownPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    medianSwapAmount: 1,
    recentSwapAmounts: [1, 1],
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 2,
  };
  const txs = [swapTx("thin", 1_700_000_600, "JUPITER", 100)];
  assert.equal(detectAnomalies(WALLET, txs, baseline).some((a) => a.type === "LARGE_SWAP"), false);
});

test("COUNTERPARTY_CLUSTER fires on concentrated counterparty interactions", () => {
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
  const cp = "Counterparty1111111111111111111111111111111111";
  const other = "OtherWallet1111111111111111111111111111111111111";
  const txs = Array.from({ length: 6 }, (_, i) => ({
    signature: `cp_${i}`,
    timestamp: 1_700_000_000 + i,
    source: "JUPITER",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    feePayer: WALLET,
    counterparties: i < 5 ? [cp] : [other],
  }));
  const cluster = detectAnomalies(WALLET, txs, baseline).find((a) => a.type === "COUNTERPARTY_CLUSTER");
  assert.ok(cluster, "expected COUNTERPARTY_CLUSTER");
  assert.equal(cluster.severity, "low");
  assert.equal((cluster.evidence as Record<string, unknown>).topCounterparty, cp);
});

test("COUNTERPARTY_CLUSTER does not fire when interactions are evenly spread", () => {
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
  const txs = Array.from({ length: 8 }, (_, i) => ({
    signature: `even_${i}`,
    timestamp: 1_700_000_000 + i,
    source: "JUPITER",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    feePayer: WALLET,
    counterparties: [`CP${i % 4}11111111111111111111111111111111111`],
  }));
  assert.equal(detectAnomalies(WALLET, txs, baseline).some((a) => a.type === "COUNTERPARTY_CLUSTER"), false);
});

test("txCounterparties derives the counterparty from transfer lists (self excluded)", () => {
  const tx: EnhancedTx = {
    signature: "t1",
    timestamp: 1_700_000_000,
    feePayer: WALLET,
    tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: "Payee11111111111111111111111111111111111", tokenAmount: 5 }],
  };
  assert.deepEqual(txCounterparties(tx), ["Payee11111111111111111111111111111111111"]);
});

// OFF_HOURS (9th rule): activity in UTC hours the wallet has never been active in.
const atUtc = (day: number, hour: number, min: number) => Math.floor(Date.UTC(2026, 8, day, hour, min) / 1000);

function offHoursHistory(): Baseline {
  const history: EnhancedTx[] = [];
  for (let i = 0; i < 24; i++) history.push({ signature: `h${i}`, timestamp: atUtc(1, 14, i) } as EnhancedTx);
  history.push({ signature: "h24", timestamp: atUtc(2, 15, 30) } as EnhancedTx);
  return updateBaseline(WALLET, null, history, atUtc(2, 15, 40));
}

test("OFF_HOURS fires when a majority of the batch lands in historically-dead UTC hours", () => {
  const baseline = offHoursHistory();
  assert.equal(baseline.activeHours.length, 24);
  assert.equal(baseline.activeHours[14], 24);
  assert.equal(baseline.activeHours[15], 1);
  assert.ok(baseline.txCount >= OFF_HOURS_MIN_BASELINE_TXS);

  const batch = [
    { signature: "o1", timestamp: atUtc(3, 3, 10) },
    { signature: "o2", timestamp: atUtc(3, 3, 20) },
    { signature: "o3", timestamp: atUtc(3, 3, 30) },
    { signature: "k1", timestamp: atUtc(3, 14, 45) },
    { signature: "k2", timestamp: atUtc(3, 15, 10) },
  ] as EnhancedTx[];

  const off = detectAnomalies(WALLET, batch, baseline).find((a) => a.type === "OFF_HOURS");
  assert.ok(off, "expected OFF_HOURS anomaly");
  assert.equal(off.severity, "medium");
  assert.deepEqual(off.evidence.offHours, [3]);
  assert.equal(off.evidence.offCount, 3);
  assert.equal(off.evidence.batchTxCount, 5);
});

test("OFF_HOURS stays silent when fewer than half the batch is off-hours", () => {
  const baseline = offHoursHistory();
  const batch = [
    { signature: "o1", timestamp: atUtc(3, 3, 10) },
    { signature: "k1", timestamp: atUtc(3, 14, 15) },
    { signature: "k2", timestamp: atUtc(3, 14, 30) },
    { signature: "k3", timestamp: atUtc(3, 15, 5) },
  ] as EnhancedTx[];
  assert.equal(detectAnomalies(WALLET, batch, baseline).some((a) => a.type === "OFF_HOURS"), false);
});

test("OFF_HOURS stays silent with a thin baseline (insufficient history) or legacy empty profile", () => {
  const thinHistory = Array.from({ length: 10 }, (_, i) => ({ signature: `t${i}`, timestamp: atUtc(1, 14, i) }) as EnhancedTx);
  const thin = updateBaseline(WALLET, null, thinHistory, atUtc(1, 14, 30));
  const batch = [
    { signature: "o1", timestamp: atUtc(2, 3, 10) },
    { signature: "o2", timestamp: atUtc(2, 3, 20) },
    { signature: "o3", timestamp: atUtc(2, 3, 30) },
  ] as EnhancedTx[];
  assert.equal(thin.txCount, 10);
  assert.equal(detectAnomalies(WALLET, batch, thin).some((a) => a.type === "OFF_HOURS"), false);

  // Legacy baseline (pre-feature): activeHours empty -> no profile -> silent.
  const legacy: Baseline = {
    walletAddress: WALLET,
    updatedAt: 1_700_000_000,
    knownVenues: [],
    knownPrograms: [],
    medianSwapAmount: 10,
    medianTps: 0,
    activeHours: [],
    lastSeenAt: 1_700_000_000,
    txCount: 500,
  };
  assert.equal(detectAnomalies(WALLET, batch, legacy).some((a) => a.type === "OFF_HOURS"), false);
});

