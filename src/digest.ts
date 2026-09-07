import { Anomaly } from "./types.js";

/**
 * Turn a batch of anomalies into a single human-readable paragraph.
 * v1: deterministic template (no LLM needed, works offline).
 * v2 (optional): one LLM call per batch for a natural-language summary.
 */
export function digestAnomalies(anomalies: Anomaly[]): string {
  if (anomalies.length === 0) {
    return "No notable activity in this window.";
  }
  const bySeverity: Record<string, Anomaly[]> = { high: [], medium: [], low: [] };
  for (const a of anomalies) (bySeverity[a.severity] ?? bySeverity.low).push(a);

  const parts: string[] = [];
  for (const sev of ["high", "medium", "low"] as const) {
    const list = bySeverity[sev];
    if (list.length > 0) {
      parts.push(list.map((a) => a.text).join(" "));
    }
  }
  return parts.join(" ");
}
