#!/usr/bin/env node
// Stage 4C -- Experiment #2 (separate numbered experiment, see CLAUDE.md rule 4:
// any change to methodology is a new experiment; results of exp1 and the
// stage-3 replay are NOT touched or overwritten by this).
//
// THIS IS NOT AN ACCURACY MEASUREMENT. It measures how sensitive the two
// existing code paths' OUTPUTS are to mintRisk being present or absent, on
// the SAME already-cached (stale, frozen at fetch time) transaction data.
// It says nothing about whether either path is "right" for a given wallet.
//
// Path A ("trust.ts style"): mirrors src/trust.ts:317-330 exactly --
// selectScoring(txs, windowStart) with TRUST_DEFAULTS.windowDays=7,
// updateBaseline on baselineTxs, ONE detectAnomalies call on evalTxs with
// NO mintRisk (trust.ts structurally never has it -- see stage-3 report 3A).
// Since this replay has no live "now", windowStart is anchored to the
// wallet's OWN latest cached transaction timestamp, not wall-clock time
// (using real wall-clock "now" against data cached weeks ago would put
// every wallet's cached history outside the 7-day window and make every
// riskScore trivially 0 -- that would be an artifact of stale data, not a
// measurement of anything).
//
// Path B ("history-machine style, with mintRisk"): taken directly from the
// EXISTING benchmarks/simulation-results.json (finalRiskScore/finalVerdict)
// -- not recomputed, per CLAUDE.md rule "don't refit, reuse existing results".
//
// No network calls. No src/ changes. Imports runtime code from dist/ only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectScoring, TRUST_DEFAULTS } from "../../dist/src/trust.js";
import { updateBaseline } from "../../dist/src/baseline.js";
import { detectAnomalies, computeRiskScore } from "../../dist/src/analyzer.js";
import { BLUECHIP_FALLBACK_PRICES } from "../../dist/src/pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// Fixed-seed deterministic PRNG (mulberry32) -- reproducible sampling, no Math.random.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260929; // documented, fixed: today's date as YYYYMMDD -- reproducible, not cherry-picked post-hoc.
const SAMPLE_SIZE = 100;

const simPath = path.join(ROOT, "benchmarks/simulation-results.json");
const priceCachePath = path.join(ROOT, "benchmarks/price-cache.json");
const historyCacheDir = path.join(ROOT, "benchmarks/history-cache");

const sim = readJson(simPath);
const prices = { ...BLUECHIP_FALLBACK_PRICES, ...(fs.existsSync(priceCachePath) ? readJson(priceCachePath) : {}) };

const blocked = sim.results.filter((r) => r.finalVerdict === "BLOCKED");
const nonBlocked = sim.results.filter((r) => r.finalVerdict !== "BLOCKED");

const rand = mulberry32(SEED);
const shuffled = [...nonBlocked];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const sampledNonBlocked = shuffled.slice(0, SAMPLE_SIZE);

function runTrustPathNoMintRisk(address) {
  const cacheFile = path.join(historyCacheDir, `${address}.json`);
  if (!fs.existsSync(cacheFile)) return { available: false };
  const rawTxs = readJson(cacheFile);
  if (!Array.isArray(rawTxs) || rawTxs.length === 0) return { available: true, txCount: 0, riskScore: 0, anomalyTypes: [] };
  const sortedTxs = [...rawTxs].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const stamps = sortedTxs.map((t) => t.timestamp).filter((n) => typeof n === "number");
  const generatedAt = (stamps.length > 0 ? Math.max(...stamps) : 0) + 1; // anchor "now" to this wallet's own latest cached activity
  const windowStart = generatedAt - TRUST_DEFAULTS.windowDays * 86_400;

  const { baselineTxs, evalTxs } = selectScoring(sortedTxs, windowStart);
  const baseline = updateBaseline(address, null, baselineTxs, generatedAt, prices);
  const anomalies = detectAnomalies(address, evalTxs, baseline, undefined, prices); // NO mintRisk -- mirrors trust.ts:329
  const riskScore = computeRiskScore(anomalies);
  return {
    available: true,
    txCount: sortedTxs.length,
    evalTxCount: evalTxs.length,
    riskScore,
    anomalyTypes: anomalies.map((a) => `${a.type}(${a.severity})`),
  };
}

function classify(label, records) {
  const rows = [];
  let differentVerdict = 0;
  let unavailable = 0;
  for (const r of records) {
    const a = runTrustPathNoMintRisk(r.address);
    if (!a.available) {
      unavailable++;
      rows.push({ address: r.address, pathB_verdict: r.finalVerdict, pathB_risk: r.finalRiskScore, pathA: "НЕ ПРОВЕРЕНО (нет кэша истории)" });
      continue;
    }
    // "Different verdict" defined as: path B is BLOCKED (risk >= 70 or high-severity anomaly,
    // via defense.ts) but path A's risk stays under TRUST_DEFAULTS.maxRisk (30) -- i.e. trust.ts's
    // own methodology, lacking mintRisk, would not have raised the same alarm.
    const pathA_wouldFlag = a.riskScore > TRUST_DEFAULTS.maxRisk;
    const pathB_blocked = r.finalVerdict === "BLOCKED";
    const verdictDiffers = pathB_blocked !== pathA_wouldFlag;
    if (verdictDiffers) differentVerdict++;
    rows.push({
      address: r.address,
      pathB_verdict: r.finalVerdict,
      pathB_risk: r.finalRiskScore,
      pathA_risk: a.riskScore,
      pathA_evalTxCount: a.evalTxCount,
      pathA_anomalies: a.anomalyTypes,
      pathA_wouldFlag,
      verdictDiffers,
    });
  }
  return { label, rows, differentVerdict, unavailable, total: records.length };
}

const resultsBlocked = classify("58 BLOCKED (per benchmark)", blocked);
const resultsSample = classify(`${SAMPLE_SIZE} random non-BLOCKED (seed=${SEED})`, sampledNonBlocked);

console.log("=== DISCLAIMER ===");
console.log("This is NOT an accuracy measurement. It measures how the two code paths'");
console.log("outputs differ given the SAME frozen cached data, isolating mintRisk as one");
console.log("(not necessarily the only) factor. See file header for full caveat.\n");

for (const res of [resultsBlocked, resultsSample]) {
  console.log(`--- ${res.label} ---`);
  console.log(`Total: ${res.total} | history-cache unavailable: ${res.unavailable} | verdict differs (path A vs path B): ${res.differentVerdict}`);
}

console.log("\naddress,group,pathB_verdict,pathB_risk,pathA_risk,pathA_evalTxCount,pathA_wouldFlag,verdictDiffers,pathA_anomalies");
for (const [group, res] of [["blocked58", resultsBlocked], ["sampleNonBlocked100", resultsSample]]) {
  for (const r of res.rows) {
    if (r.pathA === undefined) {
      console.log([r.address, group, r.pathB_verdict, r.pathB_risk, r.pathA_risk, r.pathA_evalTxCount, r.pathA_wouldFlag, r.verdictDiffers, JSON.stringify(r.pathA_anomalies)].join(","));
    } else {
      console.log([r.address, group, r.pathB_verdict, r.pathB_risk, "НЕ ПРОВЕРЕНО", "", "", "", ""].join(","));
    }
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Of the 58 BLOCKED (benchmark/history-machine path, WITH mintRisk): ${resultsBlocked.differentVerdict} of ${resultsBlocked.total - resultsBlocked.unavailable} evaluable would NOT be flagged (risk <= ${TRUST_DEFAULTS.maxRisk}) by trust.ts's own methodology (WITHOUT mintRisk, on the same cached data).`);
console.log(`Of the ${SAMPLE_SIZE} sampled non-BLOCKED wallets: ${resultsSample.differentVerdict} of ${resultsSample.total - resultsSample.unavailable} evaluable show a different flag status between the two paths.`);
