#!/usr/bin/env node
// Stage 3B.1 (ground-truth audit, see CLAUDE.md).
//
// Reproducible replacement for the (unverifiable) Gemini stage-2 report
// tables 2A.1 / 2A.4: for every wallet whose finalVerdict is "BLOCKED" in
// benchmarks/simulation-results.json, re-derive WHICH mint (if any) caused
// the TOXIC_MINT anomaly at the exact transaction that triggered the block
// (`blockedAtStep`), and WHICH analyzer.ts condition fired for it, evaluated
// against the CURRENT benchmarks/mint-cache.json (not a historical snapshot
// -- see CLAUDE.md "mint.ts не умеет исторические срезы").
//
// Read-only: does not modify src/, ground-truth/, or labels*.jsonl. No
// network calls (uses benchmarks/history-cache/*.json, already on disk).
// Source line numbers are located by searching src/analyzer.ts at run time
// instead of being hardcoded, so they can't silently go stale.
//
// Usage: node scripts/audit/blocked-table.mjs [--json]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeRows } from "./lib/toxic-mint-rows.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const { rows, consts } = computeRows(ROOT);

const asJson = process.argv.includes("--json");
if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log("address,blockedAtStep,mint,freezeAuthority,mintAuthority,top10Pct,isPump,bucket,note");
  for (const row of rows) {
    console.log(
      [
        row.address,
        row.blockedAtStep ?? "",
        row.mint ?? "",
        row.freezeAuthority ?? "",
        row.mintAuthority ?? "",
        row.top10Pct ?? "",
        row.isPump ?? "",
        row.bucket,
        JSON.stringify(row.note || ""),
      ].join(","),
    );
  }
}

// --- Summary (3B.4) ---
const bucketCounts = { freezeAuthority: 0, mintAuthority: 0, top10Pct: 0, "без токенных правил": 0, "НЕ ОПРЕДЕЛЕНО": 0 };
for (const row of rows) bucketCounts[row.bucket] = (bucketCounts[row.bucket] || 0) + 1;
// "pump-only": isPump true but the mint was NOT flagged by freeze/mint/concentration alone
// (structurally impossible under the current TOXIC_MINT gate, which requires
// hasFreeze||hasMint||concentrated regardless of isPump -- counted explicitly to PROVE that, not assume it).
const pumpOnlyCount = rows.filter((r) => r.isPump && r.bucket !== "freezeAuthority" && r.bucket !== "top10Pct" && r.bucket !== "mintAuthority").length;
const uniqueMints = new Set(rows.map((r) => r.mint).filter(Boolean));

console.error("\n=== SUMMARY (3B.4) ===");
console.error(`Total BLOCKED wallets: ${rows.length}`);
console.error(`  freezeAuthority: ${bucketCounts.freezeAuthority}`);
console.error(`  mintAuthority-only: ${bucketCounts.mintAuthority}`);
console.error(`  top10Pct-only: ${bucketCounts.top10Pct}`);
console.error(`  pump-only (isPump true, no freeze/mint/concentration match): ${pumpOnlyCount}`);
console.error(`  без токенных правил (TOXIC_MINT отсутствует в triggerEvent): ${bucketCounts["без токенных правил"]}`);
console.error(`  НЕ ОПРЕДЕЛЕНО: ${bucketCounts["НЕ ОПРЕДЕЛЕНО"]}`);
console.error(`Unique mints among matched TOXIC_MINT triggers: ${uniqueMints.size}`);
console.error(`Mints: ${[...uniqueMints].join(", ")}`);
console.error(
  `TOP10_CONCENTRATION_PCT=${consts.TOP10_CONCENTRATION_PCT} (analyzer.ts:${consts.LINE_TOP10_CONST}), TOP10_HIGH_PCT=${consts.TOP10_HIGH_PCT} (analyzer.ts:${consts.LINE_HIGH_CONST}), severity gate analyzer.ts:${consts.LINE_SEVERITY}`,
);
