import { Anomaly, Severity } from "./types.js";

/**
 * Decision Engine: transforms the trust-gate output into actionable
 * agent-facing verdicts. The trust gate answers "is this wallet safe?"
 * (safe/hold/unknown); the decision engine answers "what should the agent
 * DO right now?" (allow/throttle/block/manual_review) with a confidence
 * score, risk factors, and operational parameters (suggested limit, cooldown).
 *
 * This is the "Stripe Radar for autonomous on-chain agents" layer:
 * not just a risk score, but a ready-to-execute decision.
 */

export type ActionVerdict = "allow" | "throttle" | "block" | "manual_review";

export interface RiskFactor {
  /** Which rule/signal contributed. */
  source: string;
  /** Human-readable explanation. */
  detail: string;
  /** Numeric contribution to the risk (0-1, normalized). */
  weight: number;
  severity: Severity | "info";
}

export interface DecisionResult {
  /** The actionable verdict. */
  verdict: ActionVerdict;
  /** Confidence in this verdict (0-1). Higher = more certain. */
  confidence: number;
  /** Structured risk factors that drove the decision. */
  riskFactors: RiskFactor[];
  /** Suggested maximum payment size in USD for this wallet right now. */
  suggestedLimitUsd: number | null;
  /** How long (ms) an agent should wait before re-checking. */
  cooldownMs: number;
  /** One-sentence recommendation for the agent. */
  recommendation: string;
  /** The legacy verdict for backward compatibility. */
  legacyVerdict: "safe" | "hold" | "unknown";
  /** Original risk score (0-100), null if unknown. */
  riskScore: number | null;
}

export interface DecisionInputs {
  riskScore: number | null;
  anomalies: Anomaly[];
  liquidityUsd: number;
  legacyVerdict: "safe" | "hold" | "unknown";
  /** Max acceptable risk score. Default 30. */
  maxRisk?: number;
  /** Min acceptable liquidity. Default 50. */
  minLiquidityUsd?: number;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 0.4, medium: 0.2, low: 0.1 };

function buildRiskFactors(anomalies: Anomaly[]): RiskFactor[] {
  const totalWeight = anomalies.reduce((s, a) => s + SEVERITY_WEIGHT[a.severity], 0) || 1;
  return anomalies.map((a) => ({
    source: a.type,
    detail: a.text,
    weight: Math.round((SEVERITY_WEIGHT[a.severity] / totalWeight) * 100) / 100,
    severity: a.severity,
  }));
}

function suggestedLimit(
  legacyVerdict: "safe" | "hold" | "unknown",
  liquidityUsd: number,
  riskScore: number | null,
  minLiquidityUsd: number,
): number | null {
  if (liquidityUsd <= 0) return null;
  if (legacyVerdict === "safe") {
    return Math.min(liquidityUsd, 500);
  }
  if (legacyVerdict === "hold") {
    const riskPenalty = riskScore !== null ? Math.max(0.1, 1 - riskScore / 100) : 0.5;
    return Math.round(liquidityUsd * 0.25 * riskPenalty * 100) / 100;
  }
  return null;
}

function cooldown(
  legacyVerdict: "safe" | "hold" | "unknown",
  maxSev: Severity | null,
): number {
  if (maxSev === "high") return 5 * 60 * 1000;
  if (legacyVerdict === "hold") return 15 * 60 * 1000;
  if (legacyVerdict === "unknown") return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

/**
 * Pure, deterministic decision mapping.
 * No network, no side effects — any agent can recompute the same decision
 * from the same inputs.
 */
export function computeDecision(inputs: DecisionInputs): DecisionResult {
  const maxRisk = inputs.maxRisk ?? 30;
  const minLiquidityUsd = inputs.minLiquidityUsd ?? 50;
  const { riskScore, anomalies, liquidityUsd, legacyVerdict } = inputs;
  const factors = buildRiskFactors(anomalies);
  const maxSev = anomalies.reduce<Severity | null>(
    (m, a) => (m === null || sevRank(a.severity) < sevRank(m)) ? a.severity : m,
    null,
  );

  let verdict: ActionVerdict;
  let confidence: number;
  let recommendation: string;

  // Any HIGH severity anomaly => block
  if (anomalies.some((a) => a.severity === "high")) {
    verdict = "block";
    confidence = Math.min(0.95, 0.7 + (riskScore ?? 50) / 200);
    recommendation = "Block payment: high-severity anomaly detected. Wait for cooldown and re-scan.";
  } else if (legacyVerdict === "unknown") {
    verdict = "manual_review";
    confidence = 0.4;
    recommendation = "Insufficient data for automated decision. Escalate to manual review or reduce exposure.";
  } else if (legacyVerdict === "hold") {
    if ((riskScore ?? 0) > maxRisk * 1.5 || liquidityUsd < minLiquidityUsd * 0.5) {
      verdict = "manual_review";
      confidence = 0.55;
      recommendation = "Elevated risk or low liquidity. Manual review recommended before proceeding.";
    } else {
      verdict = "throttle";
      confidence = 0.65;
      recommendation = "Reduce payment size to the suggested limit. Re-check after cooldown.";
    }
  } else {
    // legacyVerdict === "safe"
    if (liquidityUsd < minLiquidityUsd) {
      verdict = "throttle";
      confidence = 0.7;
      recommendation = "Wallet is safe but liquidity is thin. Limit payment to available balance.";
    } else {
      verdict = "allow";
      confidence = Math.min(0.95, 0.75 + ((maxRisk - (riskScore ?? 0)) / maxRisk) * 0.2);
      recommendation = "Approved. Payment within suggested limit is safe to execute.";
    }
  }

  const limit = suggestedLimit(legacyVerdict, liquidityUsd, riskScore, minLiquidityUsd);
  const cd = cooldown(legacyVerdict, maxSev);

  return {
    verdict,
    confidence: Math.round(confidence * 100) / 100,
    riskFactors: factors,
    suggestedLimitUsd: limit,
    cooldownMs: cd,
    recommendation,
    legacyVerdict,
    riskScore,
  };
}

function sevRank(s: Severity): number {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}
