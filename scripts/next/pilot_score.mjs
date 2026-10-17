#!/usr/bin/env node
/**
 * Pilot Scoring Engine for INC-2022-08-SLOPE.
 * Evaluates a wallet's behavioral risk at check time T using the submitted build
 * (radar-submitted/dist).
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// Load modules from radar-submitted/dist
const submittedDist = resolve(process.cwd(), "..", "radar-submitted", "dist", "src");

const trustMod = await import(pathToFileURL(resolve(submittedDist, "trust.js")).href);
const baselineMod = await import(pathToFileURL(resolve(submittedDist, "baseline.js")).href);
const analyzerMod = await import(pathToFileURL(resolve(submittedDist, "analyzer.js")).href);
const typesMod = await import(pathToFileURL(resolve(submittedDist, "types.js")).href);

export const { selectScoring, runTrustCheck, SYSTEM_PROGRAM } = trustMod;
export const { updateBaseline } = baselineMod;
export const { detectAnomalies, computeRiskScore } = analyzerMod;
export const { loadConfig, DEFAULT_CONFIG } = typesMod;

/**
 * Score wallet behavioral anomalies and riskScore at check time T.
 *
 * @param {string} wallet Solana base58 address
 * @param {Array} txs Array of EnhancedTx objects
 * @param {number} T Evaluation timestamp in unix seconds
 * @returns {object} { riskScore, anomalies, baselineMode, evalTxCount, baselineTxCount }
 */
export function scoreAt(wallet, txs, T) {
  const windowDays = 7;
  const windowStart = T - windowDays * 86_400;

  // Split into baseline and evaluation sets per selectScoring
  const { baselineTxs, evalTxs } = selectScoring(txs, windowStart);

  // Learn baseline from baselineTxs at evaluation time T (prices = null)
  const baseline = updateBaseline(wallet, null, baselineTxs, T, null);

  // Detect anomalies with dormantMeasure: 'first' (trust path rule)
  const anomalies = detectAnomalies(
    wallet,
    evalTxs,
    baseline,
    { ...loadConfig(), dormantMeasure: "first" },
    null,
    null
  );

  const riskScore = computeRiskScore(anomalies);
  const baselineMode = baselineTxs.length !== txs.length ? "windowed" : "snapshot";

  return {
    riskScore,
    anomalies,
    baselineMode,
    evalTxCount: evalTxs.length,
    baselineTxCount: baselineTxs.length,
  };
}

if (process.argv.includes("--equivalence")) {
  const equivScript = resolve(dirname(fileURLToPath(import.meta.url)), "pilot_equivalence.mjs");
  const res = spawnSync(process.execPath, [equivScript], { stdio: "inherit" });
  process.exit(res.status ?? 0);
}
