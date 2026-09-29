// Shared walk-forward replay core for stage 5A (see CLAUDE.md).
//
// Faithful reimplementation of scripts/history-machine.ts's replayWalletHistory
// walk-forward loop, using ONLY primitives imported from dist/src/* (never
// touches scripts/history-machine.ts or src/ itself), parameterized by
// `useMintRisk` so it can be run twice -- once matching history-machine.ts's
// real behavior (mintRisk from benchmarks/mint-cache.json) as a fidelity
// check, once with mintRisk forced to null as the stage-5A "same window,
// no mintRisk" control.
//
// Read-only, offline: uses only benchmarks/history-cache/*.json and
// benchmarks/mint-cache.json already on disk. No network calls.

import fs from "node:fs";
import path from "node:path";
import { detectAnomalies, computeRiskScore } from "../../../dist/src/analyzer.js";
import { updateBaseline } from "../../../dist/src/baseline.js";
import { computeDefenseAction, isExistentialThreat, DEFENSE_THRESHOLDS } from "../../../dist/src/defense.js";
import { DEFAULT_CONFIG } from "../../../dist/src/types.js";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/**
 * @param {string} address
 * @param {string} category
 * @param {object[]} sortedTxs ascending by timestamp
 * @param {Record<string, number>} prices
 * @param {object|null} mintRisk pass null to disable TOXIC_MINT entirely
 */
export function replayWalkForward(address, category, sortedTxs, prices, mintRisk) {
  if (sortedTxs.length === 0) {
    return {
      finalVerdict: "LOW_TRUST_WARMING",
      finalRiskScore: 0,
      totalTxs: 0,
      blockedAtStep: null,
    };
  }

  let baseline = null;
  let defInfo = null;
  let stance = sortedTxs.length < 5 || category === "rare_low_history" ? "LOW_TRUST_WARMING" : "VERIFIED_SAFE";
  let blockedAtStep = null;
  let currentRiskScore = 0;

  for (let i = 0; i < sortedTxs.length; i++) {
    const currentTx = sortedTxs[i];
    const evalTxs = [currentTx];
    const nowSec = currentTx.timestamp ?? 0;

    if (i > 0) {
      const prevTx = sortedTxs[i - 1];
      const prevTs = prevTx.timestamp ?? nowSec;
      baseline = updateBaseline(address, baseline, [prevTx], prevTs, prices);
    }

    const anomalies = detectAnomalies(address, evalTxs, baseline, DEFAULT_CONFIG, prices, mintRisk);
    currentRiskScore = computeRiskScore(anomalies);
    const hasHigh = anomalies.some(isExistentialThreat);
    const isClean = !hasHigh && currentRiskScore < DEFENSE_THRESHOLDS.alerting;
    const prevClean = defInfo?.cleanStreak ?? 0;
    const currentClean = isClean ? prevClean + 1 : 0;

    const action = computeDefenseAction({
      riskScore: currentRiskScore,
      hasHighSeverity: hasHigh,
      active: true,
      current: defInfo,
      quietStreak: 0,
      nowSec,
      cleanStreak: currentClean,
    });

    const prevSetAt = defInfo ? defInfo.setAt : nowSec;
    const prevActions = defInfo ? defInfo.actions : 0;
    defInfo = {
      state: action.state,
      riskAt: currentRiskScore,
      setAt: action.changed ? nowSec : prevSetAt,
      quietStreak: 0,
      actions: prevActions + (action.changed ? 1 : 0),
      cleanStreak: action.changed ? 0 : currentClean,
    };

    if (action.state === "blocked" && !blockedAtStep) {
      blockedAtStep = i + 1;
    }

    let currentStepStance;
    if (defInfo.state === "blocked") currentStepStance = "BLOCKED";
    else if (defInfo.state === "gated" || defInfo.state === "alerting" || i < 4 || category === "rare_low_history") currentStepStance = "LOW_TRUST_WARMING";
    else currentStepStance = "VERIFIED_SAFE";
    stance = currentStepStance;
  }

  let finalVerdict;
  if (category === "scam_exploit" || category === "rekt_drawdown") {
    finalVerdict = blockedAtStep !== null ? "BLOCKED" : stance;
  } else if (category === "rare_low_history" || sortedTxs.length < 5) {
    finalVerdict = "LOW_TRUST_WARMING";
  } else {
    finalVerdict = stance;
  }

  return { finalVerdict, finalRiskScore: currentRiskScore, totalTxs: sortedTxs.length, blockedAtStep };
}

export function loadCachedTxs(historyCacheDir, address) {
  const cacheFile = path.join(historyCacheDir, `${address}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  const raw = readJson(cacheFile);
  if (!Array.isArray(raw)) return null;
  return [...raw].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
