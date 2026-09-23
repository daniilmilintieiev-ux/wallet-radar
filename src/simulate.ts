import { Anomaly, AnomalyType, EnhancedTx } from "./types.js";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { liquidityOf, type TrustInputs, type TrustBalances } from "./trust.js";
import { computeDecision, type DecisionResult, type ActionVerdict } from "./decision.js";

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
export type SimulateAnomaly = AnomalyType | "LARGE_PAYMENT" | "LIQUIDITY_DRAIN";

export interface SimulateInput {
  /** Target wallet address (base58). */
  wallet: string;
  /** Proposed payment amount in USD. */
  amountUsd: number;
  /** Optional raw token amount (e.g. 2 SOL). If set with token 'sol', converted via solPrice. */
  amount?: number;
  /** Token of the proposed payment. Default "usdc". */
  token?: "usdc" | "sol";
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
  } else if (token === "sol") {
    tokenLiquidityUsd = (balances.sol ?? 0) * effectiveSolPrice;
  }

  // Check liquidity
  const exceedsLiquidity = paymentUsd > currentLiquidity || paymentUsd > tokenLiquidityUsd;
  const liquidityAfterUsd = Math.max(0, Math.round((currentLiquidity - paymentUsd) * 100) / 100);

  // Would this payment be "large" relative to the wallet's swap-size profile?
  const wouldTrigger: SimulateAnomaly[] = [];
  let riskDelta = 0;

  if (medianSwapAmountUsd !== null && medianSwapAmountUsd > 0) {
    const ratio = paymentUsd / medianSwapAmountUsd;
    if (ratio >= 3) {
      wouldTrigger.push("LARGE_PAYMENT");
      riskDelta += 20;
    } else if (ratio >= 1.5) {
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
    if ((projectedRiskScore !== null && projectedRiskScore > maxRisk) || liquidityAfterUsd < minLiquidityUsd) {
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

  // Determine if safe to execute
  const safeToExecute = decision.verdict === "allow" && !exceedsLiquidity;

  // Build recommendation
  let recommendation: string;
  if (exceedsLiquidity) {
    if (paymentUsd > tokenLiquidityUsd && paymentUsd <= currentLiquidity) {
      recommendation = `Payment of $${paymentUsd.toFixed(2)} in ${token.toUpperCase()} exceeds available ${token.toUpperCase()} balance ($${tokenLiquidityUsd.toFixed(2)}).`;
    } else {
      recommendation = `Payment of $${paymentUsd.toFixed(2)} exceeds available liquidity ($${currentLiquidity.toFixed(2)}). Reduce amount or wait for replenishment.`;
    }
  } else if (wouldTrigger.length > 0) {
    recommendation = `Payment would trigger ${wouldTrigger.join(", ")} anomaly(s). Risk score projected to rise by ${riskDelta} points. Consider reducing size or splitting the payment.`;
  } else if (decision.verdict === "allow") {
    recommendation = `Payment of $${paymentUsd.toFixed(2)} is within safe limits. Post-payment liquidity: $${liquidityAfterUsd.toFixed(2)}.`;
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
  };
}
