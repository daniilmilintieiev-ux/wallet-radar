import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { simulatePayment, computeTieredLimits, type SimulateInput } from "../src/simulate.js";
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

  it("large payment triggers LARGE_PAYMENT", () => {
    const result = simulatePayment(makeInput({ amountUsd: 200, medianSwapAmountUsd: 50 }));
    assert.ok(result.wouldTrigger.includes("LARGE_PAYMENT"));
    assert.ok(result.riskDelta > 0);
    assert.ok(result.projectedRiskScore! > 15);
  });

  it("payment draining wallet triggers LIQUIDITY_DRAIN", () => {
    const result = simulatePayment(makeInput({ amountUsd: 595, balances: { sol: 0, usdc: 600, usdt: 0 } }));
    assert.ok(result.wouldTrigger.includes("LIQUIDITY_DRAIN"));
  });

  it("no median => no large-payment detection", () => {
    const result = simulatePayment(makeInput({ amountUsd: 500, medianSwapAmountUsd: null }));
    assert.ok(!result.wouldTrigger.includes("LARGE_PAYMENT"));
  });

  it("a transfer is not labeled as a DEX swap (audit 3.3)", () => {
    const result = simulatePayment(makeInput({ amountUsd: 200, medianSwapAmountUsd: 50 }));
    assert.ok(!result.wouldTrigger.includes("LARGE_SWAP"));
    assert.ok(!result.wouldTrigger.includes("CONCENTRATION"));
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

  it("audit 2.2: paying in USDC with 0 USDC balance fails even if SOL liquidity is high", () => {
    // 0 USDC, 1 SOL ($150) -> total liquidity is $150, but USDC liquidity is $0
    const result = simulatePayment(makeInput({
      token: "usdc",
      amountUsd: 10,
      balances: { sol: 1, usdc: 0, usdt: 0 },
      solPrice: 150,
    }));
    assert.equal(result.exceedsLiquidity, true);
    assert.equal(result.safeToExecute, false);
    assert.ok(result.recommendation.includes("exceeds available USDC balance"));
  });

  it("audit 2.2: raw amount in SOL converts to USD via solPrice", () => {
    // 2 SOL @ $150 = $300 payment
    const result = simulatePayment(makeInput({
      token: "sol",
      amount: 2,
      amountUsd: 0,
      balances: { sol: 3, usdc: 0, usdt: 0 },
      solPrice: 150,
      medianSwapAmountUsd: 50,
    }));
    assert.equal(result.exceedsLiquidity, false);
    // $300 / $50 = 6x ratio -> triggers LARGE_PAYMENT
    assert.ok(result.wouldTrigger.includes("LARGE_PAYMENT"));
  });

  it("audit 2.4: falls back to DEFAULT_FALLBACK_SOL_PRICE (150) when solPrice is omitted", () => {
    // 2 SOL with solPrice: null -> $300 payment at fallback $150/SOL
    const result = simulatePayment(makeInput({
      token: "sol",
      amount: 2,
      amountUsd: 0,
      balances: { sol: 3, usdc: 0, usdt: 0 },
      solPrice: null,
      medianSwapAmountUsd: 50,
    }));
    assert.equal(result.exceedsLiquidity, false);
    // $300 / $50 = 6x ratio -> triggers LARGE_PAYMENT
    assert.ok(result.wouldTrigger.includes("LARGE_PAYMENT"));
    assert.equal(result.liquidityAfterUsd, 150);
  });

  describe("Tiered Limits & Execution Engine", () => {
    it("computes tiered limits for safe high-liquidity wallet", () => {
      const limits = computeTieredLimits({
        liquidityUsd: 1000,
        riskScore: 10,
        medianSwapAmountUsd: 100,
        legacyVerdict: "safe",
      });
      assert.equal(limits.instant.allowed, true);
      assert.equal(limits.instant.cooldownSec, 0);
      assert.equal(limits.instant.slippageToleranceBps, 150);
      assert.ok(limits.instant.maxAmountUsd > 0);

      assert.equal(limits.standard.allowed, true);
      assert.equal(limits.standard.cooldownSec, 60);
      assert.equal(limits.standard.slippageToleranceBps, 100);
      assert.ok(limits.standard.maxAmountUsd > limits.instant.maxAmountUsd);

      assert.equal(limits.guarded.allowed, true);
      assert.equal(limits.guarded.cooldownSec, 300);
      assert.equal(limits.guarded.slippageToleranceBps, 50);
      assert.ok(limits.guarded.maxAmountUsd > limits.standard.maxAmountUsd);

      assert.ok(limits.ceilingUsd >= limits.guarded.maxAmountUsd);
    });

    it("restricts instant tier on hold wallet and enforces elevated cooldowns", () => {
      const limits = computeTieredLimits({
        liquidityUsd: 100,
        riskScore: 40,
        medianSwapAmountUsd: 50,
        legacyVerdict: "hold",
      });
      assert.equal(limits.instant.allowed, false);
      assert.equal(limits.standard.allowed, true);
      assert.equal(limits.standard.cooldownSec, 900);
      assert.equal(limits.guarded.cooldownSec, 1800);
    });

    it("strictly shuts down all tiers for high-threat wallet (risk >= 70)", () => {
      const limits = computeTieredLimits({
        liquidityUsd: 5000,
        riskScore: 85,
        medianSwapAmountUsd: 200,
        legacyVerdict: "hold",
      });
      assert.equal(limits.instant.allowed, false);
      assert.equal(limits.standard.allowed, false);
      assert.equal(limits.guarded.allowed, false);
      assert.equal(limits.ceilingUsd, 0);
    });

    it("simulation categorizes micro trade into instant tier with 0s cooldown", () => {
      const result = simulatePayment(makeInput({
        amountUsd: 15,
        balances: { sol: 10, usdc: 2000, usdt: 0 },
        medianSwapAmountUsd: 100,
      }));
      assert.equal(result.safeToExecute, true);
      assert.equal(result.executionTier, "instant");
      assert.equal(result.suggestedCooldownSec, 0);
      assert.equal(result.slippageToleranceBps, 150);
    });

    it("simulation categorizes standard trade into standard tier with 60s cooldown", () => {
      const result = simulatePayment(makeInput({
        amountUsd: 75,
        balances: { sol: 10, usdc: 2000, usdt: 0 },
        medianSwapAmountUsd: 50,
      }));
      assert.equal(result.safeToExecute, true);
      assert.equal(result.executionTier, "standard");
      assert.equal(result.suggestedCooldownSec, 60);
      assert.equal(result.slippageToleranceBps, 100);
    });

    it("simulation detects toxic token mint with freeze authority and blocks payment", () => {
      const result = simulatePayment(makeInput({
        amountUsd: 50,
        mint: "ToxicMint11111111111111111111111111111111",
        mintRisk: {
          mint: "ToxicMint11111111111111111111111111111111",
          mintAuthority: null,
          freezeAuthority: "MaliciousDev11111111111111111111111111111111",
        },
      }));
      assert.equal(result.safeToExecute, false);
      assert.equal(result.executionTier, "blocked");
      assert.ok(result.wouldTrigger.includes("TOXIC_MINT"));
      assert.ok(result.recommendation.includes("BLOCKED"));
    });
  });
});

