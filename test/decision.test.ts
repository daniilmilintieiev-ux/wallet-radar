import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDecision, type DecisionInputs } from "../src/decision.js";
import { Anomaly } from "../src/types.js";

function makeAnomaly(type: string, severity: "low" | "medium" | "high", text: string, ts: number = 1000): Anomaly {
  return { type: type as Anomaly["type"], wallet: "W", severity, timestamp: ts, evidence: {}, text };
}

describe("computeDecision", () => {
  it("safe + high liquidity => allow", () => {
    const result = computeDecision({
      riskScore: 10,
      anomalies: [],
      liquidityUsd: 500,
      legacyVerdict: "safe",
    });
    assert.equal(result.verdict, "allow");
    assert.ok(result.confidence > 0.7);
    assert.equal(result.legacyVerdict, "safe");
    assert.ok(result.recommendation.includes("Approved"));
  });

  it("safe + low liquidity => throttle", () => {
    const result = computeDecision({
      riskScore: 10,
      anomalies: [],
      liquidityUsd: 20,
      legacyVerdict: "safe",
    });
    assert.equal(result.verdict, "throttle");
    assert.ok(result.suggestedLimitUsd !== null);
    assert.ok(result.suggestedLimitUsd <= 20);
  });

  it("hold + medium risk => throttle", () => {
    const result = computeDecision({
      riskScore: 45,
      anomalies: [makeAnomaly("NEW_VENUE", "medium", "New venue detected", 2000)],
      liquidityUsd: 200,
      legacyVerdict: "hold",
    });
    assert.equal(result.verdict, "throttle");
    assert.ok(result.riskFactors.length > 0);
  });

  it("hold + very high risk => manual_review", () => {
    const result = computeDecision({
      riskScore: 70,
      anomalies: [makeAnomaly("ACTIVITY_BURST", "medium", "Burst activity", 2000)],
      liquidityUsd: 200,
      legacyVerdict: "hold",
    });
    assert.equal(result.verdict, "manual_review");
  });

  it("unknown => manual_review", () => {
    const result = computeDecision({
      riskScore: null,
      anomalies: [],
      liquidityUsd: 0,
      legacyVerdict: "unknown",
    });
    assert.equal(result.verdict, "manual_review");
    assert.equal(result.confidence, 0.4);
  });

  it("any high-severity anomaly => block", () => {
    const result = computeDecision({
      riskScore: 80,
      anomalies: [makeAnomaly("TOXIC_MINT", "high", "Freeze authority present", 3000)],
      liquidityUsd: 500,
      legacyVerdict: "hold",
    });
    assert.equal(result.verdict, "block");
    assert.ok(result.confidence > 0.7);
    assert.ok(result.recommendation.includes("Block"));
    assert.ok(result.cooldownMs >= 5 * 60 * 1000);
  });

  it("high-severity anomaly overrides safe verdict", () => {
    const result = computeDecision({
      riskScore: 25,
      anomalies: [makeAnomaly("TOXIC_MINT", "high", "Mint has freeze authority", 3000)],
      liquidityUsd: 1000,
      legacyVerdict: "safe",
    });
    assert.equal(result.verdict, "block");
  });

  it("risk factors have normalized weights summing to ~1", () => {
    const anomalies = [
      makeAnomaly("NEW_VENUE", "low", "New venue", 1000),
      makeAnomaly("NEW_PROTOCOL", "medium", "New protocol", 2000),
      makeAnomaly("LARGE_SWAP", "high", "Large swap", 3000),
    ];
    const result = computeDecision({
      riskScore: 60,
      anomalies,
      liquidityUsd: 100,
      legacyVerdict: "hold",
    });
    const totalWeight = result.riskFactors.reduce((s, f) => s + f.weight, 0);
    assert.ok(Math.abs(totalWeight - 1) < 0.15, `weights should sum to ~1, got ${totalWeight}`);
    assert.equal(result.riskFactors.length, 3);
  });

  it("suggestedLimitUsd is null when liquidity is zero", () => {
    const result = computeDecision({
      riskScore: 10,
      anomalies: [],
      liquidityUsd: 0,
      legacyVerdict: "safe",
    });
    assert.equal(result.suggestedLimitUsd, null);
  });

  it("cooldown increases with severity", () => {
    const safe = computeDecision({ riskScore: 5, anomalies: [], liquidityUsd: 100, legacyVerdict: "safe" });
    const blocked = computeDecision({
      riskScore: 80,
      anomalies: [makeAnomaly("TOXIC_MINT", "high", "Toxic", 1000)],
      liquidityUsd: 100,
      legacyVerdict: "hold",
    });
    assert.ok(blocked.cooldownMs < safe.cooldownMs);
  });

  it("confidence is between 0 and 1", () => {
    const cases: DecisionInputs[] = [
      { riskScore: 0, anomalies: [], liquidityUsd: 100, legacyVerdict: "safe" },
      { riskScore: 50, anomalies: [makeAnomaly("X", "medium", "x", 1)], liquidityUsd: 50, legacyVerdict: "hold" },
      { riskScore: null, anomalies: [], liquidityUsd: 0, legacyVerdict: "unknown" },
      { riskScore: 90, anomalies: [makeAnomaly("X", "high", "x", 1)], liquidityUsd: 200, legacyVerdict: "hold" },
    ];
    for (const input of cases) {
      const r = computeDecision(input);
      assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence ${r.confidence} out of range for ${r.verdict}`);
    }
  });

  it("maxRisk: 0 guard does not produce NaN confidence", () => {
    const r = computeDecision({
      riskScore: 0,
      anomalies: [],
      liquidityUsd: 100,
      legacyVerdict: "safe",
      maxRisk: 0,
    });
    assert.equal(r.verdict, "allow");
    assert.equal(typeof r.confidence, "number");
    assert.ok(!Number.isNaN(r.confidence));
    assert.ok(r.confidence >= 0.75 && r.confidence <= 0.95);
  });

  it("hold + thin liquidity (< minLiquidity * 0.5) escalates to manual_review", () => {
    const r = computeDecision({
      riskScore: 35,
      anomalies: [makeAnomaly("NEW_VENUE", "medium", "New venue", 1)],
      liquidityUsd: 20, // 20 < 50 * 0.5 = 25
      legacyVerdict: "hold",
      minLiquidityUsd: 50,
    });
    assert.equal(r.verdict, "manual_review");
    assert.equal(r.confidence, 0.55);
    assert.ok(r.recommendation.includes("Manual review"));
  });

  it("custom minLiquidityUsd throttles safe wallet when balance is below threshold", () => {
    const r = computeDecision({
      riskScore: 5,
      anomalies: [],
      liquidityUsd: 150,
      legacyVerdict: "safe",
      minLiquidityUsd: 200, // 150 < 200
    });
    assert.equal(r.verdict, "throttle");
    assert.equal(r.suggestedLimitUsd, 150);
  });

  it("hold with riskScore: null applies default riskPenalty to suggested limit", () => {
    const r = computeDecision({
      riskScore: null,
      anomalies: [makeAnomaly("NEW_VENUE", "medium", "New venue", 1)],
      liquidityUsd: 200,
      legacyVerdict: "hold",
    });
    // 200 * 0.25 * 0.5 = 25
    assert.equal(r.suggestedLimitUsd, 25);
  });

  it("suggestedLimitUsd is capped at 500 for safe wallets with high liquidity", () => {
    const r = computeDecision({
      riskScore: 10,
      anomalies: [],
      liquidityUsd: 2500,
      legacyVerdict: "safe",
    });
    assert.equal(r.suggestedLimitUsd, 500);
  });

  it("suggestedLimitUsd is null for negative or zero liquidity", () => {
    const rZero = computeDecision({ riskScore: 10, anomalies: [], liquidityUsd: 0, legacyVerdict: "safe" });
    assert.equal(rZero.suggestedLimitUsd, null);

    const rNeg = computeDecision({ riskScore: 10, anomalies: [], liquidityUsd: -50, legacyVerdict: "safe" });
    assert.equal(rNeg.suggestedLimitUsd, null);
  });

  it("cooldownMs maps accurately to severity and legacy verdicts", () => {
    // 1. high severity anomaly -> 5 minutes
    const high = computeDecision({
      riskScore: 80,
      anomalies: [makeAnomaly("TOXIC_MINT", "high", "Freeze authority")],
      liquidityUsd: 100,
      legacyVerdict: "hold",
    });
    assert.equal(high.cooldownMs, 5 * 60 * 1000);

    // 2. legacy hold (no high severity) -> 15 minutes
    const hold = computeDecision({
      riskScore: 40,
      anomalies: [makeAnomaly("NEW_VENUE", "medium", "New venue")],
      liquidityUsd: 100,
      legacyVerdict: "hold",
    });
    assert.equal(hold.cooldownMs, 15 * 60 * 1000);

    // 3. legacy unknown -> 30 minutes
    const unknown = computeDecision({
      riskScore: null,
      anomalies: [],
      liquidityUsd: 0,
      legacyVerdict: "unknown",
    });
    assert.equal(unknown.cooldownMs, 30 * 60 * 1000);

    // 4. legacy safe -> 60 minutes
    const safe = computeDecision({
      riskScore: 5,
      anomalies: [],
      liquidityUsd: 200,
      legacyVerdict: "safe",
    });
    assert.equal(safe.cooldownMs, 60 * 60 * 1000);
  });
});

