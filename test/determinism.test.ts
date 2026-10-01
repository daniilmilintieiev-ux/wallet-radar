import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, computeRiskScore } from "../src/analyzer.js";
import { updateBaseline } from "../src/baseline.js";
import { isExistentialThreat } from "../src/defense.js";
import { selectScoring, TRUST_DEFAULTS } from "../src/trust.js";
import { BLUECHIP_FALLBACK_PRICES } from "../src/pricing.js";
import { EnhancedTx, DEFAULT_CONFIG } from "../src/types.js";

// B9: for every wallet in benchmarks/history-cache, the walk-forward and
// trust paths must produce byte-for-byte identical verdict/riskScore/anomaly
// results across 5 repeated runs on the same cached input (excluding any
// generation-timestamp field). benchmarks/ is gitignored (CLAUDE.md), so
// this test skips gracefully when it isn't present in a given checkout,
// matching the project's own "НЕ ПРОВЕРЕНО (нет кэша)" convention, and runs
// a smaller synthetic-fixture check unconditionally so this file still
// asserts something in every environment.

function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

function runTrustPathOnce(address: string, sortedTxs: EnhancedTx[], prices: Record<string, number>) {
  if (sortedTxs.length === 0) return { riskScore: 0, anomalyTypes: [] as string[] };
  const stamps = sortedTxs.map((t) => t.timestamp).filter((n) => typeof n === "number");
  const generatedAt = (stamps.length > 0 ? Math.max(...stamps) : 0) + 1;
  const windowStart = generatedAt - TRUST_DEFAULTS.windowDays * 86_400;
  const { baselineTxs, evalTxs } = selectScoring(sortedTxs, windowStart);
  const baseline = updateBaseline(address, null, baselineTxs, generatedAt, prices);
  const anomalies = detectAnomalies(address, evalTxs, baseline, { ...DEFAULT_CONFIG, dormantMeasure: "first" }, prices);
  const riskScore = computeRiskScore(anomalies);
  const hasHigh = anomalies.some(isExistentialThreat);
  let verdict: string;
  if (hasHigh || riskScore > 70) verdict = "BLOCKED";
  else if (riskScore > 30 || evalTxs.length === 0) verdict = "LOW_TRUST_WARMING";
  else verdict = "VERIFIED_SAFE";
  const anomalyTypes = anomalies.map((a) => `${a.type}(${a.severity})`).sort();
  return { verdict, riskScore, anomalyTypes };
}

test("B9: walk-forward and trust paths are deterministic across 5 repeated runs (benchmarks/history-cache, if present)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const historyCacheDir = path.resolve(process.cwd(), "benchmarks/history-cache");
  const mintCachePath = path.resolve(process.cwd(), "benchmarks/mint-cache.json");
  if (!fs.existsSync(historyCacheDir) || !fs.existsSync(mintCachePath)) {
    console.log("SKIP (НЕ ПРОВЕРЕНО): benchmarks/ not present in this checkout (gitignored).");
    return;
  }
  // @ts-ignore -- plain .mjs helper with no type declarations, resolved at
  // runtime relative to the compiled dist/test/ location (two levels up to
  // repo root), not the source test/ location.
  const { loadCachedTxs, replayWalkForward } = (await import("../../scripts/audit/lib/walk-forward-replay.mjs")) as any;
  const mintCache = JSON.parse(fs.readFileSync(mintCachePath, "utf8"));
  const prices = { ...BLUECHIP_FALLBACK_PRICES };

  const files = fs.readdirSync(historyCacheDir).filter((f: string) => f.endsWith(".json")).slice(0, 50);
  let checked = 0;
  let wfMismatches = 0;
  let trustMismatches = 0;
  const mismatchDetails: Array<{ address: string; path: string }> = [];

  for (const file of files) {
    const address = file.replace(/\.json$/, "");
    const sortedTxs = loadCachedTxs(historyCacheDir, address);
    if (!sortedTxs) continue;
    checked++;

    const wfRuns = Array.from({ length: 5 }, () => {
      const res = replayWalkForward(address, undefined, sortedTxs, prices, mintCache);
      return stableStringify({ verdict: res.finalVerdict, riskScore: res.finalRiskScore, blockedAtStep: res.blockedAtStep });
    });
    const trustRuns = Array.from({ length: 5 }, () => stableStringify(runTrustPathOnce(address, sortedTxs, prices)));
    if (!wfRuns.every((r) => r === wfRuns[0])) {
      wfMismatches++;
      mismatchDetails.push({ address, path: "walk-forward" });
    }
    if (!trustRuns.every((r) => r === trustRuns[0])) {
      trustMismatches++;
      mismatchDetails.push({ address, path: "trust" });
    }
  }

  console.log(`B9: checked ${checked} wallets, walk-forward mismatches: ${wfMismatches}, trust mismatches: ${trustMismatches}`);
  assert.deepEqual(mismatchDetails, [], `determinism mismatches found: ${JSON.stringify(mismatchDetails)}`);
});

test("B9: synthetic fixture determinism (runs unconditionally, no benchmarks/ dependency)", () => {
  const WALLET = "DemoWallet11111111111111111111111111111111";
  const txs: EnhancedTx[] = Array.from({ length: 12 }, (_, i) => ({
    signature: `sig_${i}`,
    timestamp: 1_700_000_000 + i * 3600,
    source: "JUPITER",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
  }));
  const baseline = updateBaseline(WALLET, null, txs.slice(0, 6), txs[5].timestamp!, {});

  const runs = Array.from({ length: 5 }, () => {
    const anomalies = detectAnomalies(WALLET, txs.slice(6), baseline, undefined, {});
    return stableStringify({ riskScore: computeRiskScore(anomalies), types: anomalies.map((a) => a.type).sort() });
  });
  assert.ok(runs.every((r) => r === runs[0]), `expected all 5 runs identical, got: ${JSON.stringify(runs)}`);
});
