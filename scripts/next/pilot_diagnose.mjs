#!/usr/bin/env node
/**
 * Diagnostic analysis of pilot history files for INC-2022-08-SLOPE.
 * Evaluates timestamp distributions, slicing windows, baseline mode definitions,
 * and fetch stop reasons.
 */

import fs from "node:fs";
import path from "node:path";

const pilotDir = "C:\\Users\\cbell\\Documents\\antigravity\\analysis-data\\pilot";
const csvPath = path.resolve(process.cwd(), "docs", "next", "cases", "cases.csv");

const DAY = 86_400;

function parseCasesCsv() {
  const content = fs.readFileSync(csvPath, "utf8");
  const lines = content.trim().split("\n");
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

export function runDiagnostics() {
  const cases = parseCasesCsv();
  console.log("================================================================================");
  console.log("PILOT HISTORY & WINDOWING DIAGNOSTIC REPORT (STAGE N7)");
  console.log("================================================================================\n");

  const caseDiagnostics = [];

  for (const c of cases) {
    const jsonPath = path.join(pilotDir, `${c.case_id}.json`);
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const stamps = raw.map((t) => t.timestamp).filter(Number.isFinite).sort((a, b) => a - b);
    const earliest = stamps[0];
    const latest = stamps[stamps.length - 1];

    // (а) Total txs, earliest, latest
    const totalTxsInFile = raw.length;
    const earliestUtc = new Date(earliest * 1000).toISOString();
    const latestUtc = new Date(latest * 1000).toISOString();

    // (д) Depth and stop reason
    const depthDays = ((c.t0_unix - earliest) / DAY).toFixed(2);
    let stopReason = "";
    if (totalTxsInFile >= 1000) {
      stopReason = "limit_1000_txs_reached";
    } else if (earliest < c.t0_unix - 90 * DAY) {
      stopReason = "limit_90_days_reached (earliest tx older than t0 - 90d)";
    } else {
      stopReason = "history_exhausted (on-chain genesis/creation reached, < 1000 txs and < 90d)";
    }

    // (г) Txs in [T_b - 7d, T_a - 7d)
    const winStartTb = (c.t0_unix - 300) - 7 * DAY;
    const winStartTa = c.t0_unix - 7 * DAY;
    const txsIn300sBoundary = raw.filter((t) => t.timestamp >= winStartTb && t.timestamp < winStartTa);

    const checkTimes = {};
    for (const label of ["T_a", "T_b"]) {
      const T = label === "T_a" ? c.t0_unix : c.t0_unix - 300;
      const windowStart = T - 7 * DAY;

      // (б) Rule Amendment 1
      const txs = label === "T_a"
        ? raw.filter((t) => (t.timestamp ?? 0) <= c.t0_unix)
        : raw.filter((t) => (t.timestamp ?? 0) < c.t0_unix - 300);

      // (в) prior and recent
      const prior = txs.filter((t) => (t.timestamp ?? 0) < windowStart);
      const recent = txs.filter((t) => (t.timestamp ?? 0) >= windowStart);
      const modeBySelectScoringRule = prior.length >= 3 ? "windowed" : "snapshot";

      // What did pilot_score.mjs do?
      // In pilot_score.mjs line 54:
      // const baselineMode = baselineTxs.length !== txs.length ? "windowed" : "snapshot";
      // When recent is empty, baselineTxs == prior == txs, so baselineTxs.length === txs.length -> "snapshot"!
      const modeComputedByLine54 = (recent.length > 0 && prior.length >= 3) ? "windowed" : "snapshot";

      checkTimes[label] = {
        T,
        T_utc: new Date(T * 1000).toISOString(),
        txCount: txs.length,
        priorCount: prior.length,
        recentCount: recent.length,
        modeBySelectScoringRule,
        modeComputedByLine54,
      };
    }

    caseDiagnostics.push({
      case_id: c.case_id,
      wallet: c.wallet,
      totalTxsInFile,
      earliestUtc,
      latestUtc,
      depthDays,
      stopReason,
      txsIn300sBoundary: txsIn300sBoundary.length,
      checkTimes,
    });
  }

  // Print formatted tables
  console.log("TABLE 1: PER-CASE HISTORY OVERVIEW & STOP REASONS");
  console.log("--------------------------------------------------------------------------------");
  for (const d of caseDiagnostics) {
    console.log(`Case: ${d.case_id} (${d.wallet})`);
    console.log(`  Total txs in file: ${d.totalTxsInFile}`);
    console.log(`  Earliest tx UTC:   ${d.earliestUtc}`);
    console.log(`  Latest tx UTC:     ${d.latestUtc}`);
    console.log(`  Depth reached:     ${d.depthDays} days before t0`);
    console.log(`  Fetch stop reason: ${d.stopReason}`);
    console.log(`  Txs in [Tb - 7d, Ta - 7d): ${d.txsIn300sBoundary} txs`);
    console.log();
  }

  console.log("\nTABLE 2: WINDOWING SLICES AT T_a AND T_b");
  console.log("--------------------------------------------------------------------------------");
  console.log("| Case ID | Checkpoint | Total txs | Prior (< T-7d) | Recent (>= T-7d) | selectScoring Mode | pilot_score.mjs Mode |");
  console.log("|:--------|:-----------|:----------|:---------------|:-----------------|:-------------------|:---------------------|");
  for (const d of caseDiagnostics) {
    for (const cp of ["T_a", "T_b"]) {
      const ct = d.checkTimes[cp];
      console.log(`| ${d.case_id} | ${cp} (${ct.T_utc.slice(11, 19)}) | ${ct.txCount} | ${ct.priorCount} | ${ct.recentCount} | **${ct.modeBySelectScoringRule}** | ${ct.modeComputedByLine54} |`);
    }
  }

  console.log("\n================================================================================");
  console.log("CODE INSPECTION (pilot_score.mjs & run_pilot.mjs)");
  console.log("================================================================================");
  console.log("Where T_b is sliced:");
  console.log("  File: scripts/next/run_pilot.mjs:200-202");
  console.log("  Code:");
  console.log("    const tbUnix = t0Unix - 300;");
  console.log("    const txsB = allTxs.filter((t) => (t.timestamp ?? 0) < tbUnix);");
  console.log("    const scoreB = scoreAt(c.wallet, txsB, tbUnix);");
  console.log();
  console.log("Where generatedAt is set and selectScoring is called:");
  console.log("  File: scripts/next/pilot_score.mjs:34-41");
  console.log("  Code:");
  console.log("    const windowDays = 7;");
  console.log("    const windowStart = T - windowDays * 86_400;");
  console.log("    const { baselineTxs, evalTxs } = selectScoring(txs, windowStart);");
  console.log("    const baseline = updateBaseline(wallet, null, baselineTxs, T, null);");
  console.log();
  console.log("Where baselineMode was determined:");
  console.log("  File: scripts/next/pilot_score.mjs:54");
  console.log("  Code:");
  console.log("    const baselineMode = baselineTxs.length !== txs.length ? \"windowed\" : \"snapshot\";");
  console.log();

  return caseDiagnostics;
}

if (process.argv[1] && process.argv[1].endsWith("pilot_diagnose.mjs")) {
  runDiagnostics();
}
