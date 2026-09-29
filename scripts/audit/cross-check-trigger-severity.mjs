#!/usr/bin/env node
// Stage 4A.2 (ground-truth audit, see CLAUDE.md).
//
// benchmarks/simulation-results.json DOES record a reason per BLOCKED wallet:
// the `triggerEvent` string, e.g. "TOXIC_MINT (high), REGIME_SHIFT (medium)"
// (built in scripts/history-machine.ts:310 from the anomalies active at
// blockedAtStep). It does NOT record which mint or which analyzer.ts
// condition -- that is exactly what scripts/audit/blocked-table.mjs
// reconstructs. This script cross-checks the two: for every BLOCKED wallet
// where a TOXIC_MINT anomaly is reconstructed, does the SEVERITY we'd
// compute from the current mint-cache.json match the severity recorded in
// triggerEvent at the time the benchmark actually ran?
//
// Read-only, no network calls, no src/ changes.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeRows } from "./lib/toxic-mint-rows.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const { rows, consts } = computeRows(ROOT);

function recordedToxicMintSeverity(triggerEvent) {
  const m = /TOXIC_MINT \((\w+)\)/.exec(triggerEvent || "");
  return m ? m[1] : null;
}

// Mirrors the severity formula at analyzer.ts (found by search, see consts.LINE_SEVERITY).
function expectedSeverity(row) {
  if (row.freezeAuthority) return "high";
  const top10 = row.top10Pct;
  const veryConcentrated = typeof top10 === "number" && top10 >= consts.TOP10_HIGH_PCT;
  const concentrated = typeof top10 === "number" && top10 >= consts.TOP10_CONCENTRATION_PCT;
  if (veryConcentrated) return "high";
  if (row.isPump && concentrated) return "high";
  return "medium";
}

let matched = 0;
let mismatched = 0;
let noRecordedToxicMint = 0;
const mismatches = [];
const otherReasonRows = [];

console.log("address,bucket,recordedTriggerEvent,recordedSeverity,expectedSeverity,match");
for (const row of rows) {
  if (row.bucket === "без токенных правил") {
    otherReasonRows.push({ address: row.address, triggerEvent: row.triggerEvent });
    continue;
  }
  const recorded = recordedToxicMintSeverity(row.triggerEvent);
  if (!recorded) {
    // TOXIC_MINT was expected (hasToxicMintInTrigger was true to reach this
    // branch in computeRows) but the regex didn't find "TOXIC_MINT (severity)" --
    // should not happen; flag explicitly instead of silently skipping.
    noRecordedToxicMint++;
    console.log([row.address, row.bucket, JSON.stringify(row.triggerEvent), "ПАРСИНГ НЕ УДАЛСЯ", "-", "НЕ ОПРЕДЕЛЕНО"].join(","));
    continue;
  }
  const expected = row.mint ? expectedSeverity(row) : "НЕ ОПРЕДЕЛЕНО (mint не реконструирован)";
  const isMatch = recorded === expected;
  if (isMatch) matched++;
  else {
    mismatched++;
    mismatches.push({ address: row.address, mint: row.mint, recorded, expected, triggerEvent: row.triggerEvent });
  }
  console.log([row.address, row.bucket, JSON.stringify(row.triggerEvent), recorded, expected, isMatch].join(","));
}

console.error("\n=== SUMMARY (4A.2) ===");
console.error(`Total BLOCKED: ${rows.length}`);
console.error(`With a TOXIC_MINT anomaly recorded + mint reconstructed: ${matched + mismatched}`);
console.error(`  Severity MATCH: ${matched}`);
console.error(`  Severity MISMATCH: ${mismatched}`);
console.error(`  TOXIC_MINT expected but regex parse failed: ${noRecordedToxicMint}`);
console.error(`Без TOXIC_MINT в triggerEvent (blocked by other rule entirely): ${otherReasonRows.length}`);
if (mismatches.length > 0) {
  console.error("\nMismatches:");
  for (const m of mismatches) {
    console.error(`  ${m.address} mint=${m.mint} recorded=${m.recorded} expected=${m.expected} triggerEvent=${JSON.stringify(m.triggerEvent)}`);
  }
}
console.error("\nWallets blocked WITHOUT TOXIC_MINT (their actual recorded triggerEvent):");
for (const r of otherReasonRows) {
  console.error(`  ${r.address}: ${r.triggerEvent}`);
}
