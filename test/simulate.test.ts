import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { simulatePayment, type SimulateInput } from "../src/simulate.js";
import { Anomaly } from "../src/types.js";

function makeInput(overrides: Partial<SimulateInput> = {}): SimulateInput {
  return {
    wallet: "TestWallet11111111111111111111111111111111",
    amountUsd: 100,
    balances: { sol: 1, usdc: 500, usdt: 0 },
    solPrice: 150,
    riskScore: 15,
    anomalies: [],
    medianSwapAmountUsd: 50,
    legacyVerdict: "safe",
    ...overrides,
  };
}

describe("simulatePayment", () => {
  it("small payment to safe wallet => safeToExecute", () => {
    const result = simulatePayment(makeInput({ amountUsd: 50 }));
    assert.equal(result.safeToExecute, true);
    assert.equal(result.decision.verdict, "allow");
    assert.equal(result.exceedsLiquidity, false);
    assert.ok(result.liquidityAfterUsd > 0);
  });

  it("payment exceeding liquidity => exceedsLiquidity", () => {
    const result = simulatePayment(makeInput({ amountUsd: 1000 }));
    assert.equal(result.exceedsLiquidity, true);
    assert.equal(result.safeToExecute, false);
    assert.ok(result.liquidityAfterUsd === 0);
    assert.ok(result.recommendation.includes("exceeds"));
  });

  it("large payment triggers LARGE_SWAP", () => {
    const result = simulatePayment(makeInput({ amountUsd: 200, medianSwapAmountUsd: 50 }));
    assert.ok(result.wouldTrigger.includes("LARGE_SWAP"));
    assert.ok(result.riskDelta > 0);
    assert.ok(result.projectedRiskScore! > 15);
  });

  it("payment draining wallet triggers CONCENTRATION", () => {
    const result = simulatePayment(makeInput({ amountUsd: 595, balances: { sol: 0, usdc: 600, usdt: 0 } }));
    assert.ok(result.wouldTrigger.includes("CONCENTRATION"));
  });

  it("no median => no LARGE_SWAP detection", () => {
    const result = simulatePayment(makeInput({ amountUsd: 500, medianSwapAmountUsd: null }));
    assert.ok(!result.wouldTrigger.includes("LARGE_SWAP"));
  });

  it("high-risk wallet => decision is not allow", () => {
    const result = simulatePayment(makeInput({
      riskScore: 60,
      anomalies: [{ type: "ACTIVITY_BURST" as const, wallet: "W", severity: "high" as const, timestamp: 1000, evidence: {}, text: "Burst" }],
      legacyVerdict: "hold",
    }));
    assert.equal(result.decision.verdict, "block");
    assert.equal(result.safeToExecute, false);
  });

  it("hold wallet with small payment => throttle or allow", () => {
    const result = simulatePayment(makeInput({
      riskScore: 35,
      legacyVerdict: "hold",
      amountUsd: 20,
    }));
    assert.ok(["allow", "throttle"].includes(result.decision.verdict));
  });

  it("riskDelta is 0 for small payments with no triggers", () => {
    const result = simulatePayment(makeInput({ amountUsd: 10, medianSwapAmountUsd: 100 }));
    assert.equal(result.riskDelta, 0);
    assert.equal(result.projectedRiskScore, 15);
  });

  it("recommendation is specific to the payment", () => {
    const small = simulatePayment(makeInput({ amountUsd: 10 }));
    assert.ok(small.recommendation.includes("$10.00"));

    const big = simulatePayment(makeInput({ amountUsd: 900 }));
    assert.ok(big.recommendation.length > 20);
  });

  it("solPrice null => SOL excluded from liquidity", () => {
    const result = simulatePayment(makeInput({
      balances: { sol: 10, usdc: 50, usdt: 0 },
      solPrice: null,
      amountUsd: 40,
    }));
    assert.equal(result.exceedsLiquidity, false);
    assert.ok(result.liquidityAfterUsd >= 0);
  });

  it("zero liquidity => exceedsLiquidity for any positive amount", () => {
    const result = simulatePayment(makeInput({
      balances: { sol: 0, usdc: 0, usdt: 0 },
      amountUsd: 1,
    }));
    assert.equal(result.exceedsLiquidity, true);
    assert.equal(result.decision.suggestedLimitUsd, null);
  });

  it("payment driving projected risk over maxRisk flips legacyVerdict to hold and throttles", () => {
    // Initial risk 25 (safe under maxRisk 30), but 3x median swap triggers LARGE_SWAP (+20 risk -> 45)
    const result = simulatePayment(makeInput({
      riskScore: 25,
      legacyVerdict: "safe",
      amountUsd: 150,
      medianSwapAmountUsd: 50,
      maxRisk: 30,
    }));
    assert.equal(result.projectedRiskScore, 45);
    assert.equal(result.decision.legacyVerdict, "hold");
    assert.notEqual(result.decision.verdict, "allow");
    assert.equal(result.safeToExecute, false);
  });

  it("payment draining liquidity below minLiquidityUsd flips legacyVerdict to hold", () => {
    const result = simulatePayment(makeInput({
      riskScore: 10,
      legacyVerdict: "safe",
      balances: { sol: 0, usdc: 100, usdt: 0 },
      amountUsd: 70, // Leaves $30 liquidity, below minLiquidityUsd 50
      minLiquidityUsd: 50,
    }));
    assert.equal(result.liquidityAfterUsd, 30);
    assert.equal(result.decision.legacyVerdict, "hold");
    assert.notEqual(result.decision.verdict, "allow");
  });
});
