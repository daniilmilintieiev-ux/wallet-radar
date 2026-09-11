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
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Deterministic, human-first per-rule breakdown of the detected anomalies,
 * ordered high -> medium -> low, then most-recent first. This is the
 * "explainable" surface of the gate: a human or agent can read exactly which
 * rules fired and why, without parsing the full structured evidence.
 */
export function anomalyReasons(anomalies: Anomaly[]): AnomalyReason[] {
  return [...anomalies]
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.timestamp - a.timestamp)
    .map((a) => ({ rule: a.type, severity: a.severity, reason: a.text, timestamp: a.timestamp }));
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
