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
  // Stage 7J task 2: the two new irrecoverable classes get their OWN lines (exact match,
  // checked BEFORE the generic "невосстановимо" prefix below) rather than being silently
  // folded into the old IRRECOVERABLE bucket alongside "ATA закрыт"/"NO_BUYER".
  if (row.outcome === "невосстановимо (нет ликвидности на t)") return "IRRECOVERABLE_NO_LIQUIDITY_AT_T";
  if (row.outcome === "невосстановимо (ликвидность недоступна)") return "IRRECOVERABLE_LIQUIDITY_T3_UNAVAILABLE";
  if (row.outcome === "миграция не определена") return "MIGRATION_UNDETERMINED"; // task 2 stage 7J -- successor candidate(s) missing a liquidity field, never guessed
  if (typeof row.outcome === "string" && row.outcome.startsWith("невосстановимо")) return "IRRECOVERABLE"; // section 5, "невосстановимо" (ATA closed / NO_BUYER variants)
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

// --- Task 5 (stage 7H): independence of observations ---

/** Number of distinct buyer wallets among (typically RESOLVED) rows. */
export function countDistinctBuyers(rows) {
  return new Set(rows.map((r) => r.buyer).filter(Boolean)).size;
}

/** Top-N buyers by record count -- descriptive only, no threshold or verdict attached. */
export function topBuyers(rows, n = 10) {
  const counts = new Map();
  for (const r of rows) {
    if (!r.buyer) continue;
    counts.set(r.buyer, (counts.get(r.buyer) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([buyer, count]) => ({ buyer, count }));
}

/**
 * Reduces RESOLVED rows to one record per buyer -- the EARLIEST by `t` (purchase time).
 * Checks whether the primary metric is dominated by a handful of highly active buyers
 * (snipers/bots repeatedly appearing across many records -- confirmed live in stage 7H
 * task 1's real-pool check, where the same buyer address resolved for two different
 * pools), which would violate the independent-observations assumption the Wilson
 * interval (section 4.4) relies on.
 */
export function oneRecordPerBuyer(resolvedRows) {
  const earliestByBuyer = new Map();
  for (const r of resolvedRows) {
    if (!r.buyer) continue;
    const existing = earliestByBuyer.get(r.buyer);
    if (!existing || r.t < existing.t) earliestByBuyer.set(r.buyer, r);
  }
  return [...earliestByBuyer.values()];
}

/**
 * PREREGISTRATION.md section 14(г) (stage 7H): "radar useful" only holds if BOTH the
 * main (all-trades) table AND the one-record-per-buyer table independently say
 * RADAR_USEFUL for the same table/stratum -- otherwise "insufficient data", regardless
 * of what either one says individually (a useful-looking result that evaporates once
 * repeat buyers are collapsed to one observation each is not evidence of anything).
 */
export function evaluateClusteredUsefulness(mainStatus, dedupedStatus) {
  if (mainStatus === "RADAR_USEFUL" && dedupedStatus === "RADAR_USEFUL") return "RADAR_USEFUL";
  return "INSUFFICIENT_DATA";
}

/** Computes table1/table2 (+ resolvedCount/totalDangerous/unclassifiedCount) for a set
 * of RESOLVED rows already filtered to one stratum. Shared by the main per-stratum loop
 * and the one-record-per-buyer secondary tables (task 5 stage 7H) so both use identical logic. */
function computeStratumTables(resolvedInStrat) {
  const withBucket = resolvedInStrat.map((r) => ({ ...r, bucket: classifyVerdictBucket(r.radar_verdict) }));
  const unclassifiedCount = withBucket.filter((r) => r.bucket === "UNCLASSIFIED").length;
  const { table1, table2 } = splitTables(withBucket);
  const totalDangerous = dangerousCount(resolvedInStrat);
  return {
    resolvedCount: resolvedInStrat.length,
    totalDangerous,
    unclassifiedCount,
    table1: evaluateSplit(table1.block, table1.pass, totalDangerous),
    table2: evaluateSplit(table2.block, table2.pass, totalDangerous),
  };
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

/** Reads pool_candidates (cycle_ts, pool, mint, seen_at, selected) -- task 3 stage 7H. Read-only. */
export function loadPoolCandidates(db) {
  return db.prepare("SELECT cycle_ts, pool, mint, seen_at, selected FROM pool_candidates ORDER BY seen_at").all();
}

/**
 * Groups pool_candidates rows by UTC hour of seen_at, counting seen vs selected --
 * task 3 stage 7H, to check whether collection is spread across the day (the bug this
 * whole task fixes) or still bunched into a couple of hours.
 */
export function summarizePoolCandidatesByHour(poolCandidateRows) {
  const byHour = {};
  for (let h = 0; h < 24; h++) byHour[String(h).padStart(2, "0")] = { seen: 0, selected: 0 };
  for (const r of poolCandidateRows) {
    const hour = new Date(r.seen_at).getUTCHours();
    const key = String(hour).padStart(2, "0");
    byHour[key].seen++;
    if (r.selected) byHour[key].selected++;
  }
  return byHour;
}

export function formatPoolCandidatesByHourReport(poolCandidateRows) {
  const byHour = summarizePoolCandidatesByHour(poolCandidateRows);
  return Object.entries(byHour)
    .map(([hour, s]) => `  ${hour}:00 UTC -- увидено: ${s.seen}, выбрано: ${s.selected}`)
    .join("\n");
}

/**
 * Nearest-rank percentile over a numeric array (ascending sort, index =
 * ceil(p * n) - 1, clamped). Simple and deterministic -- no interpolation.
 */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * Stage 7L task 3 (docs/PREREGISTRATION.md section 16): distribution of the gap between
 * pool_candidates.seen_at (when the collector actually captured liquidity_usd/price_usd_seen,
 * see section 15е/16) and shadow_trades.t (the buyer's on-chain purchase time), in minutes.
 * This is purely a timing diagnostic over the collector's OWN bookkeeping (pair, t, seen_at) --
 * it reads neither outcome nor radar_verdict/radar_error, so it is safe under the look-ahead
 * rule and callable from --counters-only.
 *
 * Match rule: for a shadow_trades row with pair P, use the pool_candidates row where
 * pool === P AND selected = 1 (the cycle in which THIS trade was actually recorded) --
 * not just any "seen" row, since a pool can be seen across several cycles before selection.
 * A row with no such candidate is counted separately as unmatched, never silently dropped
 * or defaulted to a gap of 0.
 */
export function computeSeenAtVsTGapMinutes(rows, poolCandidateRows) {
  const selectedByPool = new Map();
  for (const c of poolCandidateRows) {
    if (!c.selected) continue;
    // First selected candidate wins if duplicates exist -- pool_candidates is written
    // once per (cycle_ts, pool), so more than one selected row for the same pool would
    // mean it was processed in two different cycles; keep the earliest.
    if (!selectedByPool.has(c.pool)) selectedByPool.set(c.pool, c);
  }

  const gapsMinutes = [];
  let unmatchedCount = 0;
  for (const row of rows) {
    const candidate = selectedByPool.get(row.pair);
    if (!candidate) {
      unmatchedCount++;
      continue;
    }
    const seenAtMs = new Date(candidate.seen_at).getTime();
    const tMs = row.t * 1000;
    gapsMinutes.push((seenAtMs - tMs) / 60000);
  }

  gapsMinutes.sort((a, b) => a - b);
  const n = gapsMinutes.length;
  const median = n === 0 ? null : n % 2 === 1 ? gapsMinutes[(n - 1) / 2] : (gapsMinutes[n / 2 - 1] + gapsMinutes[n / 2]) / 2;

  return {
    matchedCount: n,
    unmatchedCount,
    medianMinutes: median,
    p90Minutes: percentile(gapsMinutes, 0.9),
    maxMinutes: n === 0 ? null : gapsMinutes[n - 1],
  };
}

export function formatSeenAtVsTGapReport(rows, poolCandidateRows) {
  const s = computeSeenAtVsTGapMinutes(rows, poolCandidateRows);
  const fmt = (v) => (v === null ? "н/д" : v.toFixed(2));
  const lines = [];
  lines.push(
    `  seen_at (pool_candidates) минус t (записи), минуты -- медиана: ${fmt(s.medianMinutes)}, 90-й процентиль: ${fmt(s.p90Minutes)}, максимум: ${fmt(s.maxMinutes)} (записей с соответствием: ${s.matchedCount})`
  );
  if (s.unmatchedCount > 0) {
    lines.push(`  Записей БЕЗ соответствующего pool_candidates (selected=1) по pair: ${s.unmatchedCount} -- соответствие не найдено, распределение выше их не включает.`);
  }
  if (s.matchedCount === 0 && s.unmatchedCount === 0) {
    lines.push(`  Нет записей для сравнения (shadow_trades пуст).`);
  }
  return lines.join("\n");
}

/**
 * PREREGISTRATION.md section 12, "правило подглядывания" (stage 7G): before collection
 * stops and the final outcomes.mjs run, analyze.mjs may ONLY print this -- record count,
 * error_logs count, skip_counters, and per-form RECORD COUNTS with no outcome/danger-rate
 * information whatsoever. This function never reads row.outcome (countRowsByForm doesn't
 * either) and prints nothing that classifyRow/dangerousCount/wilson95 would need.
 */
export function formatCountersOnlyReport(rows, skipCounterRows, errorLogCount, poolCandidateRows = []) {
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
  lines.push("");
  lines.push("[COUNTERS-ONLY] pool_candidates -- увидено/выбрано по часам UTC (task 3 stage 7H, только счётчики):");
  lines.push(formatPoolCandidatesByHourReport(poolCandidateRows));
  lines.push("");
  // Stage 7L task 3: purely a timing diagnostic over (pair, t, seen_at) -- no outcome,
  // no radar_verdict/radar_error read anywhere in computeSeenAtVsTGapMinutes, so this is
  // safe under the look-ahead rule and belongs in counters-only too.
  lines.push("[COUNTERS-ONLY] seen_at (pool_candidates) минус t: распределение в минутах (только счётчики/тайминг, без исходов):");
  lines.push(formatSeenAtVsTGapReport(rows, poolCandidateRows));
  return lines.join("\n");
}

export function analyze(rows) {
  const byClass = {
    RADAR_ERROR: [],
    NO_BUYER: [],
    ISSUER_CONTROLLED: [],
    PAIR_MISSING: [],
    IRRECOVERABLE: [],
    IRRECOVERABLE_NO_LIQUIDITY_AT_T: [],
    IRRECOVERABLE_LIQUIDITY_T3_UNAVAILABLE: [],
    MIGRATION_NOT_AN_OUTCOME: [],
    MIGRATION_UNDETERMINED: [],
    PENDING: [],
    RESOLVED: [],
    UNKNOWN_OUTCOME: [],
  };
  for (const row of rows) {
    byClass[classifyRow(row)].push(row);
  }

  const stratTotals = { A: {}, B: {} };
  const result = { totalRows: rows.length, separateLines: {}, strata: {}, radarTokenCheckMissing: {} };

  for (const cls of [
    "ISSUER_CONTROLLED",
    "PAIR_MISSING",
    "IRRECOVERABLE",
    "IRRECOVERABLE_NO_LIQUIDITY_AT_T",
    "IRRECOVERABLE_LIQUIDITY_T3_UNAVAILABLE",
    "NO_BUYER",
    "RADAR_ERROR",
    "MIGRATION_NOT_AN_OUTCOME",
    "MIGRATION_UNDETERMINED",
    "PENDING",
    "UNKNOWN_OUTCOME",
  ]) {
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

  // PREREGISTRATION.md section 14(д) (stage 7H) -- mandatory: the share of form F1
  // ("незнакомые покупатели" -- blocked outright on the trust check, before simulation
  // ever ran, http-server.ts:443-454) among ALL rows (not just RESOLVED -- countRowsByForm
  // never reads outcome, so this is safe to compute even under the look-ahead rule if
  // this field is ever surfaced from a counters-only-style caller in the future).
  const allFormCounts = countRowsByForm(rows);
  result.f1Share = { count: allFormCounts.F1, totalRows: rows.length, share: rows.length > 0 ? allFormCounts.F1 / rows.length : null };

  for (const strat of ["A", "B"]) {
    const resolvedInStrat = byClass.RESOLVED.filter((r) => r.strat === strat);
    const noBuyerInStrat = byClass.NO_BUYER.filter((r) => r.strat === strat).length; // NO_BUYER share is per-stratum too (TESTER-SPEC.md v2.2, stage 7D task 4)
    result.strata[strat] = { ...computeStratumTables(resolvedInStrat), noBuyerInStratum: noBuyerInStrat };
  }

  // Task 5 (stage 7H): independence of observations -- distinct buyers, top-10 by
  // record count, and the same table1/table2 recomputed over one record per buyer
  // (earliest by t). Section 14(г): "radar useful" requires BOTH the main table above
  // AND this deduplicated one to independently say so (evaluateClusteredUsefulness).
  const dedupedResolved = oneRecordPerBuyer(byClass.RESOLVED);
  result.buyerIndependence = {
    distinctBuyers: countDistinctBuyers(byClass.RESOLVED),
    topBuyers: topBuyers(byClass.RESOLVED, 10),
    oneRecordPerBuyerStrata: {},
  };
  for (const strat of ["A", "B"]) {
    const dedupedInStrat = dedupedResolved.filter((r) => r.strat === strat);
    result.buyerIndependence.oneRecordPerBuyerStrata[strat] = computeStratumTables(dedupedInStrat);
  }
  for (const strat of ["A", "B"]) {
    for (const tableKey of ["table1", "table2"]) {
      result.strata[strat][tableKey].clusteredStatus = evaluateClusteredUsefulness(
        result.strata[strat][tableKey].status,
        result.buyerIndependence.oneRecordPerBuyerStrata[strat][tableKey].status
      );
    }
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
  lines.push(`  Доля формы F1 («незнакомые покупатели», заблокированы до проверки токена, PREREGISTRATION.md section 14д) от ВСЕХ записей: ${result.f1Share.count}/${result.f1Share.totalRows}${result.f1Share.share !== null ? ` (${(result.f1Share.share * 100).toFixed(2)}%)` : ""}`);
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
      lines.push(`    Кластеризация (PREREGISTRATION.md section 14г, требует того же статуса во вторичной таблице «одна запись на покупателя»): ${t.clusteredStatus}`);
    }
  }

  lines.push("");
  lines.push("=== Независимость наблюдений (PREREGISTRATION.md section 14в/г, task 5 stage 7H) ===");
  lines.push(`  Различных покупателей (RESOLVED, обе страты): ${result.buyerIndependence.distinctBuyers}`);
  lines.push("  Топ-10 покупателей по числу записей:");
  for (const b of result.buyerIndependence.topBuyers) {
    lines.push(`    ${b.buyer}: ${b.count}`);
  }
  for (const strat of ["A", "B"]) {
    const s = result.buyerIndependence.oneRecordPerBuyerStrata[strat];
    lines.push("");
    lines.push(`  --- Одна запись на покупателя (самая ранняя), страт ${strat} ---`);
    lines.push(`  RESOLVED (DANGEROUS+SAFE): ${s.resolvedCount}, из них DANGEROUS: ${s.totalDangerous}`);
    for (const [tableName, t] of [["Таблица 1", s.table1], ["Таблица 2", s.table2]]) {
      lines.push(`  ${tableName}: ${t.status}${t.reason ? " -- " + t.reason : ""}`);
      lines.push(`    Заблокировано: ${formatCI(t.ciBlock)}`);
      lines.push(`    Пропущено:     ${formatCI(t.ciPass)}`);
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
      console.log(formatCountersOnlyReport(rows, loadSkipCounters(db), countErrorLogs(db), loadPoolCandidates(db)));
    } else {
      const result = analyze(rows);
      console.log(formatReport(result));
      console.log("");
      console.log("=== skip_counters (task 3 stage 7F, по всем датам суммарно) ===");
      console.log(formatSkipCountersReport(loadSkipCounters(db)));
      console.log("");
      console.log("=== pool_candidates -- увидено/выбрано по часам UTC (task 3 stage 7H) ===");
      console.log(formatPoolCandidatesByHourReport(loadPoolCandidates(db)));
      console.log("");
      console.log("=== seen_at (pool_candidates) минус t: распределение в минутах (task 3 stage 7L) ===");
      console.log(formatSeenAtVsTGapReport(rows, loadPoolCandidates(db)));
    }
  } finally {
    db.close();
  }
}
