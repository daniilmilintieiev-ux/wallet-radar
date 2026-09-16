import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShortlist,
  computeTrustVerdict,
  liquidityOf,
  selectScoring,
  TRUST_DEFAULTS,
  TrustInputs,
  TrustResult,
} from "../src/trust.js";
import type { EnhancedTx } from "../src/types.js";
import { aggregateConsensus, behaviorAgent, solvencyAgent, identityAgent } from "../src/consensus.js";

const DAY = 86_400;
function txAt(ts: number): EnhancedTx {
  return { signature: `sig_${ts}`, timestamp: ts };
}

const BASE: TrustInputs = {
  riskScore: 10,
  balances: { sol: 0.5, usdc: 20, usdt: 10 },
  solPriced: true,
  solPrice: 100,
};

test("safe: risk under max and liquidity over min", () => {
  const r = computeTrustVerdict(BASE);
  assert.equal(r.verdict, "safe");
  assert.deepEqual(r.reasons, []);
  assert.equal(r.liquidityUsd, 80); // 0.5*100 + 20 + 10
});

test("boundaries are inclusive: risk == max and liquidity == min are safe", () => {
  const r = computeTrustVerdict({ ...BASE, riskScore: TRUST_DEFAULTS.maxRisk }, { minLiquidityUsd: 80 });
  assert.equal(r.verdict, "safe");
});

test("hold: risk over max", () => {
  const r = computeTrustVerdict({ ...BASE, riskScore: 75 });
  assert.equal(r.verdict, "hold");
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /risk score 75 > max 30/);
});

test("hold: liquidity under min", () => {
  const r = computeTrustVerdict({ ...BASE, balances: { sol: 0, usdc: 10, usdt: 0 } });
  assert.equal(r.verdict, "hold");
  assert.match(r.reasons[0], /liquidity \$10\.00 < min \$50\.00/);
});

test("hold: both thresholds missed -> both reasons, deterministic order", () => {
  const r = computeTrustVerdict({ ...BASE, riskScore: 90, balances: { sol: 0, usdc: 1, usdt: 0 } });
  assert.equal(r.verdict, "hold");
  assert.deepEqual(r.reasons, [
    "risk score 90 > max 30",
    "liquidity $1.00 < min $50.00",
  ]);
});

test("hold: non-system account owner (PDA) forces hold even with clean risk/liquidity", () => {
  const r = computeTrustVerdict({
    ...BASE,
    accountAuthority: { owner: "SomeProgram11111111111111111111111111111111", isSystemAccount: false },
  });
  assert.equal(r.verdict, "hold");
  assert.ok(r.reasons.some((x) => /not the system program/.test(x)));
});

test("safe: system-account owner does not add a hold reason", () => {
  const r = computeTrustVerdict({
    ...BASE,
    accountAuthority: { owner: "11111111111111111111111111111111", isSystemAccount: true },
  });
  assert.equal(r.verdict, "safe");
  assert.deepEqual(r.reasons, []);
});

test("safe: unknown account authority (RPC unavailable) does not block", () => {
  const r = computeTrustVerdict({ ...BASE, accountAuthority: { owner: null, isSystemAccount: null } });
  assert.equal(r.verdict, "safe");
  assert.deepEqual(r.reasons, []);
});

test("unknown: no history to score", () => {
  const r = computeTrustVerdict({ ...BASE, riskScore: null });
  assert.equal(r.verdict, "unknown");
  assert.deepEqual(r.reasons, ["no history to score risk"]);
});

test("unknown: balance data unavailable", () => {
  const r = computeTrustVerdict({ ...BASE, balances: null });
  assert.equal(r.verdict, "unknown");
  assert.deepEqual(r.reasons, ["balance data unavailable"]);
});

test("unknown: both missing", () => {
  const r = computeTrustVerdict({ riskScore: null, balances: null, solPriced: false, solPrice: null });
  assert.equal(r.verdict, "unknown");
  assert.deepEqual(r.reasons, ["no history to score risk", "balance data unavailable"]);
});

test("sol unpriced: excluded from liquidity, thresholds decide", () => {
  const r = computeTrustVerdict({ ...BASE, solPriced: false, solPrice: null });
  // 0.5 SOL unpriced -> only 30 stable -> under 50 -> hold (liquidity only)
  assert.equal(r.verdict, "hold");
  assert.equal(r.liquidityUsd, 30);
  assert.deepEqual(r.reasons, ["liquidity $30.00 < min $50.00"]);
});

test("sol unpriced but stablecoins suffice: safe (unpriced is informational, carried by solPriced)", () => {
  const r = computeTrustVerdict({
    ...BASE,
    balances: { sol: 5, usdc: 40, usdt: 20 },
    solPriced: false,
    solPrice: null,
  });
  assert.equal(r.verdict, "safe");
  assert.equal(r.liquidityUsd, 60);
  assert.deepEqual(r.reasons, []);
});

test("custom thresholds are honored", () => {
  const r = computeTrustVerdict(BASE, { maxRisk: 5, minLiquidityUsd: 200 });
  assert.equal(r.verdict, "hold");
  assert.match(r.reasons[0], /max 5/);
  assert.match(r.reasons[1], /min \$200\.00/);
});

test("liquidityOf rounds to micro-USD and is stable", () => {
  const v = liquidityOf({ riskScore: 0, balances: { sol: 0.1, usdc: 0, usdt: 0 }, solPriced: true, solPrice: 123.456789 });
  assert.equal(v, 12.345679); // 0.1 * 123.456789 = 12.3456789 -> 12.345679
});

test("zero-activity wallet with capacity: safe (nothing anomalous)", () => {
  const r = computeTrustVerdict({ ...BASE, riskScore: 0 });
  assert.equal(r.verdict, "safe");
});

function mkResult(wallet: string, verdict: "safe" | "hold" | "unknown", riskScore: number | null, liquidityUsd: number): TrustResult {
  return {
    wallet,
    verdict,
    riskScore,
    anomalyCount: 0,
    anomalies: [],
    balances: verdict === "unknown" ? null : { sol: 0, usdc: liquidityUsd, usdt: 0 },
    solPriced: true,
    solPrice: 100,
    accountAuthority: { owner: null, isSystemAccount: null },
    liquidityUsd,
    reasons: verdict === "safe" ? [] : ["test reason"],
    txCount: 1,
    windowDays: 7,
    generatedAt: 0,
    medianSwapAmountUsd: null,
  };
}

test("buildShortlist: groups by verdict and ranks safe by risk then liquidity", () => {
  const results = [
    mkResult("W_HIGH_RISK", "safe", 25, 100),
    mkResult("W_LOW_RISK", "safe", 5, 60),
    mkResult("W_MID_RISK", "safe", 20, 40),
    mkResult("W_HOLD", "hold", 70, 500),
    mkResult("W_UNKNOWN", "unknown", null, 0),
  ];
  const s = buildShortlist(results, 123);
  assert.equal(s.total, 5);
  assert.deepEqual(s.counts, { safe: 3, hold: 1, unknown: 1 });
  // safe ranked: lowest risk first (5, 20, 25)
  assert.deepEqual(s.shortlist.map((r) => r.wallet), ["W_LOW_RISK", "W_MID_RISK", "W_HIGH_RISK"]);
  assert.deepEqual(s.borderline.map((r) => r.wallet), ["W_HOLD"]);
  assert.deepEqual(s.unknown.map((r) => r.wallet), ["W_UNKNOWN"]);
  assert.equal(s.generatedAt, 123);
});

test("buildShortlist: ties on risk rank by liquidity descending", () => {
  const results = [
    mkResult("W_LIQ_LOW", "safe", 10, 80),
    mkResult("W_LIQ_HIGH", "safe", 10, 500),
  ];
  const s = buildShortlist(results, 1);
  assert.deepEqual(s.shortlist.map((r) => r.wallet), ["W_LIQ_HIGH", "W_LIQ_LOW"]);
});

test("buildShortlist: empty input is a valid empty shortlist", () => {
  const s = buildShortlist([], 1);
  assert.equal(s.total, 0);
  assert.deepEqual(s.counts, { safe: 0, hold: 0, unknown: 0 });
  assert.deepEqual(s.shortlist, []);
  assert.deepEqual(s.borderline, []);
  assert.deepEqual(s.unknown, []);
});

test("buildShortlist: is deterministic across repeated calls", () => {
  const results = [
    mkResult("A", "hold", 40, 10),
    mkResult("B", "safe", 15, 200),
    mkResult("C", "safe", 15, 90),
    mkResult("D", "unknown", null, 0),
  ];
  const a = buildShortlist(results, 7);
  const b = buildShortlist(results, 7);
  assert.deepEqual(a, b);
});

test("selectScoring: enough prior history -> baseline=prior, eval=recent window only", () => {
  const now = 1_000_000;
  const windowStart = now - 7 * DAY;
  // Three txs in the prior window (8-10 days ago), two in the recent window.
  const prior = [now - 10 * DAY, now - 9 * DAY, now - 8 * DAY].map(txAt);
  const recent = [now - 2 * DAY, now - 1 * DAY].map(txAt);
  const { baselineTxs, evalTxs } = selectScoring([...prior, ...recent], windowStart);
  assert.equal(baselineTxs.length, 3);
  assert.equal(evalTxs.length, 2);
  assert.ok(evalTxs.every((t) => t.timestamp >= windowStart));
  assert.ok(baselineTxs.every((t) => t.timestamp < windowStart));
});

test("selectScoring: thin prior history -> snapshot (baseline=eval=whole window)", () => {
  const now = 1_000_000;
  const windowStart = now - 7 * DAY;
  // Only two prior txs (< MIN_PRIOR_SAMPLES=3): fall back to snapshot scoring.
  const prior = [now - 9 * DAY, now - 8 * DAY].map(txAt);
  const recent = [now - 1 * DAY].map(txAt);
  const { baselineTxs, evalTxs } = selectScoring([...prior, ...recent], windowStart);
  assert.equal(baselineTxs.length, 3);
  assert.equal(evalTxs.length, 3);
  assert.ok(baselineTxs === evalTxs);
});

test("selectScoring: no prior history at all -> everything is the window", () => {
  const now = 1_000_000;
  const windowStart = now - 7 * DAY;
  const all = [now - 3 * DAY, now - 2 * DAY, now - 1 * DAY, now - DAY / 2].map(txAt);
  const { baselineTxs, evalTxs } = selectScoring(all, windowStart);
  assert.equal(baselineTxs.length, 4);
  assert.equal(evalTxs.length, 4);
  assert.ok(baselineTxs === evalTxs);
});

// --- Pillar 2: the multi-agent panel must reproduce the legacy gate ---
// The consensus panel (behavior + solvency + identity, unanimous-safe rule) is
// a strict superset of computeTrustVerdict: with no LLM voter it must agree
// with the legacy verdict on every gate scenario, so introducing the panel is
// behavior-preserving.
function panelVerdict(inputs: TrustInputs, opts: { maxRisk?: number; minLiquidityUsd?: number } = {}): string {
  const maxRisk = opts.maxRisk ?? TRUST_DEFAULTS.maxRisk;
  const minLiquidityUsd = opts.minLiquidityUsd ?? TRUST_DEFAULTS.minLiquidityUsd;
  const liquidityUsd = liquidityOf(inputs);
  const votes = [
    behaviorAgent(inputs.riskScore, maxRisk),
    solvencyAgent(inputs.balances, liquidityUsd, minLiquidityUsd),
    identityAgent(inputs.accountAuthority),
  ];
  return aggregateConsensus(votes).verdict;
}

test("consensus panel reproduces the legacy verdict on every gate scenario", () => {
  const scenarios: Array<[string, TrustInputs, { maxRisk?: number; minLiquidityUsd?: number }]> = [
    ["base safe", BASE, {}],
    ["risk==max and liquidity==min", { ...BASE, riskScore: TRUST_DEFAULTS.maxRisk }, { minLiquidityUsd: 80 }],
    ["risk over max", { ...BASE, riskScore: 75 }, {}],
    ["liquidity under min", { ...BASE, balances: { sol: 0, usdc: 10, usdt: 0 } }, {}],
    ["both thresholds missed", { ...BASE, riskScore: 90, balances: { sol: 0, usdc: 1, usdt: 0 } }, {}],
    [
      "non-system owner (PDA)",
      { ...BASE, accountAuthority: { owner: "SomeProgram11111111111111111111111111111111", isSystemAccount: false } },
      {},
    ],
    ["system owner", { ...BASE, accountAuthority: { owner: "11111111111111111111111111111111", isSystemAccount: true } }, {}],
    ["unknown authority (RPC unavailable)", { ...BASE, accountAuthority: { owner: null, isSystemAccount: null } }, {}],
    ["no history to score", { ...BASE, riskScore: null }, {}],
    ["balance data unavailable", { ...BASE, balances: null }, {}],
    ["both missing", { riskScore: null, balances: null, solPriced: false, solPrice: null }, {}],
    ["sol unpriced, stablecoins insufficient", { ...BASE, solPriced: false, solPrice: null }, {}],
    ["sol unpriced, stablecoins suffice", { ...BASE, balances: { sol: 5, usdc: 40, usdt: 20 }, solPriced: false, solPrice: null }, {}],
    ["custom thresholds", BASE, { maxRisk: 5, minLiquidityUsd: 200 }],
    ["zero-activity wallet with capacity", { ...BASE, riskScore: 0 }, {}],
  ];
  for (const [name, inputs, opts] of scenarios) {
    assert.equal(panelVerdict(inputs, opts), computeTrustVerdict(inputs, opts).verdict, name);
  }
});

