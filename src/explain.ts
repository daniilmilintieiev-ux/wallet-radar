import { Anomaly, AnomalyType, Freshness, Severity } from "./types.js";

/** Human-first, per-rule breakdown of a single detected anomaly. */
export interface AnomalyReason {
  /** Which deterministic rule fired. */
  rule: AnomalyType;
  severity: Severity;
  /** One-sentence human-readable explanation (from the detector). */
  reason: string;
  /** Unix seconds of the triggering activity, when known. */
  timestamp: number;
  /** Numeric contribution to overall risk (0-1, normalized across all anomalies). */
  weight: number;
}

/** A single step in the audit trail from raw data to final verdict. */
export interface AuditStep {
  /** Which rule/signal was evaluated. */
  rule: string;
  /** The input that triggered it (e.g. "swap 5.2 SOL vs median 0.3 SOL"). */
  input: string;
  /** The threshold or comparison used. */
  threshold: string;
  /** The result of this evaluation. */
  result: string;
  /** Numeric weight contribution (0-1). */
  weight: number;
  /** Whether this step fired (contributed to the anomaly set). */
  fired: boolean;
}

/**
 * Full audit trail: the complete, machine-readable trace from raw
 * behavioral data to the final verdict. Every decision is reproducible
 * from this trail — a judge, agent, or auditor can replay the logic.
 */
export interface AuditTrail {
  /** Ordered steps from data collection to verdict. */
  steps: AuditStep[];
  /** Final verdict this trail produced. */
  verdict: string;
  /** Confidence in the verdict (0-1). */
  confidence: number;
  /** Unix seconds when the audit was generated. */
  generatedAt: number;
  /** Total risk score this trail produced. */
  riskScore: number;
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SEV_WEIGHT: Record<Severity, number> = { high: 0.4, medium: 0.2, low: 0.1 };

/**
 * Deterministic, human-first per-rule breakdown of the detected anomalies,
 * ordered high -> medium -> low, then most-recent first. This is the
 * "explainable" surface of the gate: a human or agent can read exactly which
 * rules fired and why, without parsing the full structured evidence.
 * Each anomaly now carries a normalized weight showing its contribution
 * to the overall risk score.
 */
export function anomalyReasons(anomalies: Anomaly[]): AnomalyReason[] {
  const totalWeight = anomalies.reduce((s, a) => s + SEV_WEIGHT[a.severity], 0) || 1;
  return [...anomalies]
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.timestamp - a.timestamp)
    .map((a) => ({
      rule: a.type,
      severity: a.severity,
      reason: a.text,
      timestamp: a.timestamp,
      weight: Math.round((SEV_WEIGHT[a.severity] / totalWeight) * 100) / 100,
    }));
}

/** Compact one-line summary of the rule breakdown for quick scanning. */
export function anomalySummary(anomalies: Anomaly[]): string {
  if (anomalies.length === 0) return "no anomalies in this window";
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const a of anomalies) counts[a.severity] += 1;
  const parts: string[] = [];
  for (const sev of ["high", "medium", "low"] as const) {
    if (counts[sev] > 0) parts.push(`${counts[sev]} ${sev}`);
  }
  return `${parts.join(", ")} anomalies detected`;
}

/**
 * Recency of the analyzed activity. A trust gate is only as good as the
 * freshness of the data behind it; this makes the age explicit so a caller
 * never mistakes a stale snapshot for a live read.
 */
export function buildFreshness(
  lastActivity: number | null,
  now: number,
  windowStart: number | null,
  windowEnd: number | null,
  staleAfterDays = 7,
): Freshness {
  const daysSinceLastActivity =
    lastActivity === null ? null : Math.max(0, Math.round((now - lastActivity) / 86_400));
  return {
    lastActivity,
    daysSinceLastActivity,
    windowStart,
    windowEnd,
    stale: lastActivity === null || (daysSinceLastActivity ?? 0) > staleAfterDays,
    staleAfterDays,
  };
}

/**
 * Build a full audit trail from the detected anomalies and final risk score.
 * This is the "machine-readable proof" of the verdict: every step from
 * raw signal to final decision is recorded, so any auditor (human or agent)
 * can replay the logic and verify the result.
 */
export function buildAuditTrail(
  anomalies: Anomaly[],
  riskScore: number,
  verdict: string,
  confidence: number,
  generatedAt: number,
): AuditTrail {
  const totalWeight = anomalies.reduce((s, a) => s + SEV_WEIGHT[a.severity], 0) || 1;
  const steps: AuditStep[] = anomalies.map((a) => ({
    rule: a.type,
    input: a.text,
    threshold: severityThreshold(a.severity),
    result: a.severity,
    weight: Math.round((SEV_WEIGHT[a.severity] / totalWeight) * 100) / 100,
    fired: true,
  }));

  return {
    steps,
    verdict,
    confidence,
    generatedAt,
    riskScore,
  };
}

function severityThreshold(sev: Severity): string {
  switch (sev) {
    case "high": return "exceeds high-severity threshold";
    case "medium": return "exceeds medium-severity threshold";
    case "low": return "exceeds low-severity threshold";
  }
}
