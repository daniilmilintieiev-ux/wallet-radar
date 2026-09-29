#!/usr/bin/env node
// Read-only analysis of the shadow collector's database, per docs/PREREGISTRATION.md.
//
// This script NEVER writes to the database (opens with { readOnly: true }) and does
// not invent its own rules: every bucket definition, threshold, and exclusion below
// cites the exact section of docs/PREREGISTRATION.md it implements. If a rule isn't
// written there, it isn't implemented here as a guess.
//
// Stage 7E task 2.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DB_PATH } from "./db.mjs";

// --- PREREGISTRATION.md section 4.4: Wilson score interval (95%, z = 1.96) ---
export const WILSON_Z = 1.96;
// --- PREREGISTRATION.md section 4.5: "radar useful" needs >= 3x AND non-overlapping CIs ---
export const USEFUL_RATIO_THRESHOLD = 3;
// --- PREREGISTRATION.md section 4.6: < 30 DANGEROUS in a stratum -> "insufficient data" ---
export const MIN_DANGEROUS_FOR_PUBLICATION = 30;

/**
 * Wilson score interval for a proportion x/n, per docs/PREREGISTRATION.md section 4.4:
 *   center = (p + z^2/(2n)) / (1 + z^2/n)
 *   margin = z * sqrt(p(1-p)/n + z^2/(4n^2)) / (1 + z^2/n)
 * Returns { p, lower, upper, x, n }. n === 0 returns nulls (undefined proportion),
 * never a fabricated interval.
 */
export function wilson95(x, n, z = WILSON_Z) {
  if (!Number.isFinite(n) || n <= 0) return { p: null, lower: null, upper: null, x, n };
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), x, n };
}

/** Do two [lower, upper] intervals overlap? (PREREGISTRATION.md section 4.5, point 2) */
export function intervalsOverlap(a, b) {
  if (a.lower === null || b.lower === null) return null; // undefined -- n was 0 on one side
  return a.lower <= b.upper && b.lower <= a.upper;
}

// --- PREREGISTRATION.md section 4.1: bucket derived from /gate-copy's real `action` field ---
const ACTION_TO_BUCKET = {
  block: "BLOCKED",
  manual_review: "BLOCKED", // both allow:false branches folded into BLOCKED, per 4.1's stated rationale
  throttle: "LOW_TRUST_WARMING",
  allow: "VERIFIED_SAFE",
};

/**
 * Parses shadow_trades.radar_verdict (JSON text or already-parsed) and returns a bucket
 * name. All 6 of toolGateCopy's actual return branches (src/http-server.ts:443-548, see
 * docs/PREREGISTRATION.md section 11 for the full enumeration) use one of exactly four
 * `action` values, all covered by ACTION_TO_BUCKET -- "UNCLASSIFIED" is a defensive
 * fallback for a response shape that doesn't exist in the code today (missing/unparseable
 * body, or an `action` value not in the current four), per task 4 stage 7F: never guess a
 * bucket for a form that doesn't fit, report it as its own explicit class instead.
 */
export function classifyVerdictBucket(radarVerdictRaw) {
  if (!radarVerdictRaw) return "UNCLASSIFIED";
  let verdict;
  try {
    verdict = typeof radarVerdictRaw === "string" ? JSON.parse(radarVerdictRaw) : radarVerdictRaw;
  } catch {
    return "UNCLASSIFIED";
  }
  return ACTION_TO_BUCKET[verdict?.action] ?? "UNCLASSIFIED";
}

/**
 * Task 1/2 (stage 7G): the finer-grained response FORM, distinguishing whether
 * `details.simulation` ran, per docs/PREREGISTRATION.md section 12 -- descriptive only,
 * never used to change the primary bucket/table logic above.
 *   F1 = action "block", no details.simulation (http-server.ts:443-454, trust verdict "hold")
 *   F2 = action "manual_review", no details.simulation (455-464, trust verdict "unknown")
 *   F3 = action "block", WITH details.simulation (493-505, isBlocked)
 *   F4 = action "throttle" (507-520, isThrottled -- always has simulation)
 *   F5 = action "manual_review", WITH details.simulation (522-534, !safeToExecute)
 *   F6 = action "allow" (538-548, final fallback)
 * "UNCLASSIFIED" for the same defensive reasons as classifyVerdictBucket.
 */
export function classifyResponseForm(radarVerdictRaw) {
  if (!radarVerdictRaw) return "UNCLASSIFIED";
  let verdict;
  try {
    verdict = typeof radarVerdictRaw === "string" ? JSON.parse(radarVerdictRaw) : radarVerdictRaw;
  } catch {
    return "UNCLASSIFIED";
  }
  const action = verdict?.action;
  const hasSimulation = Boolean(verdict?.details?.simulation);
  if (action === "block" && !hasSimulation) return "F1";
  if (action === "manual_review" && !hasSimulation) return "F2";
  if (action === "block" && hasSimulation) return "F3";
  if (action === "throttle") return "F4";
  if (action === "manual_review" && hasSimulation) return "F5";
  if (action === "allow") return "F6";
  return "UNCLASSIFIED";
}

/**
 * Counts ALL rows by response form, regardless of outcome -- never reads row.outcome
 * at all. Used both by the descriptive full-mode tables (further filtered to RESOLVED
 * rows by the caller) and, unfiltered, by --counters-only mode (task 1's "look-ahead
 * rule": before collection stops and the final outcomes run, this script may only
 * report record counts, never outcome-derived shares).
 */
export function countRowsByForm(rows) {
  const counts = { F1: 0, F2: 0, F3: 0, F4: 0, F5: 0, F6: 0, UNCLASSIFIED: 0 };
  for (const row of rows) {
    counts[classifyResponseForm(row.radar_verdict)]++;
  }
  return counts;
}

/**
 * Classifies one shadow_trades row into exactly one reporting class.
 * Order matters only in that RADAR_ERROR/NO_BUYER are checked first because they
 * mean no real verdict/outcome pipeline ever ran for the row (PREREGISTRATION.md
 * section 5) -- by construction (collect.mjs) they never co-occur with each other
 * or with a non-null outcome.
 */
export function classifyRow(row) {
  if (row.radar_error) return "RADAR_ERROR"; // PREREGISTRATION.md section 5
  if (!row.buyer) return "NO_BUYER"; // PREREGISTRATION.md section 5
  if (row.outcome === "ISSUER_CONTROLLED") return "ISSUER_CONTROLLED"; // section 5
  if (row.outcome === "PAIR_MISSING") return "PAIR_MISSING"; // section 5
  if (typeof row.outcome === "string" && row.outcome.startsWith("невосстановимо")) return "IRRECOVERABLE"; // section 5, "невосстановимо"
  if (row.outcome === "миграция, не исход") return "MIGRATION_NOT_AN_OUTCOME"; // outcomes.mjs classifyOutcome -- explicitly "не исход", excluded from DANGEROUS/SAFE the same way, not separately named in section 5 but excluded by the same logic
  if (row.outcome === null) return "PENDING"; // outcome not yet computed (too young, or outcomes.mjs hasn't run) -- not an exclusion class from section 5, just not resolved yet
  if (row.outcome === "DANGEROUS" || row.outcome === "SAFE") return "RESOLVED"; // enters the primary metric (section 4)
  return "UNKNOWN_OUTCOME"; // defensive: should not happen: any outcomes.mjs value not covered above
}

/** Splits RESOLVED rows into table-1/table-2 block-vs-pass buckets, per section 4.2/4.3. */
export function splitTables(resolvedRowsWithBucket) {
  const table1 = { block: [], pass: [] }; // LOW_TRUST_WARMING counted as "passed" (4.2)
  const table2 = { block: [], pass: [] }; // LOW_TRUST_WARMING counted as "blocked" (4.3)
  for (const r of resolvedRowsWithBucket) {
    if (r.bucket === "BLOCKED") {
      table1.block.push(r);
      table2.block.push(r);
    } else if (r.bucket === "LOW_TRUST_WARMING") {
      table1.pass.push(r);
      table2.block.push(r);
    } else if (r.bucket === "VERIFIED_SAFE") {
      table1.pass.push(r);
      table2.pass.push(r);
    }
    // bucket === null (undeterminable action) contributes to neither table -- not silently
    // folded into either side; counted separately by the caller as UNDETERMINED_BUCKET.
  }
  return { table1, table2 };
}

function dangerousCount(rows) {
  return rows.filter((r) => r.outcome === "DANGEROUS").length;
}

/**
 * PREREGISTRATION.md section 12(a): per response form, over RESOLVED rows (DANGEROUS+SAFE)
 * ONLY, combined across both strata (this secondary table is explicitly descriptive, "без
 * агрегирования и без выводов" -- no conclusion is drawn from it, unlike section 4's
 * stratum-separated primary tables). Record count, DANGEROUS count, and the Wilson interval
 * for each form -- nothing aggregated across forms, nothing decided.
 */
export function dangerousShareByForm(resolvedRows) {
  const byForm = { F1: [], F2: [], F3: [], F4: [], F5: [], F6: [], UNCLASSIFIED: [] };
  for (const row of resolvedRows) {
    byForm[classifyResponseForm(row.radar_verdict)].push(row);
  }
  const result = {};
  for (const [form, formRows] of Object.entries(byForm)) {
    const x = dangerousCount(formRows);
    const n = formRows.length;
    result[form] = { count: n, dangerous: x, ci: wilson95(x, n) };
  }
  return result;
}

/**
 * PREREGISTRATION.md section 12(b): "simulation did not run" (F1, F2 -- toolGateCopy
 * returned before ever reaching simulatePayment) vs "simulation ran" (F3-F6). UNCLASSIFIED
 * rows go into neither group, same non-guessing policy as everywhere else in this file.
 */
export function simulationSplit(resolvedRows) {
  const notRun = [];
  const ran = [];
  for (const row of resolvedRows) {
    const form = classifyResponseForm(row.radar_verdict);
    if (form === "F1" || form === "F2") notRun.push(row);
    else if (form === "F3" || form === "F4" || form === "F5" || form === "F6") ran.push(row);
  }
  const xNot = dangerousCount(notRun);
  const nNot = notRun.length;
  const xRan = dangerousCount(ran);
  const nRan = ran.length;
  return {
    simulationNotRun: { count: nNot, dangerous: xNot, ci: wilson95(xNot, nNot) },
    simulationRan: { count: nRan, dangerous: xRan, ci: wilson95(xRan, nRan) },
  };
}

/**
 * Applies section 4.5 ("radar useful") and 4.6 ("insufficient data") to one
 * table/stratum split. Returns a verdict object; never decides anything not
 * spelled out in PREREGISTRATION.md.
 */
export function evaluateSplit(blockRows, passRows, totalDangerousInStratum) {
  const xBlock = dangerousCount(blockRows);
  const nBlock = blockRows.length;
  const xPass = dangerousCount(passRows);
  const nPass = passRows.length;
  const ciBlock = wilson95(xBlock, nBlock);
  const ciPass = wilson95(xPass, nPass);

  if (totalDangerousInStratum < MIN_DANGEROUS_FOR_PUBLICATION) {
    return { status: "INSUFFICIENT_DATA", reason: `only ${totalDangerousInStratum} DANGEROUS in this stratum (< ${MIN_DANGEROUS_FOR_PUBLICATION})`, xBlock, nBlock, xPass, nPass, ciBlock, ciPass };
  }

  const pBlock = ciBlock.p;
  const pPass = ciPass.p;
  let ratio = null;
  if (pBlock !== null && pPass !== null) {
    ratio = pPass > 0 ? pBlock / pPass : pBlock > 0 ? Infinity : null; // 0/0 undefined -- both clean, ratio not meaningful
  }
  const overlap = intervalsOverlap(ciBlock, ciPass);
  const ratioOk = ratio !== null && Number.isFinite(ratio) ? ratio >= USEFUL_RATIO_THRESHOLD : ratio === Infinity;
  const nonOverlap = overlap === false;

  if (ratioOk && nonOverlap) {
    return { status: "RADAR_USEFUL", ratio, xBlock, nBlock, xPass, nPass, ciBlock, ciPass };
  }
  return { status: "DIFFERENCE_NOT_ESTABLISHED", ratio, xBlock, nBlock, xPass, nPass, ciBlock, ciPass };
}

function loadRows(db) {
  return db.prepare("SELECT * FROM shadow_trades").all();
}

/** Reads skip_counters (date, reason, count) -- task 3 stage 7F. Read-only, no writes. */
export function loadSkipCounters(db) {
  return db.prepare("SELECT date, reason, count FROM skip_counters ORDER BY date, reason").all();
}

/** Aggregates skip_counters rows across all dates, by reason. */
export function summarizeSkipCounters(skipCounterRows) {
  const byReason = {};
  for (const r of skipCounterRows) {
    byReason[r.reason] = (byReason[r.reason] || 0) + r.count;
  }
  return byReason;
}

export function formatSkipCountersReport(skipCounterRows) {
  const byReason = summarizeSkipCounters(skipCounterRows);
  const reasons = Object.keys(byReason).sort();
  if (reasons.length === 0) return "  (нет записей в skip_counters -- сборщик ещё не запускался, или все причины отбраковки отсутствовали)";
  return reasons.map((r) => `  ${r}: ${byReason[r]}`).join("\n");
}

/** Reads error_logs's row count -- read-only. */
export function countErrorLogs(db) {
  return db.prepare("SELECT COUNT(*) AS cnt FROM error_logs").get().cnt;
}

/**
 * PREREGISTRATION.md section 12, "правило подглядывания" (stage 7G): before collection
 * stops and the final outcomes.mjs run, analyze.mjs may ONLY print this -- record count,
 * error_logs count, skip_counters, and per-form RECORD COUNTS with no outcome/danger-rate
 * information whatsoever. This function never reads row.outcome (countRowsByForm doesn't
 * either) and prints nothing that classifyRow/dangerousCount/wilson95 would need.
 */
export function formatCountersOnlyReport(rows, skipCounterRows, errorLogCount) {
  const lines = [];
  lines.push(`[COUNTERS-ONLY] Всего строк в shadow_trades: ${rows.length}`);
  lines.push(`[COUNTERS-ONLY] Записей в error_logs: ${errorLogCount}`);
  lines.push("");
  lines.push("[COUNTERS-ONLY] skip_counters (по всем датам суммарно):");
  lines.push(formatSkipCountersReport(skipCounterRows));
  lines.push("");
  lines.push("[COUNTERS-ONLY] Число записей по формам ответа /gate-copy (F1..F6, без исходов и без долей опасных):");
  const formCounts = countRowsByForm(rows);
  for (const [form, count] of Object.entries(formCounts)) {
    lines.push(`  ${form}: ${count}`);
  }
  return lines.join("\n");
}

export function analyze(rows) {
  const byClass = {
    RADAR_ERROR: [],
    NO_BUYER: [],
    ISSUER_CONTROLLED: [],
    PAIR_MISSING: [],
    IRRECOVERABLE: [],
    MIGRATION_NOT_AN_OUTCOME: [],
    PENDING: [],
    RESOLVED: [],
    UNKNOWN_OUTCOME: [],
  };
  for (const row of rows) {
    byClass[classifyRow(row)].push(row);
  }

  const stratTotals = { A: {}, B: {} };
  const result = { totalRows: rows.length, separateLines: {}, strata: {}, radarTokenCheckMissing: {} };

  for (const cls of ["ISSUER_CONTROLLED", "PAIR_MISSING", "IRRECOVERABLE", "NO_BUYER", "RADAR_ERROR", "MIGRATION_NOT_AN_OUTCOME", "PENDING", "UNKNOWN_OUTCOME"]) {
    result.separateLines[cls] = byClass[cls].length;
  }
  // PAIR_MISSING: two bounds (PREREGISTRATION.md section 5 / SHADOW-RUNBOOK.md 5.4a).
  // Lower bound: treat as non-dangerous (excluded from FN numerator). Upper bound: treat
  // as dangerous (included). Both published, neither chosen unilaterally.
  result.pairMissingBounds = { count: byClass.PAIR_MISSING.length, note: "lower bound = treated as not-dangerous (excluded), upper bound = treated as dangerous (included) -- both reported, see PREREGISTRATION.md section 5" };

  // TOKEN_TOO_OLD (and POOL_TOO_OLD/NO_BUYER/RADAR_ERROR/PROCESSING_ERROR) used to be
  // unrecoverable from the database (stage 7E: checkTokenAge rejects the pool BEFORE a
  // row is ever created, and the per-cycle counter was only console-logged). Fixed in
  // stage 7F task 3 via the skip_counters table -- see formatSkipCountersReport /
  // the CLI entry point below, which reads it separately from shadow_trades. analyze()
  // itself only ever sees shadow_trades rows, so it does not report TOKEN_TOO_OLD here.

  // radar_token_check_missing distribution (task 3 stage 7E, four-state task 2 stage 7F)
  // -- informational, not part of section 4's metric. NOT_APPLICABLE (a real verdict
  // exists, but TOXIC_MINT structurally can't apply -- no freezeAuthority or whitelisted)
  // is a distinct stored string value, never conflated with "no verdict at all" (null,
  // e.g. NO_BUYER/RADAR_ERROR rows where the column was never set).
  const rtcCounts = { true: 0, false: 0, NOT_DETERMINABLE: 0, NOT_APPLICABLE: 0, "null (no verdict)": 0 };
  for (const row of rows) {
    const v = row.radar_token_check_missing;
    if (v === "true") rtcCounts.true++;
    else if (v === "false") rtcCounts.false++;
    else if (v === "NOT_DETERMINABLE") rtcCounts.NOT_DETERMINABLE++;
    else if (v === "NOT_APPLICABLE") rtcCounts.NOT_APPLICABLE++;
    else rtcCounts["null (no verdict)"]++;
  }
  result.radarTokenCheckMissing = rtcCounts;

  // PREREGISTRATION.md section 12(a)/(b) (stage 7G) -- descriptive secondary tables,
  // combined across strata (unlike section 4's tables, which are always per-stratum),
  // no aggregation across forms, no "radar useful"-style conclusion drawn from either.
  result.responseForms = dangerousShareByForm(byClass.RESOLVED);
  result.simulationSplit = simulationSplit(byClass.RESOLVED);

  for (const strat of ["A", "B"]) {
    const resolvedInStrat = byClass.RESOLVED.filter((r) => r.strat === strat);
    const withBucket = resolvedInStrat.map((r) => ({ ...r, bucket: classifyVerdictBucket(r.radar_verdict) }));
    const unclassifiedCount = withBucket.filter((r) => r.bucket === "UNCLASSIFIED").length;
    const { table1, table2 } = splitTables(withBucket);
    const totalDangerous = dangerousCount(resolvedInStrat);

    const noBuyerInStrat = byClass.NO_BUYER.filter((r) => r.strat === strat).length; // NO_BUYER share is per-stratum too (TESTER-SPEC.md v2.2, stage 7D task 4)

    result.strata[strat] = {
      resolvedCount: resolvedInStrat.length,
      totalDangerous,
      unclassifiedCount,
      noBuyerInStratum: noBuyerInStrat,
      table1: evaluateSplit(table1.block, table1.pass, totalDangerous),
      table2: evaluateSplit(table2.block, table2.pass, totalDangerous),
    };
  }

  return result;
}

function formatCI(ci) {
  if (ci.n === 0) return `n=0 (undefined)`;
  return `x=${ci.x}/n=${ci.n} p=${(ci.p * 100).toFixed(2)}% CI95=[${(ci.lower * 100).toFixed(2)}%, ${(ci.upper * 100).toFixed(2)}%]`;
}

export function formatReport(result) {
  const lines = [];
  lines.push(`Всего строк в shadow_trades: ${result.totalRows}`);
  lines.push("");
  lines.push("=== Отдельные строки (никогда не входят в DANGEROUS/SAFE, PREREGISTRATION.md section 5) ===");
  for (const [cls, count] of Object.entries(result.separateLines)) {
    lines.push(`  ${cls}: ${count}`);
  }
  lines.push(`  PAIR_MISSING (две границы): ${result.pairMissingBounds.count} -- ${result.pairMissingBounds.note}`);
  lines.push("");
  lines.push("=== radar_token_check_missing (task 3, справочно, не часть основной метрики) ===");
  for (const [k, v] of Object.entries(result.radarTokenCheckMissing)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push("");
  lines.push("=== Формы ответа /gate-copy F1..F6 (PREREGISTRATION.md section 12a, описательно, обе страты вместе, без агрегирования и без выводов) ===");
  for (const [form, s] of Object.entries(result.responseForms)) {
    lines.push(`  ${form}: ${formatCI(s.ci)}`);
  }
  lines.push("");
  lines.push("=== Симуляция не выполнялась (F1,F2) vs выполнялась (F3-F6) (PREREGISTRATION.md section 12b, описательно) ===");
  lines.push(`  Симуляция НЕ выполнялась: ${formatCI(result.simulationSplit.simulationNotRun.ci)}`);
  lines.push(`  Симуляция выполнялась:    ${formatCI(result.simulationSplit.simulationRan.ci)}`);
  lines.push("  ВНИМАНИЕ (PREREGISTRATION.md section 12c): F1/F2 завершаются до проверки токена -- бакет BLOCKED в таблице 1 может состоять преимущественно из блокировок по доверию к покупателю, читать таблицу 1 нужно с учётом этого.");
  for (const strat of ["A", "B"]) {
    const s = result.strata[strat];
    lines.push("");
    lines.push(`=== Страт ${strat} ===`);
    lines.push(`  RESOLVED (DANGEROUS+SAFE): ${s.resolvedCount}, из них DANGEROUS: ${s.totalDangerous}`);
    lines.push(`  NO_BUYER в этом страте: ${s.noBuyerInStratum}`);
    lines.push(`  UNCLASSIFIED (форма ответа не укладывается в бакеты §4.1, docs/PREREGISTRATION.md section 11): ${s.unclassifiedCount}`);
    for (const [tableName, t] of [["Таблица 1 (throttle=пропущено)", s.table1], ["Таблица 2 (throttle=блок)", s.table2]]) {
      lines.push(`  ${tableName}: ${t.status}${t.reason ? " -- " + t.reason : ""}`);
      lines.push(`    Заблокировано: ${formatCI(t.ciBlock)}`);
      lines.push(`    Пропущено:     ${formatCI(t.ciPass)}`);
      if (t.ratio !== null && t.ratio !== undefined) lines.push(`    Отношение долей (block/pass): ${t.ratio === Infinity ? "∞ (pass=0%)" : t.ratio.toFixed(2) + "x"}`);
    }
  }
  return lines.join("\n");
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let dbPath = DEFAULT_DB_PATH;
  let countersOnly = false;
  for (const a of args) {
    if (a.startsWith("--db=")) dbPath = a.split("=")[1];
    else if (a === "--counters-only") countersOnly = true;
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    console.error(`[ANALYZE] Cannot open ${dbPath} read-only: ${err.message}`);
    console.error(`[ANALYZE] No database to analyze -- nothing has been collected yet, or the path is wrong.`);
    process.exit(1);
  }

  try {
    const rows = loadRows(db);
    if (countersOnly) {
      // Look-ahead rule (PREREGISTRATION.md section 12, stage 7G): this branch never
      // calls analyze() at all -- structurally, not just by convention, nothing
      // outcome-derived can leak into the printed report while collection is still live.
      console.log(formatCountersOnlyReport(rows, loadSkipCounters(db), countErrorLogs(db)));
    } else {
      const result = analyze(rows);
      console.log(formatReport(result));
      console.log("");
      console.log("=== skip_counters (task 3 stage 7F, по всем датам суммарно) ===");
      console.log(formatSkipCountersReport(loadSkipCounters(db)));
    }
  } finally {
    db.close();
  }
}
