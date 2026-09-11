import test from "node:test";
import assert from "node:assert/strict";
import { anomalyReasons, anomalySummary, buildFreshness } from "../src/explain.js";
import type { Anomaly, AnomalyType, Severity } from "../src/types.js";

function mk(type: AnomalyType, severity: Severity, text: string, timestamp: number): Anomaly {
  return { type, wallet: "W", severity, timestamp, evidence: {}, text };
}

test("anomalyReasons: orders high->medium->low then most-recent first", () => {
  const anomalies: Anomaly[] = [
    mk("LARGE_SWAP", "low", "low reason", 1_700_000_300),
    mk("NEW_VENUE", "medium", "medium reason", 1_700_000_100),
    mk("TOXIC_MINT", "high", "high reason", 1_700_000_200),
    mk("DORMANT_ACTIVE", "high", "high reason 2", 1_700_000_050),
  ];
  const reasons = anomalyReasons(anomalies);
  assert.deepEqual(
    reasons.map((r) => r.rule),
    ["TOXIC_MINT", "DORMANT_ACTIVE", "NEW_VENUE", "LARGE_SWAP"],
  );
  assert.equal(reasons[0].reason, "high reason");
  assert.equal(reasons[0].severity, "high");
  assert.equal(typeof reasons[0].timestamp, "number");
});

test("anomalyReasons: empty input -> empty output", () => {
  assert.deepEqual(anomalyReasons([]), []);
});

test("anomalySummary: empty -> friendly message", () => {
  assert.equal(anomalySummary([]), "no anomalies in this window");
});

test("anomalySummary: counts by severity, skips zero buckets", () => {
  const anomalies: Anomaly[] = [
    mk("TOXIC_MINT", "high", "a", 1),
    mk("LARGE_SWAP", "high", "b", 2),
    mk("NEW_VENUE", "medium", "c", 3),
  ];
  assert.equal(anomalySummary(anomalies), "2 high, 1 medium anomalies detected");
});

test("buildFreshness: fresh activity within threshold", () => {
  const now = 1_700_000_000;
  const f = buildFreshness(now - 3600, now, now - 86_400, now);
  assert.equal(f.lastActivity, now - 3600);
  assert.equal(f.daysSinceLastActivity, 0);
  assert.equal(f.stale, false);
  assert.equal(f.windowStart, now - 86_400);
  assert.equal(f.windowEnd, now);
  assert.equal(f.staleAfterDays, 7);
});

test("buildFreshness: stale when last activity older than threshold", () => {
  const now = 1_700_000_000;
  const f = buildFreshness(now - 30 * 86_400, now, null, now, 7);
  assert.equal(f.daysSinceLastActivity, 30);
  assert.equal(f.stale, true);
});

test("buildFreshness: no activity -> stale with nulls", () => {
  const now = 1_700_000_000;
  const f = buildFreshness(null, now, null, null);
  assert.equal(f.lastActivity, null);
  assert.equal(f.daysSinceLastActivity, null);
  assert.equal(f.stale, true);
});
