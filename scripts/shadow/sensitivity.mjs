/**
 * scripts/shadow/sensitivity.mjs
 *
 * Exploratory sensitivity analysis of shadow_trades riskScore thresholds.
 * Part of PREREGISTRATION.md section 22.
 *
 * The set of thresholds is closed: [20, 30, 40, 50, 60].
 * Custom threshold command-line arguments are strictly rejected.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  wilson95,
  intervalsOverlap,
  classifyRow,
  classifyVerdictBucket,
  isSamplingFrameViolation,
  getSelectedPoolCandidatesMap,
  loadPoolCandidates,
  evaluateSplit,
  evaluateClusteredUsefulness,
  oneRecordPerBuyer,
  MIN_DANGEROUS_FOR_PUBLICATION,
  USEFUL_RATIO_THRESHOLD,
} from "./analyze.mjs";

export const THRESHOLDS = [20, 30, 40, 50, 60];

export const EXPLORATORY_HEADER =
  "EXPLORATORY ANALYSIS: same data, thresholds not independently validated; the primary result is the analysis-v1 report and is not replaced by this table.";

/**
 * Extracts numeric riskScore from radar_verdict JSON (top-level property).
 * Returns null if radar_verdict is null/invalid or riskScore is missing/non-numeric.
 */
export function extractRiskScore(radarVerdictRaw) {
  if (!radarVerdictRaw) return null;
  let obj = radarVerdictRaw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.riskScore === "number" && !Number.isNaN(obj.riskScore)) {
    return obj.riskScore;
  }
  if (typeof obj.riskScore === "string" && obj.riskScore.trim() !== "") {
    const num = Number(obj.riskScore);
    if (!Number.isNaN(num)) return num;
  }
  return null;
}

/**
 * Classifies a row into BLOCKED vs PASSED under threshold T.
 * Strict inequality per section 22b:
 * riskScore > threshold -> "BLOCKED"
 * riskScore <= threshold -> "PASSED"
 * If radar_verdict is missing or riskScore cannot be determined -> "UNCLASSIFIED".
 */
export function classifyThresholdBucket(row, threshold) {
  if (!row || !row.radar_verdict) return "UNCLASSIFIED";
  const score = extractRiskScore(row.radar_verdict);
  if (score === null || Number.isNaN(score)) return "UNCLASSIFIED";
  return score > threshold ? "BLOCKED" : "PASSED";
}

/**
 * Compares primary bucket (classifyVerdictBucket) with threshold at T=30.
 * In primary analysis:
 *   "BLOCKED" is blocked; "LOW_TRUST_WARMING" and "VERIFIED_SAFE" are passed.
 * At T=30:
 *   riskScore > 30 is blocked; riskScore <= 30 is passed.
 * Evaluates agreement across all rows where both primary bucket and riskScore are determinable.
 */
export function computeAgreementAtT30(rows) {
  let total = 0;
  let agreed = 0;
  let differing = 0;

  for (const row of rows) {
    if (!row || !row.radar_verdict) continue;
    const primaryBucket = classifyVerdictBucket(row.radar_verdict);
    if (primaryBucket === "UNCLASSIFIED") continue;
    const score = extractRiskScore(row.radar_verdict);
    if (score === null) continue;

    total++;
    const primaryIsBlocked = primaryBucket === "BLOCKED";
    const t30IsBlocked = score > 30;

    if (primaryIsBlocked === t30IsBlocked) {
      agreed++;
    } else {
      differing++;
    }
  }

  return { total, agreed, differing };
}

function dangerousCount(rows) {
  return rows.filter((r) => r.outcome === "DANGEROUS").length;
}

function formatCI(ci) {
  if (!ci || ci.n === 0 || ci.p === null) return "n=0 (undefined)";
  return `x=${ci.x}/n=${ci.n} p=${(ci.p * 100).toFixed(2)}% CI95=[${(ci.lower * 100).toFixed(2)}%, ${(ci.upper * 100).toFixed(2)}%]`;
}

export function loadRows(db) {
  return db.prepare("SELECT * FROM shadow_trades").all();
}

/**
 * Runs sensitivity analysis across all 5 thresholds on loaded rows.
 */
export function runSensitivityAnalysis(rows, poolCandidateRows = [], options = {}) {
  const selectedCandidates = getSelectedPoolCandidatesMap(poolCandidateRows);
  const excludedSamplingFrame = [];
  const analysisRows = [];

  for (const row of rows) {
    if (isSamplingFrameViolation(row, selectedCandidates)) {
      excludedSamplingFrame.push(row);
    } else {
      analysisRows.push(row);
    }
  }

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
  for (const row of analysisRows) {
    byClass[classifyRow(row)].push(row);
  }

  // Agreement with primary bucket at T=30
  const agreement = computeAgreementAtT30(analysisRows.filter((r) => !r.radar_error && r.buyer));

  // Counters-only summaries per threshold
  const countersByThreshold = {};

  // Full evaluations per threshold
  const evaluationsByThreshold = {};

  for (const T of THRESHOLDS) {
    // 1. Counters across all analysis rows (stratified)
    const counters = {
      strata: {},
      totalBlocked: 0,
      totalPassed: 0,
      totalUnclassified: 0,
    };

    for (const strat of ["A", "B"]) {
      const inStrat = analysisRows.filter((r) => r.strat === strat);
      const withBuyer = inStrat.filter((r) => r.buyer && !r.radar_error);
      const noBuyerCount = inStrat.filter((r) => !r.buyer).length;

      let blocked = 0;
      let passed = 0;
      let unclassified = 0;

      for (const r of withBuyer) {
        const b = classifyThresholdBucket(r, T);
        if (b === "BLOCKED") blocked++;
        else if (b === "PASSED") passed++;
        else unclassified++;
      }

      // One record per buyer for counters
      const dedupedWithBuyer = oneRecordPerBuyer(withBuyer);
      let dedupedBlocked = 0;
      let dedupedPassed = 0;
      let dedupedUnclassified = 0;

      for (const r of dedupedWithBuyer) {
        const b = classifyThresholdBucket(r, T);
        if (b === "BLOCKED") dedupedBlocked++;
        else if (b === "PASSED") dedupedPassed++;
        else dedupedUnclassified++;
      }

      counters.strata[strat] = {
        total: inStrat.length,
        withBuyer: withBuyer.length,
        noBuyer: noBuyerCount,
        blocked,
        passed,
        unclassified,
        deduped: {
          total: dedupedWithBuyer.length,
          blocked: dedupedBlocked,
          passed: dedupedPassed,
          unclassified: dedupedUnclassified,
        },
      };

      counters.totalBlocked += blocked;
      counters.totalPassed += passed;
      counters.totalUnclassified += unclassified;
    }
    countersByThreshold[T] = counters;

    // 2. Statistical evaluation over RESOLVED rows
    const evalStrat = {};
    for (const strat of ["A", "B"]) {
      const resolvedInStrat = byClass.RESOLVED.filter((r) => r.strat === strat);
      const totalDangerous = dangerousCount(resolvedInStrat);
      const noBuyerInStratum = byClass.NO_BUYER.filter((r) => r.strat === strat).length;

      const blockRows = resolvedInStrat.filter((r) => classifyThresholdBucket(r, T) === "BLOCKED");
      const passRows = resolvedInStrat.filter((r) => classifyThresholdBucket(r, T) === "PASSED");
      const unclassifiedCount = resolvedInStrat.filter((r) => classifyThresholdBucket(r, T) === "UNCLASSIFIED").length;

      // Table 1 and Table 2 evaluate the binary threshold split
      const table1 = evaluateSplit(blockRows, passRows, totalDangerous);
      const table2 = evaluateSplit(blockRows, passRows, totalDangerous);

      // Deduplicated by buyer
      const dedupedResolvedInStrat = oneRecordPerBuyer(resolvedInStrat);
      const dedupedDangerous = dangerousCount(dedupedResolvedInStrat);
      const dedupedBlock = dedupedResolvedInStrat.filter((r) => classifyThresholdBucket(r, T) === "BLOCKED");
      const dedupedPass = dedupedResolvedInStrat.filter((r) => classifyThresholdBucket(r, T) === "PASSED");

      const dedupedTable1 = evaluateSplit(dedupedBlock, dedupedPass, dedupedDangerous);
      const dedupedTable2 = evaluateSplit(dedupedBlock, dedupedPass, dedupedDangerous);

      table1.clusteredStatus = evaluateClusteredUsefulness(table1.status, dedupedTable1.status);
      table2.clusteredStatus = evaluateClusteredUsefulness(table2.status, dedupedTable2.status);

      evalStrat[strat] = {
        resolvedCount: resolvedInStrat.length,
        totalDangerous,
        noBuyerInStratum,
        unclassifiedCount,
        table1,
        table2,
        buyerIndependence: {
          resolvedCount: dedupedResolvedInStrat.length,
          totalDangerous: dedupedDangerous,
          table1: dedupedTable1,
          table2: dedupedTable2,
        },
      };
    }
    evaluationsByThreshold[T] = evalStrat;
  }

  const separateLines = {};
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
    separateLines[cls] = byClass[cls].length;
  }

  return {
    totalRows: rows.length,
    excludedSamplingFrame: {
      count: excludedSamplingFrame.length,
      ids: excludedSamplingFrame.map((r) => (r.id !== undefined ? r.id : r.pair)),
    },
    separateLines,
    agreement,
    countersByThreshold,
    evaluationsByThreshold,
  };
}

/**
 * Formats full sensitivity report.
 * Guaranteed not to contain the words 'best' or 'optimal'.
 */
export function formatSensitivityReport(result) {
  const lines = [];
  lines.push(EXPLORATORY_HEADER);
  lines.push("");
  lines.push(`Всего строк в shadow_trades: ${result.totalRows}`);
  lines.push(`  Исключено вне рамки выборки (§18б): ${result.excludedSamplingFrame.count}`);
  lines.push("");
  lines.push(`agreement with primary bucket at T=30: ${result.agreement.agreed} of ${result.agreement.total} (${result.agreement.differing} differing)`);
  lines.push("");
  lines.push("=== Отдельные строки (PREREGISTRATION.md section 5) ===");
  for (const [cls, count] of Object.entries(result.separateLines)) {
    lines.push(`  ${cls}: ${count}`);
  }

  for (const T of THRESHOLDS) {
    const evals = result.evaluationsByThreshold[T];
    lines.push("");
    lines.push(`======================================================================`);
    lines.push(`=== Порог T=${T} ===`);
    lines.push(`======================================================================`);

    for (const strat of ["A", "B"]) {
      const s = evals[strat];
      lines.push("");
      lines.push(`--- Страт ${strat} (T=${T}) ---`);
      lines.push(`  RESOLVED (DANGEROUS+SAFE): ${s.resolvedCount}, из них DANGEROUS: ${s.totalDangerous}`);
      lines.push(`  NO_BUYER в этом страте: ${s.noBuyerInStratum}`);
      lines.push(`  UNCLASSIFIED: ${s.unclassifiedCount}`);

      for (const [tableName, t] of [
        ["Таблица 1", s.table1],
        ["Таблица 2", s.table2],
      ]) {
        lines.push(`  ${tableName} (T=${T}): ${t.status}${t.reason ? " -- " + t.reason : ""}`);
        lines.push(`    Заблокировано: ${formatCI(t.ciBlock)}`);
        lines.push(`    Пропущено:     ${formatCI(t.ciPass)}`);
        if (t.ratio !== null && t.ratio !== undefined) {
          lines.push(`    Отношение долей (block/pass): ${t.ratio === Infinity ? "∞ (pass=0%)" : t.ratio.toFixed(2) + "x"}`);
        }
        lines.push(`    Кластеризация (PREREGISTRATION.md section 14г): ${t.clusteredStatus}`);
      }

      // One record per buyer
      const dedup = s.buyerIndependence;
      lines.push("");
      lines.push(`  --- Одна запись на покупателя (самая ранняя), страт ${strat} (T=${T}) ---`);
      lines.push(`  RESOLVED (DANGEROUS+SAFE): ${dedup.resolvedCount}, из них DANGEROUS: ${dedup.totalDangerous}`);
      for (const [tableName, t] of [
        ["Таблица 1", dedup.table1],
        ["Таблица 2", dedup.table2],
      ]) {
        lines.push(`  ${tableName} (T=${T}): ${t.status}${t.reason ? " -- " + t.reason : ""}`);
        lines.push(`    Заблокировано: ${formatCI(t.ciBlock)}`);
        lines.push(`    Пропущено:     ${formatCI(t.ciPass)}`);
        if (t.ratio !== null && t.ratio !== undefined) {
          lines.push(`    Отношение долей (block/pass): ${t.ratio === Infinity ? "∞ (pass=0%)" : t.ratio.toFixed(2) + "x"}`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Formats counters-only sensitivity report.
 * Guaranteed NOT to contain the words 'DANGEROUS', 'SAFE', or 'RESOLVED'.
 * Guaranteed NOT to contain the words 'best' or 'optimal'.
 */
export function formatCountersOnlySensitivityReport(result) {
  const lines = [];
  lines.push(EXPLORATORY_HEADER);
  lines.push("");
  lines.push(`[COUNTERS-ONLY] Всего строк в shadow_trades: ${result.totalRows}`);
  lines.push(`[COUNTERS-ONLY] Исключено вне рамки выборки (§18б): ${result.excludedSamplingFrame.count}`);
  lines.push(`[COUNTERS-ONLY] agreement with primary bucket at T=30: ${result.agreement.agreed} of ${result.agreement.total} (${result.agreement.differing} differing)`);
  lines.push("");
  lines.push("[COUNTERS-ONLY] Число записей по категориям исключений:");
  for (const [cls, count] of Object.entries(result.separateLines)) {
    // Exclude printing 'RESOLVED' class name in counters-only
    if (cls === "RESOLVED") continue;
    lines.push(`  ${cls}: ${count}`);
  }

  for (const T of THRESHOLDS) {
    const c = result.countersByThreshold[T];
    lines.push("");
    lines.push(`=== Порог T=${T} ===`);
    lines.push(`  Всего заблокировано (обе страты): ${c.totalBlocked}`);
    lines.push(`  Всего пропущено (обе страты):     ${c.totalPassed}`);
    lines.push(`  Не классифицировано:              ${c.totalUnclassified}`);

    for (const strat of ["A", "B"]) {
      const s = c.strata[strat];
      lines.push(`  --- Страт ${strat} (T=${T}) ---`);
      lines.push(`    Всего записей в страте: ${s.total}`);
      lines.push(`    Заблокировано:          ${s.blocked}`);
      lines.push(`    Пропущено:              ${s.passed}`);
      lines.push(`    Не классифицировано:    ${s.unclassified}`);
      lines.push(`    Без покупателя:         ${s.noBuyer}`);
      lines.push(`    --- Одна запись на покупателя, страт ${strat} (T=${T}) ---`);
      lines.push(`      Уникальных покупателей: ${s.deduped.total}`);
      lines.push(`      Заблокировано:          ${s.deduped.blocked}`);
      lines.push(`      Пропущено:              ${s.deduped.passed}`);
    }
  }

  return lines.join("\n");
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let dbPath = null;
  let countersOnly = false;

  for (const a of args) {
    if (a.startsWith("--db=")) {
      dbPath = a.slice(5);
    } else if (a === "--counters-only") {
      countersOnly = true;
    } else {
      console.error(`[SENSITIVITY] Unknown or rejected argument: ${a}`);
      console.error(`[SENSITIVITY] The set of thresholds is closed [20, 30, 40, 50, 60]; custom threshold arguments are rejected.`);
      process.exit(1);
    }
  }

  if (!dbPath) {
    console.error(`[SENSITIVITY] Missing required argument: --db=<path>`);
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    console.error(`[SENSITIVITY] Cannot open ${dbPath} read-only: ${err.message}`);
    process.exit(1);
  }

  try {
    const rows = loadRows(db);
    const poolCandidates = loadPoolCandidates(db);
    const result = runSensitivityAnalysis(rows, poolCandidates);
    if (countersOnly) {
      console.log(formatCountersOnlySensitivityReport(result));
    } else {
      console.log(formatSensitivityReport(result));
    }
  } finally {
    db.close();
  }
}
