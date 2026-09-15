import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, computeRiskScore } from "../src/analyzer.js";
import { EnhancedTx } from "../src/types.js";
import { updateBaseline } from "../src/baseline.js";

const WALLET = "TestWallet1111111111111111111111111111111111";
const NOW = 1_700_000_000;

function makeTxs(count: number, opts: { source?: string; programs?: string[]; largeSwap?: boolean } = {}): EnhancedTx[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: `sig_${i}`,
    timestamp: NOW + i * 30,
    source: opts.source ?? "JUPITER",
    programs: opts.programs ?? ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: opts.largeSwap ? "5000000000" : "100000000", decimals: 9 } }],
      tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: opts.largeSwap ? "750000000000" : "150000000", decimals: 6 } }],
    },
  }));
}

function makeBaseline(txCount: number, knownVenues: string[], knownPrograms: string[]): ReturnType<typeof updateBaseline> {
  const syntheticTxs = Array.from({ length: txCount }, (_, i) => ({
    signature: `base_${i}`,
    timestamp: NOW - 86_400 * 30 + i * 3600,
    source: "JUPITER",
    programs: knownPrograms,
    swap: {
      tokenInputs: [{ mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "100000000", decimals: 9 } }],
      tokenOutputs: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "150000000", decimals: 6 } }],
    },
  }));
  return updateBaseline(WALLET, null, syntheticTxs, NOW - 86_400, null);
}

describe("Anti-evasion: REGIME_SHIFT", () => {
  it("fires when 3+ distinct anomaly types fire simultaneously", () => {
    // Burst (5 tx in window) + NEW_VENUE (RAYDIO not in baseline) + LARGE_SWAP (big swap) + NEW_PROTOCOL
    const baseline = makeBaseline(20, ["JUPITER"], ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    const txs = makeTxs(5, { source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg1111111111111111111111111111111111111111"], largeSwap: true });
    const anomalies = detectAnomalies(WALLET, txs, baseline);
    const types = new Set(anomalies.map((a) => a.type));
    const hasRegimeShift = anomalies.some((a) => a.type === "REGIME_SHIFT");
    assert.ok(hasRegimeShift, `Expected REGIME_SHIFT, got: ${[...types].join(", ")}`);
  });

  it("does NOT fire when only 1-2 anomaly types fire", () => {
    // Only NEW_VENUE (one anomaly type)
    const baseline = makeBaseline(50, ["JUPITER"], ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    const txs = makeTxs(1, { source: "RAYDIO" });
    const anomalies = detectAnomalies(WALLET, txs, baseline);
    const hasRegimeShift = anomalies.some((a) => a.type === "REGIME_SHIFT");
    assert.ok(!hasRegimeShift, "REGIME_SHIFT should not fire with only 1 anomaly type");
  });

  it("REGIME_SHIFT has high severity", () => {
    const baseline = makeBaseline(20, ["JUPITER"], ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    const txs = makeTxs(5, { source: "RAYDIO", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "newProg1111111111111111111111111111111111111111"], largeSwap: true });
    const anomalies = detectAnomalies(WALLET, txs, baseline);
    const regime = anomalies.find((a) => a.type === "REGIME_SHIFT");
    assert.ok(regime);
    assert.equal(regime.severity, "high");
    assert.ok((regime.evidence as Record<string, unknown>).triggeredRules);
  });
});

describe("Anti-evasion: WARMING", () => {
  it("fires when thin baseline + high-severity anomaly", () => {
    // Baseline has only 3 tx (thin), current batch has LARGE_SWAP (high severity)
    const baseline = makeBaseline(3, ["JUPITER"], ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    const txs = makeTxs(1, { largeSwap: true });
    const anomalies = detectAnomalies(WALLET, txs, baseline);
    const hasWarming = anomalies.some((a) => a.type === "WARMING");
    assert.ok(hasWarming, `Expected WARMING, got: ${anomalies.map((a) => a.type).join(", ")}`);
  });

  it("does NOT fire with thick baseline even if anomalies present", () => {
    // Baseline has 50 tx (thick), current batch has anomalies
    const baseline = makeBaseline(50, ["JUPITER"], ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    const txs = makeTxs(1, { largeSwap: true });
    const anomalies = detectAnomalies(WALLET, txs, baseline);
    const hasWarming = anomalies.some((a) => a.type === "WARMING");
    assert.ok(!hasWarming, "WARMING should not fire with thick baseline");
  });

  it("WARMING has medium severity and reports baseline tx count", () => {
    const baseline = makeBaseline(3, ["JUPITER"], ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    const txs = makeTxs(1, { largeSwap: true });
    const anomalies = detectAnomalies(WALLET, txs, baseline);
    const warming = anomalies.find((a) => a.type === "WARMING");
    assert.ok(warming);
    assert.equal(warming.severity, "medium");
    assert.equal((warming.evidence as Record<string, unknown>).baselineTxCount, 3);
  });
});
