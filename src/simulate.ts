import { Anomaly, AnomalyType, EnhancedTx } from "./types.js";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { liquidityOf, type TrustInputs, type TrustBalances } from "./trust.js";
import { computeDecision, type DecisionResult, type ActionVerdict } from "./decision.js";
import { KNOWN_SAFE_MINTS, type MintRiskInfo } from "./mint.js";

/**
 * Simulation Mode: pre-trade what-if analysis.
 *
 * An agent asks: "if wallet Y pays out X USDC right now, what happens to Y?"
 * The wallet under analysis is the PAYER: the proposed payment is modeled as
 * an OUTGOING transfer, so it reduces the wallet's liquidity and is scored
 * against the wallet's swap-size and liquidity profile. A plain transfer is
 * not a DEX swap, so the projected triggers carry their own labels
 * (LARGE_PAYMENT / LIQUIDITY_DRAIN) instead of detector anomaly types.
 * It reports:
 * - Would the payment exceed the wallet's available liquidity?
 * - Would it count as a large payment relative to the median swap size?
 * - What is the post-transaction risk score delta?
 * - What is the actionable decision?
 *
 * This is the "pre-trade risk layer" — the agent asks BEFORE signing,
 * not after the funds are already in motion.
 */

/**
 * A trigger the simulation projects for the proposed payment. Detector anomaly
 * types are included for compatibility; the payment-specific labels below
 * mark heuristics that approximate (but are not) the LARGE_SWAP and
 * CONCENTRATION detector rules.
 */
/** Threshold multiplier relative to historical median swap for LARGE_PAYMENT trigger. */
export const SIMULATE_LARGE_PAYMENT_RATIO = 3;
/** Threshold multiplier relative to historical median swap for moderate size escalation. */
export const SIMULATE_MODERATE_PAYMENT_RATIO = 1.5;

export type SimulateAnomaly = AnomalyType | "LARGE_PAYMENT" | "LIQUIDITY_DRAIN";

export interface LimitTier {
  /** Tier name */
  tier: "instant" | "standard" | "guarded";
  /** Maximum safe payment/trade amount in USD for this tier */
  maxAmountUsd: number;
  /** Whether the tier is approved under current risk profile */
  allowed: boolean;
  /** Recommended minimum delay or cooldown between trades (seconds) */
  cooldownSec: number;
  /** Recommended max slippage tolerance in basis points (e.g. 50 = 0.5%) */
  slippageToleranceBps: number;
  /** Descriptive guidance */
  description: string;
}

export interface TieredLimits {
  /** Micro-execution: zero delay, instant approval for fast trades */
  instant: LimitTier;
  /** Standard copy-trading execution tier */
  standard: LimitTier;
  /** Guarded execution tier for larger volume requiring tight slippage */
  guarded: LimitTier;
  /** Absolute ceiling above which transactions are strictly blocked */
  ceilingUsd: number;
}

export function computeTieredLimits(params: {
  liquidityUsd: number;
  riskScore: number | null;
  medianSwapAmountUsd: number | null;
  legacyVerdict: "safe" | "hold" | "unknown";
}): TieredLimits {
  const { liquidityUsd, riskScore, medianSwapAmountUsd, legacyVerdict } = params;

  if (legacyVerdict === "unknown") {
    return {
      instant: {
        tier: "instant",
        maxAmountUsd: 0,
        allowed: false,
        cooldownSec: 1800,
        slippageToleranceBps: 0,
        description: "Unavailable: insufficient data to establish baseline",
      },
      standard: {
        tier: "standard",
        maxAmountUsd: 0,
        allowed: false,
        cooldownSec: 1800,
        slippageToleranceBps: 0,
        description: "Unavailable: insufficient data to establish baseline",
      },
      guarded: {
        tier: "guarded",
        maxAmountUsd: 0,
        allowed: false,
        cooldownSec: 1800,
        slippageToleranceBps: 0,
        description: "Unavailable: insufficient data to establish baseline",
      },
      ceilingUsd: 0,
    };
  }

  if (legacyVerdict === "hold" || (riskScore !== null && riskScore >= 70)) {
    if (riskScore !== null && riskScore >= 70) {
      return {
        instant: {
          tier: "instant",
          maxAmountUsd: 0,
          allowed: false,
          cooldownSec: 3600,
          slippageToleranceBps: 0,
          description: "Strictly blocked: high-threat wallet profile",
        },
        standard: {
          tier: "standard",
          maxAmountUsd: 0,
          allowed: false,
          cooldownSec: 3600,
          slippageToleranceBps: 0,
          description: "Strictly blocked: high-threat wallet profile",
        },
        guarded: {
          tier: "guarded",
          maxAmountUsd: 0,
          allowed: false,
          cooldownSec: 3600,
          slippageToleranceBps: 0,
          description: "Strictly blocked: high-threat wallet profile",
        },
        ceilingUsd: 0,
      };
    }

    // Moderate risk / hold
    const stdMax = Math.min(25, Math.round(liquidityUsd * 0.1 * 100) / 100);
    const grdMax = Math.min(50, Math.round(liquidityUsd * 0.2 * 100) / 100);
    return {
      instant: {
        tier: "instant",
        maxAmountUsd: 0,
        allowed: false,
        cooldownSec: 900,
        slippageToleranceBps: 50,
        description: "Disabled: instant tier requires safe trust baseline",
      },
      standard: {
        tier: "standard",
        maxAmountUsd: stdMax,
        allowed: liquidityUsd >= 20 && stdMax >= 5,
        cooldownSec: 900,
        slippageToleranceBps: 50,
        description: "Throttled standard tier: reduced volume due to elevated risk",
      },
      guarded: {
        tier: "guarded",
        maxAmountUsd: grdMax,
        allowed: liquidityUsd >= 50 && grdMax >= 10,
        cooldownSec: 1800,
        slippageToleranceBps: 30,
        description: "Guarded tier: tightly throttled ceiling",
      },
      ceilingUsd: grdMax,
    };
  }

  // Safe verdict
  const median = medianSwapAmountUsd && medianSwapAmountUsd > 0 ? medianSwapAmountUsd : 50;
  const instMax = Math.min(100, Math.max(10, Math.round(Math.min(liquidityUsd * 0.15, median * 0.5) * 100) / 100));
  const stdMax = Math.min(500, Math.max(25, Math.round(Math.min(liquidityUsd * 0.35, median * 2.0) * 100) / 100));
  const grdMax = Math.min(2500, Math.max(50, Math.round(Math.min(liquidityUsd * 0.60, median * 5.0) * 100) / 100));
  const ceiling = Math.min(5000, Math.round(liquidityUsd * 0.75 * 100) / 100);

  return {
    instant: {
      tier: "instant",
      maxAmountUsd: Math.min(instMax, ceiling),
      allowed: true,
      cooldownSec: 0,
      slippageToleranceBps: 150,
      description: "Micro-execution: zero delay, instant approval for fast signals",
    },
    standard: {
      tier: "standard",
      maxAmountUsd: Math.min(stdMax, ceiling),
      allowed: true,
      cooldownSec: 60,
      slippageToleranceBps: 100,
      description: "Standard copy trade: baseline-sized execution with 60s cooldown",
    },
    guarded: {
      tier: "guarded",
      maxAmountUsd: Math.min(grdMax, ceiling),
      allowed: true,
      cooldownSec: 300,
      slippageToleranceBps: 50,
      description: "Guarded high-capacity execution: tight 50bps slippage and 300s cooldown",
    },
    ceilingUsd: ceiling,
  };
}

export interface SimulateInput {
  /** Target wallet address (base58). */
  wallet: string;
  /** Proposed payment amount in USD. */
  amountUsd: number;
  /** Optional raw token amount (e.g. 2 SOL). If set with token 'sol', converted via solPrice. */
  amount?: number;
  /** Token of the proposed payment. Default "usdc". */
  token?: "usdc" | "sol" | "usdt";
  /** Current known liquidity of the target wallet. */
  balances: TrustBalances;
  /** SOL price (for converting SOL amount to USD). Null if unknown. */
  solPrice: number | null;
  /** Existing risk score for the wallet (from a prior scan). */
  riskScore: number | null;
  /** Existing anomalies for the wallet. */
  anomalies: Anomaly[];
  /** Baseline median swap amount in USD (reference for large-payment detection). */
  medianSwapAmountUsd: number | null;
  /** Legacy verdict from the trust gate. */
  legacyVerdict: "safe" | "hold" | "unknown";
  /** Max acceptable risk score. */
  maxRisk?: number;
  /** Min acceptable liquidity. */
  minLiquidityUsd?: number;
  /** Optional SPL token mint being acquired or traded */
  mint?: string;
  /** Optional pre-fetched token mint risk info */
  mintRisk?: MintRiskInfo | null;
}

export interface SimulateResult {
  /** The actionable decision for this simulated payment. */
  decision: DecisionResult;
  /** Would this payment exceed the target's available liquidity? */
  exceedsLiquidity: boolean;
  /** Liquidity remaining after the simulated payment. */
  liquidityAfterUsd: number;
  /** Risk score delta: how much the risk score would change. */
  riskDelta: number;
  /** Projected post-transaction risk score. */
  projectedRiskScore: number | null;
  /** Simulated trigger labels that would fire for this payment. */
  wouldTrigger: SimulateAnomaly[];
  /** One-sentence recommendation specific to this payment. */
  recommendation: string;
  /** Whether the payment is safe to execute as-is. */
  safeToExecute: boolean;
  /** Deterministic multi-tier risk boundaries */
  tieredLimits: TieredLimits;
  /** Selected execution tier for the requested payment amount */
  executionTier: "instant" | "standard" | "guarded" | "blocked" | "ceiling_exceeded";
  /** Recommended minimum cooldown in seconds before subsequent trades */
  suggestedCooldownSec: number;
  /** Recommended slippage tolerance in basis points */
  slippageToleranceBps: number;
}

/**
 * Conservative fallback price for SOL (USD) used when Jupiter Price API
 * is unavailable, offline, or returns null (Audit 2.4).
 */
export const DEFAULT_FALLBACK_SOL_PRICE = 150;

/**
 * Pure, deterministic simulation. No network calls.
 * The agent can run this before signing a transaction to get an
 * instant risk assessment of the proposed payment.
 */
export function simulatePayment(input: SimulateInput): SimulateResult {
  const { wallet, amountUsd, balances, solPrice, riskScore, anomalies, medianSwapAmountUsd, legacyVerdict } = input;
  const token = input.token ?? "usdc";
  const maxRisk = input.maxRisk ?? 30;
  const minLiquidityUsd = input.minLiquidityUsd ?? 50;

  const effectiveSolPrice =
    solPrice !== null
      ? solPrice
      : Number(process.env.RADAR_FALLBACK_SOL_PRICE) || DEFAULT_FALLBACK_SOL_PRICE;

  // Convert payment to USD (audit 2.2 / audit 2.4)
  let paymentUsd = amountUsd;
  if (input.amount !== undefined) {
    if (token === "sol") {
      paymentUsd = input.amount * effectiveSolPrice;
    } else {
      paymentUsd = input.amount;
    }
  }

  // Current liquidity
  const trustInputs: TrustInputs = {
    riskScore,
    balances,
    solPriced: true,
    solPrice: effectiveSolPrice,
  };
  const currentLiquidity = liquidityOf(trustInputs);

  // Asset-specific liquidity check (audit 2.2 / audit 2.4):
  // Even if total USD liquidity is sufficient, paying with a specific token fails
  // if the wallet has insufficient balance in that specific asset.
  let tokenLiquidityUsd = currentLiquidity;
  if (token === "usdc") {
    tokenLiquidityUsd = balances.usdc ?? 0;
  } else if (token === "usdt") {
    tokenLiquidityUsd = balances.usdt ?? 0;
  } else if (token === "sol") {
    tokenLiquidityUsd = (balances.sol ?? 0) * effectiveSolPrice;
  }

  // Check liquidity
  const exceedsLiquidity = paymentUsd > currentLiquidity || paymentUsd > tokenLiquidityUsd;
  const liquidityAfterUsd = Math.max(0, Math.round((currentLiquidity - paymentUsd) * 100) / 100);

  // Would this payment be "large" relative to the wallet's swap-size profile?
  const wouldTrigger: SimulateAnomaly[] = [];
  let riskDelta = 0;

  // Evaluate token mint honeypot / concentration risk if mint info provided
  if (input.mint && input.mintRisk) {
    if (input.mintRisk.freezeAuthority && !KNOWN_SAFE_MINTS.has(input.mint)) {
      wouldTrigger.push("TOXIC_MINT");
      riskDelta += 50;
    }
    if (typeof input.mintRisk.top10Pct === "number" && input.mintRisk.top10Pct >= 80) {
      wouldTrigger.push("CONCENTRATION");
      riskDelta += 25;
    }
  }

  if (medianSwapAmountUsd !== null && medianSwapAmountUsd > 0) {
    const ratio = paymentUsd / medianSwapAmountUsd;
    if (ratio >= SIMULATE_LARGE_PAYMENT_RATIO) {
      wouldTrigger.push("LARGE_PAYMENT");
      riskDelta += 20;
    } else if (ratio >= SIMULATE_MODERATE_PAYMENT_RATIO) {
      riskDelta += 8;
    }
  }

  // If the outgoing payment would leave the wallet nearly empty, that's a signal
  if (!exceedsLiquidity && liquidityAfterUsd < 10 && currentLiquidity > 50) {
    wouldTrigger.push("LIQUIDITY_DRAIN");
    riskDelta += 10;
  }

  // Projected risk score
  const projectedRiskScore = riskScore !== null ? Math.min(100, riskScore + riskDelta) : null;

  // Recompute projected verdict so decision engine reflects post-payment risk/liquidity
  let projectedLegacyVerdict: "safe" | "hold" | "unknown" = legacyVerdict;
  if (projectedLegacyVerdict !== "unknown") {
    if ((projectedRiskScore !== null && projectedRiskScore > maxRisk) || liquidityAfterUsd < minLiquidityUsd || wouldTrigger.includes("TOXIC_MINT")) {
      projectedLegacyVerdict = "hold";
    }
  }

  // Compute the decision based on projected state
  const decisionInputs = {
    riskScore: projectedRiskScore,
    anomalies: anomalies,
    liquidityUsd: liquidityAfterUsd,
    legacyVerdict: projectedLegacyVerdict,
    maxRisk,
    minLiquidityUsd,
  };

  const decision = computeDecision(decisionInputs);

  // Compute deterministic tiered limits
  const tieredLimits = computeTieredLimits({
    liquidityUsd: currentLiquidity,
    riskScore: projectedRiskScore,
    medianSwapAmountUsd,
    legacyVerdict: projectedLegacyVerdict,
  });

  // Determine if safe to execute
  const isBlocked = decision.verdict === "block" || wouldTrigger.includes("TOXIC_MINT");
  const isThrottled = decision.verdict === "throttle" && !isBlocked;
  const safeToExecute = decision.verdict === "allow" && !exceedsLiquidity && !isBlocked;

  // Determine execution tier and parameters
  let executionTier: "instant" | "standard" | "guarded" | "blocked" | "ceiling_exceeded";
  let suggestedCooldownSec = 0;
  let slippageToleranceBps = 100;

  if (isBlocked) {
    executionTier = "blocked";
    suggestedCooldownSec = Math.round(decision.cooldownMs / 1000);
    slippageToleranceBps = 0;
  } else if (isThrottled) {
    executionTier = paymentUsd <= tieredLimits.guarded.maxAmountUsd ? "guarded" : "standard";
    suggestedCooldownSec = Math.max(60, Math.round(decision.cooldownMs / 1000) || 60);
    slippageToleranceBps = 50;
  } else if (exceedsLiquidity || paymentUsd > tieredLimits.ceilingUsd) {
    executionTier = "ceiling_exceeded";
    suggestedCooldownSec = 300;
    slippageToleranceBps = 30;
  } else if (paymentUsd <= tieredLimits.instant.maxAmountUsd && tieredLimits.instant.allowed) {
    executionTier = "instant";
    suggestedCooldownSec = tieredLimits.instant.cooldownSec;
    slippageToleranceBps = tieredLimits.instant.slippageToleranceBps;
  } else if (paymentUsd <= tieredLimits.standard.maxAmountUsd && tieredLimits.standard.allowed) {
    executionTier = "standard";
    suggestedCooldownSec = tieredLimits.standard.cooldownSec;
    slippageToleranceBps = tieredLimits.standard.slippageToleranceBps;
  } else if (paymentUsd <= tieredLimits.guarded.maxAmountUsd && tieredLimits.guarded.allowed) {
    executionTier = "guarded";
    suggestedCooldownSec = tieredLimits.guarded.cooldownSec;
    slippageToleranceBps = tieredLimits.guarded.slippageToleranceBps;
  } else {
    executionTier = "ceiling_exceeded";
    suggestedCooldownSec = 300;
    slippageToleranceBps = 50;
  }

  // Build recommendation
  let recommendation: string;
  if (wouldTrigger.includes("TOXIC_MINT")) {
    recommendation = `Payment BLOCKED: Target token mint has active freeze authority or exploit profile.`;
  } else if (exceedsLiquidity) {
    if (paymentUsd > tokenLiquidityUsd && paymentUsd <= currentLiquidity) {
      recommendation = `Payment of $${paymentUsd.toFixed(2)} in ${token.toUpperCase()} exceeds available ${token.toUpperCase()} balance ($${tokenLiquidityUsd.toFixed(2)}).`;
    } else {
      recommendation = `Payment of $${paymentUsd.toFixed(2)} exceeds available liquidity ($${currentLiquidity.toFixed(2)}). Reduce amount or wait for replenishment.`;
    }
  } else if (wouldTrigger.length > 0) {
    recommendation = `Payment would trigger ${wouldTrigger.join(", ")} anomaly(s). Risk score projected to rise by ${riskDelta} points. Consider reducing size or splitting the payment.`;
  } else if (decision.verdict === "allow") {
    recommendation = `Payment of $${paymentUsd.toFixed(2)} is within safe limits (Tier: ${executionTier.toUpperCase()}). Post-payment liquidity: $${liquidityAfterUsd.toFixed(2)}.`;
  } else if (decision.verdict === "throttle") {
    recommendation = `Reduce payment to $${decision.suggestedLimitUsd?.toFixed(2) ?? "a smaller amount"}. Current payment size is elevated relative to wallet profile.`;
  } else {
    recommendation = decision.recommendation;
  }

  return {
    decision,
    exceedsLiquidity,
    liquidityAfterUsd,
    riskDelta,
    projectedRiskScore,
    wouldTrigger,
    recommendation,
    safeToExecute,
    tieredLimits,
    executionTier,
    suggestedCooldownSec,
    slippageToleranceBps,
  };
}
