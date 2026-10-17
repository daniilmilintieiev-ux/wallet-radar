#!/usr/bin/env node
/**
 * Independent recomputation of pilot scoring for INC-2022-08-SLOPE.
 * Written strictly from the specification text in SCORING-SPEC-PILOT.md (Amendment 1)
 * using radar-submitted/dist exports, without copying pilot_score.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.resolve(process.cwd(), "..", "radar-submitted", "dist", "src");
const trustModule = await import(pathToFileURL(path.join(distDir, "trust.js")).href);
const baselineModule = await import(pathToFileURL(path.join(distDir, "baseline.js")).href);
const analyzerModule = await import(pathToFileURL(path.join(distDir, "analyzer.js")).href);
const typesModule = await import(pathToFileURL(path.join(distDir, "types.js")).href);

const { selectScoring } = trustModule;
const { updateBaseline } = baselineModule;
const { detectAnomalies, computeRiskScore } = analyzerModule;
const { loadConfig } = typesModule;

const pilotDataDir = "C:\\Users\\cbell\\Documents\\antigravity\\analysis-data\\pilot";
const casesCsvPath = path.resolve(process.cwd(), "docs", "next", "cases", "cases.csv");
const resultMdPath = path.resolve(process.cwd(), "docs", "next", "cases", "PILOT-RESULT-INC-2022-08-SLOPE.md");

const DAY = 86_400;

function loadCases() {
  const lines = fs.readFileSync(casesCsvPath, "utf8").trim().split("\n");
  const cases = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols[0].startsWith("C-001-")) {
      cases.push({
        case_id: cols[0],
        wallet: cols[4],
        t0_signature: cols[5],
        t0_utc: cols[6],
        t0_unix: Math.floor(Date.parse(cols[6]) / 1000),
      });
    }
  }
  return cases;
}

export function recomputeAll() {
  console.log("=== INDEPENDENT PILOT RECOMPUTATION ===");
  const cases = loadCases();
  const recomputedResults = [];

  for (const c of cases) {
    const jsonPath = path.join(pilotDataDir, `${c.case_id}.json`);
    const history = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    const caseRes = {
      case_id: c.case_id,
      wallet: c.wallet,
      t0_unix: c.t0_unix,
    };

    // Checkpoint T_a: timestamp <= t0
    {
      const Ta = c.t0_unix;
      const historyTa = history.filter((t) => (t.timestamp ?? 0) <= Ta);
      const windowStartTa = Ta - 7 * DAY;
      const priorCountTa = historyTa.filter((t) => (t.timestamp ?? 0) < windowStartTa).length;
      const modeTa = priorCountTa >= 3 ? "windowed" : "snapshot";

      const { baselineTxs, evalTxs } = selectScoring(historyTa, windowStartTa);
      const baseline = updateBaseline(c.wallet, null, baselineTxs, Ta, null);
      const anomalies = detectAnomalies(
        c.wallet,
        evalTxs,
        baseline,
        { ...loadConfig(), dormantMeasure: "first" },
        null,
        null
      );
      const riskScore = computeRiskScore(anomalies);
      const flagged = riskScore > 30 ? "yes" : "no";

      caseRes.Ta = {
        T: Ta,
        txCount: historyTa.length,
        priorCount: priorCountTa,
        evalCount: evalTxs.length,
        baselineCount: baselineTxs.length,
        mode: modeTa,
        anomalies,
        riskScore,
        flagged,
      };
    }

    // Checkpoint T_b: timestamp < t0 - 300s
    {
      const Tb = c.t0_unix - 300;
      const historyTb = history.filter((t) => (t.timestamp ?? 0) < Tb);
      const windowStartTb = Tb - 7 * DAY;
      const priorCountTb = historyTb.filter((t) => (t.timestamp ?? 0) < windowStartTb).length;
      const modeTb = priorCountTb >= 3 ? "windowed" : "snapshot";

      const { baselineTxs, evalTxs } = selectScoring(historyTb, windowStartTb);
      const baseline = updateBaseline(c.wallet, null, baselineTxs, Tb, null);
      const anomalies = detectAnomalies(
        c.wallet,
        evalTxs,
        baseline,
        { ...loadConfig(), dormantMeasure: "first" },
        null,
        null
      );
      const riskScore = computeRiskScore(anomalies);
      const flagged = riskScore > 30 ? "yes" : "no";

      caseRes.Tb = {
        T: Tb,
        txCount: historyTb.length,
        priorCount: priorCountTb,
        evalCount: evalTxs.length,
        baselineCount: baselineTxs.length,
        mode: modeTb,
        anomalies,
        riskScore,
        flagged,
      };
    }

    recomputedResults.push(caseRes);
  }

  // Compare with published PILOT-RESULT-INC-2022-08-SLOPE.md
  console.log("\nRecomputed Results Summary:");
  console.log("| Case ID | Mode (Ta / Tb) | Flagged Ta (Score) | Flagged Tb (Score) | Anomalies Ta | Anomalies Tb |");
  console.log("|:--------|:---------------|:-------------------|:-------------------|:-------------|:-------------|");
  for (const r of recomputedResults) {
    console.log(`| ${r.case_id} | ${r.Ta.mode} / ${r.Tb.mode} | ${r.Ta.flagged} (${r.Ta.riskScore}) | ${r.Tb.flagged} (${r.Tb.riskScore}) | ${r.Ta.anomalies.map(a => a.type).join(", ") || "none"} | ${r.Tb.anomalies.map(a => a.type).join(", ") || "none"} |`);
  }

  // Parse published results from markdown file
  const mdContent = fs.readFileSync(resultMdPath, "utf8");
  const discrepancies = [];

  // Published values to check:
  // C-001-1: mode "windowed / snapshot", Ta "no (20)", Tb "no (0)"
  // C-001-2: mode "windowed / windowed", Ta "yes (50)", Tb "yes (50)"
  // C-001-3: mode "windowed / snapshot", Ta "no (20)", Tb "no (0)"
  // C-001-4: mode "windowed / snapshot", Ta "yes (35)", Tb "no (0)"
  // C-001-5: mode "windowed / windowed", Ta "no (5)", Tb "no (15)"

  console.log("\n--- DISCREPANCY ANALYSIS AGAINST PUBLISHED TABLE ---");
  for (const r of recomputedResults) {
    // Check mode
    const expectedModeStr = `${r.Ta.mode} / ${r.Tb.mode}`;
    // Find table row in markdown
    const tableLine = mdContent.split("\n").find((l) => l.includes(`| ${r.case_id} |`));
    if (!tableLine) {
      discrepancies.push(`Missing case ${r.case_id} in published table`);
      continue;
    }
    const cols = tableLine.split("|").map((c) => c.trim()).filter(Boolean);
    // cols: [case_id, wallet, depth, mode, flaggedTa, flaggedTb, sha256]
    const publishedMode = cols[3];
    const publishedTa = cols[4];
    const publishedTb = cols[5];

    if (publishedMode !== expectedModeStr) {
      discrepancies.push({
        case_id: r.case_id,
        field: "mode",
        published: publishedMode,
        recomputed: expectedModeStr,
        explanation: `In pilot_score.mjs line 54, baselineMode was checked as (baselineTxs.length !== txs.length). At Tb, recentTxs.length == 0 so baselineTxs.length == txs.length, which erroneously labeled the mode as 'snapshot' instead of 'windowed', even though selectScoring executed the windowed branch (priorCount >= 3).`
      });
    }

    const expectedTa = `**${r.Ta.flagged}** (${r.Ta.riskScore})`;
    if (publishedTa !== expectedTa) {
      discrepancies.push({
        case_id: r.case_id,
        field: "scoreA",
        published: publishedTa,
        recomputed: expectedTa
      });
    }

    const expectedTb = `**${r.Tb.flagged}** (${r.Tb.riskScore})`;
    if (publishedTb !== expectedTb) {
      discrepancies.push({
        case_id: r.case_id,
        field: "scoreB",
        published: publishedTb,
        recomputed: expectedTb
      });
    }
  }

  if (discrepancies.length === 0) {
    console.log("No discrepancies found between recomputation and published results.");
  } else {
    console.log(`Found ${discrepancies.length} discrepancies:`);
    for (const d of discrepancies) {
      console.log(`  Case ${d.case_id} - ${d.field}: published '${d.published}' vs recomputed '${d.recomputed}'`);
      if (d.explanation) console.log(`    -> ${d.explanation}`);
    }
  }

  return { recomputedResults, discrepancies };
}

if (process.argv[1] && process.argv[1].endsWith("pilot_recompute.mjs")) {
  recomputeAll();
}
