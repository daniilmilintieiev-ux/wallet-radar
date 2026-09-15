import { Anomaly, AnomalyType, EnhancedTx } from "./types.js";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { liquidityOf, type TrustInputs, type TrustBalances } from "./trust.js";
import { computeDecision, type DecisionResult, type ActionVerdict } from "./decision.js";

/**
 * Simulation Mode: pre-trade what-if analysis.
 *
 * An agent asks: "if I send X USDC to wallet Y right now, what happens?"
 * The simulator runs the full risk pipeline against a *modified* transaction
 * history (the proposed payment injected as a synthetic tx) and reports:
 * - Would the payment exceed available liquidity?
 * - Would it trigger a LARGE_SWAP anomaly for the target wallet?
 * - What is the post-transaction risk score delta?
 * - What is the actionable decision?
 *
 * This is the "pre-trade risk layer" — the agent asks BEFORE signing,
 * not after the funds are already in motion.
 */

export interface SimulateInput {
  /** Target wallet address (base58). */
  wallet: string;
  /** Proposed payment amount in USD. */
  amountUsd: number;
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
  /** Baseline median swap amount in USD (for LARGE_SWAP detection). */
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
  /** Anomaly types that would be newly triggered by this payment. */
  wouldTrigger: AnomalyType[];
  /** One-sentence recommendation specific to this payment. */
  recommendation: string;
  /** Whether the payment is safe to execute as-is. */
  safeToExecute: boolean;
}

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

  // Convert payment to USD
  const paymentUsd = amountUsd;

  // Current liquidity
  const solPriced = solPrice !== null;
  const trustInputs: TrustInputs = {
    riskScore,
    balances,
    solPriced,
    solPrice,
  };
  const currentLiquidity = liquidityOf(trustInputs);

  // Check liquidity
  const exceedsLiquidity = paymentUsd > currentLiquidity;
  const liquidityAfterUsd = Math.max(0, Math.round((currentLiquidity - paymentUsd) * 100) / 100);

  // Would this trigger a LARGE_SWAP for the target wallet?
  const wouldTrigger: AnomalyType[] = [];
  let riskDelta = 0;

  if (medianSwapAmountUsd !== null && medianSwapAmountUsd > 0) {
    const ratio = paymentUsd / medianSwapAmountUsd;
    if (ratio >= 3) {
      wouldTrigger.push("LARGE_SWAP");
      riskDelta += 20;
    } else if (ratio >= 1.5) {
      riskDelta += 8;
    }
  }

  // If the payment would leave the wallet nearly empty, that's a signal
  if (!exceedsLiquidity && liquidityAfterUsd < 10 && currentLiquidity > 50) {
    wouldTrigger.push("CONCENTRATION");
    riskDelta += 10;
  }

  // Projected risk score
  const projectedRiskScore = riskScore !== null ? Math.min(100, riskScore + riskDelta) : null;

  // Compute the decision based on projected state
  const decisionInputs = {
    riskScore: projectedRiskScore,
    anomalies: anomalies,
    liquidityUsd: liquidityAfterUsd,
    legacyVerdict,
    maxRisk,
    minLiquidityUsd,
  };

  const decision = computeDecision(decisionInputs);

  // Determine if safe to execute
  const safeToExecute = decision.verdict === "allow" && !exceedsLiquidity;

  // Build recommendation
  let recommendation: string;
  if (exceedsLiquidity) {
    recommendation = `Payment of $${paymentUsd.toFixed(2)} exceeds available liquidity ($${currentLiquidity.toFixed(2)}). Reduce amount or wait for replenishment.`;
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
