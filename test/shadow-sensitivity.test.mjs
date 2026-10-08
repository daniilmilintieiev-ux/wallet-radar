import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  THRESHOLDS,
  EXPLORATORY_HEADER,
  extractRiskScore,
  classifyThresholdBucket,
  computeAgreementAtT30,
  runSensitivityAnalysis,
  formatSensitivityReport,
  formatCountersOnlySensitivityReport,
} from "../scripts/shadow/sensitivity.mjs";
import {
  openDb,
  insertTrade,
  updateTradeOutcome,
  recordPoolCandidate,
} from "../scripts/shadow/db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SENSITIVITY_SCRIPT = path.resolve(__dirname, "../scripts/shadow/sensitivity.mjs");

describe("Shadow Sensitivity Analysis Unit Tests (Section 22, synthetic data)", () => {
  // --- (a) Boundary check ---
  test("(a) граница порога: riskScore ровно 30 не заблокирован при T=30, 31 заблокирован", () => {
    const row30 = {
      buyer: "BuyerA",
      radar_verdict: JSON.stringify({ action: "allow", riskScore: 30 }),
    };
    const row31 = {
      buyer: "BuyerB",
      radar_verdict: JSON.stringify({ action: "block", riskScore: 31 }),
    };
    const row29 = {
      buyer: "BuyerC",
      radar_verdict: JSON.stringify({ action: "allow", riskScore: 29 }),
    };

    assert.equal(classifyThresholdBucket(row30, 30), "PASSED", "riskScore=30 must be PASSED at T=30 (strict inequality > 30)");
    assert.equal(classifyThresholdBucket(row31, 30), "BLOCKED", "riskScore=31 must be BLOCKED at T=30");
    assert.equal(classifyThresholdBucket(row29, 30), "PASSED", "riskScore=29 must be PASSED at T=30");

    // Also check other thresholds in closed set
    assert.equal(classifyThresholdBucket(row30, 20), "BLOCKED", "riskScore=30 is BLOCKED at T=20");
    assert.equal(classifyThresholdBucket(row30, 40), "PASSED", "riskScore=30 is PASSED at T=40");
  });

  // --- (b) Sampling frame violation exclusion ---
  test("(b) запись с разрывом больше 1000 минут исключается", () => {
    const db = openDb(":memory:");
    const seenAtIso = "2026-10-01T12:00:00.000Z";

    // Candidate 1: gap = 1001 minutes (> 1000) -> must be excluded
    recordPoolCandidate(db, {
      cycleTs: seenAtIso,
      pool: "PAIR_EXCLUDED",
      mint: "MINT_EXCLUDED",
      seenAt: seenAtIso,
      selected: 1,
    });
    const tExcluded = Math.floor(Date.parse(seenAtIso) / 1000) - 1001 * 60;
    const { lastInsertRowid: idEx } = insertTrade(db, {
      mint: "MINT_EXCLUDED",
      pair: "PAIR_EXCLUDED",
      t: tExcluded,
      strat: "A",
      buyer: "BuyerExcluded",
      radar_verdict: JSON.stringify({ action: "block", riskScore: 80 }),
    });
    updateTradeOutcome(db, idEx, "DANGEROUS", null);

    // Candidate 2: gap = 500 minutes (<= 1000) -> included
    recordPoolCandidate(db, {
      cycleTs: seenAtIso,
      pool: "PAIR_INCLUDED",
      mint: "MINT_INCLUDED",
      seenAt: seenAtIso,
      selected: 1,
    });
    const tIncluded = Math.floor(Date.parse(seenAtIso) / 1000) - 500 * 60;
    const { lastInsertRowid: idIn } = insertTrade(db, {
      mint: "MINT_INCLUDED",
      pair: "PAIR_INCLUDED",
      t: tIncluded,
      strat: "A",
      buyer: "BuyerIncluded",
      radar_verdict: JSON.stringify({ action: "allow", riskScore: 10 }),
    });
    updateTradeOutcome(db, idIn, "SAFE", null);

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const poolCandidates = db.prepare("SELECT * FROM pool_candidates").all();

    const result = runSensitivityAnalysis(rows, poolCandidates);
    assert.equal(result.excludedSamplingFrame.count, 1, "exactly 1 row must be excluded");
    assert.equal(result.totalRows, 2);
    // Included row is present in stratum A
    assert.equal(result.evaluationsByThreshold[30].A.resolvedCount, 1);
    assert.equal(result.evaluationsByThreshold[30].A.table1.xBlock, 0);
    assert.equal(result.evaluationsByThreshold[30].A.table1.nPass, 1);
  });

  // --- (c) NO_BUYER and missing radar_verdict ---
  test("(c) NO_BUYER и записи без radar_verdict не попадают в blocked/passed", () => {
    const db = openDb(":memory:");

    // 1. NO_BUYER row
    insertTrade(db, {
      mint: "MINT_NO_BUYER",
      pair: "PAIR_NO_BUYER",
      t: 1000,
      strat: "A",
      buyer: null,
      radar_verdict: null,
    });

    // 2. Row with buyer but null radar_verdict (e.g. timeout / error)
    insertTrade(db, {
      mint: "MINT_NO_VERDICT",
      pair: "PAIR_NO_VERDICT",
      t: 1001,
      strat: "A",
      buyer: "BuyerNoVerdict",
      radar_verdict: null,
      radar_error: JSON.stringify({ error: "gateway timeout" }),
    });

    // 3. Row with invalid radar_verdict (no riskScore)
    const { lastInsertRowid: id3 } = insertTrade(db, {
      mint: "MINT_BAD_VERDICT",
      pair: "PAIR_BAD_VERDICT",
      t: 1002,
      strat: "A",
      buyer: "BuyerBadVerdict",
      radar_verdict: JSON.stringify({ action: "unknown" }),
    });
    updateTradeOutcome(db, id3, "SAFE", null);

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const result = runSensitivityAnalysis(rows, []);

    for (const T of THRESHOLDS) {
      const counters = result.countersByThreshold[T];
      assert.equal(counters.totalBlocked, 0, `at T=${T}, totalBlocked must be 0`);
      assert.equal(counters.totalPassed, 0, `at T=${T}, totalPassed must be 0`);
      assert.equal(counters.strata.A.noBuyer, 1);

      const evals = result.evaluationsByThreshold[T];
      assert.equal(evals.A.table1.nBlock, 0);
      assert.equal(evals.A.table1.nPass, 0);
      assert.equal(evals.A.unclassifiedCount, 1, "row with missing riskScore is UNCLASSIFIED in RESOLVED");
    }
  });

  // --- (d) Empty outcomes (outcome NULL) -> all statuses INSUFFICIENT_DATA and no NaN ---
  test("(d) при пустых исходах (outcome NULL) все статусы INSUFFICIENT_DATA и нет NaN", () => {
    const db = openDb(":memory:");

    // Insert 5 rows across strata A and B, all with outcome=NULL (pending)
    for (let i = 0; i < 5; i++) {
      insertTrade(db, {
        mint: `MINT_${i}`,
        pair: `PAIR_${i}`,
        t: 1000 + i * 10,
        strat: i % 2 === 0 ? "A" : "B",
        buyer: `Buyer_${i}`,
        radar_verdict: JSON.stringify({ action: i % 2 === 0 ? "block" : "allow", riskScore: i * 20 }),
      });
      // outcome is left NULL
    }

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const result = runSensitivityAnalysis(rows, []);

    // Check all threshold evaluations
    for (const T of THRESHOLDS) {
      for (const strat of ["A", "B"]) {
        const s = result.evaluationsByThreshold[T][strat];
        assert.equal(s.table1.status, "INSUFFICIENT_DATA");
        assert.equal(s.table2.status, "INSUFFICIENT_DATA");
        assert.equal(s.table1.clusteredStatus, "INSUFFICIENT_DATA");
        assert.equal(s.table2.clusteredStatus, "INSUFFICIENT_DATA");
        assert.equal(s.buyerIndependence.table1.status, "INSUFFICIENT_DATA");
        assert.equal(s.buyerIndependence.table2.status, "INSUFFICIENT_DATA");
      }
    }

    const report = formatSensitivityReport(result);
    assert.doesNotMatch(report, /NaN/, "report must never contain NaN");
  });

  // --- (e) --counters-only does not contain DANGEROUS, SAFE, RESOLVED ---
  test("(e) --counters-only не содержит слов DANGEROUS, SAFE, RESOLVED", () => {
    const db = openDb(":memory:");

    const { lastInsertRowid: id1 } = insertTrade(db, {
      mint: "MINT_1",
      pair: "PAIR_1",
      t: 1000,
      strat: "A",
      buyer: "Buyer1",
      radar_verdict: JSON.stringify({ action: "block", riskScore: 80 }),
    });
    updateTradeOutcome(db, id1, "DANGEROUS", null);

    const { lastInsertRowid: id2 } = insertTrade(db, {
      mint: "MINT_2",
      pair: "PAIR_2",
      t: 1001,
      strat: "A",
      buyer: "Buyer2",
      radar_verdict: JSON.stringify({ action: "allow", riskScore: 10 }),
    });
    updateTradeOutcome(db, id2, "SAFE", null);

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const result = runSensitivityAnalysis(rows, []);
    const countersReport = formatCountersOnlySensitivityReport(result);

    assert.doesNotMatch(countersReport, /DANGEROUS/, "--counters-only must not contain DANGEROUS");
    assert.doesNotMatch(countersReport, /SAFE/, "--counters-only must not contain SAFE");
    assert.doesNotMatch(countersReport, /RESOLVED/, "--counters-only must not contain RESOLVED");

    // But should contain the exploratory header and all thresholds
    assert.match(countersReport, /^EXPLORATORY ANALYSIS/);
    for (const T of THRESHOLDS) {
      assert.match(countersReport, new RegExp(`=== Порог T=${T} ===`));
    }
  });

  // --- (f) Output contains EXPLORATORY header, all 5 T values, and no 'best' or 'optimal' ---
  test("(f) вывод содержит первую строку EXPLORATORY и все пять значений T, и не содержит 'best' и 'optimal'", () => {
    const db = openDb(":memory:");
    const { lastInsertRowid: id } = insertTrade(db, {
      mint: "MINT_TEST",
      pair: "PAIR_TEST",
      t: 1000,
      strat: "A",
      buyer: "BuyerTest",
      radar_verdict: JSON.stringify({ action: "block", riskScore: 45 }),
    });
    updateTradeOutcome(db, id, "DANGEROUS", null);

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const result = runSensitivityAnalysis(rows, []);

    const fullReport = formatSensitivityReport(result);
    const countersReport = formatCountersOnlySensitivityReport(result);

    for (const rep of [fullReport, countersReport]) {
      // First line check
      const firstLine = rep.split("\n")[0];
      assert.equal(firstLine, EXPLORATORY_HEADER, "first line must match EXPLORATORY_HEADER");

      // All 5 thresholds check
      for (const T of [20, 30, 40, 50, 60]) {
        assert.match(rep, new RegExp(`T=${T}`), `must contain T=${T}`);
      }

      // No 'best' or 'optimal'
      assert.doesNotMatch(rep, /\bbest\b/i, "report must not contain the word 'best'");
      assert.doesNotMatch(rep, /\boptimal\b/i, "report must not contain the word 'optimal'");
    }
  });

  // --- (g) Unknown threshold arguments are rejected ---
  test("(g) неизвестные аргументы порогов отвергаются", () => {
    // 1. Passing a custom threshold option
    const r1 = spawnSync(process.execPath, [SENSITIVITY_SCRIPT, "--db=:memory:", "--threshold=25"], {
      encoding: "utf8",
    });
    assert.notEqual(r1.status, 0, "must exit non-zero for --threshold=25");
    assert.match(r1.stderr, /Unknown or rejected argument|closed/i);

    // 2. Passing --thresholds=...
    const r2 = spawnSync(process.execPath, [SENSITIVITY_SCRIPT, "--db=:memory:", "--thresholds=20,30"], {
      encoding: "utf8",
    });
    assert.notEqual(r2.status, 0, "must exit non-zero for --thresholds");

    // 3. Passing -T=...
    const r3 = spawnSync(process.execPath, [SENSITIVITY_SCRIPT, "--db=:memory:", "-T=30"], {
      encoding: "utf8",
    });
    assert.notEqual(r3.status, 0, "must exit non-zero for -T");

    // 4. Missing --db argument
    const r4 = spawnSync(process.execPath, [SENSITIVITY_SCRIPT], {
      encoding: "utf8",
    });
    assert.notEqual(r4.status, 0, "must exit non-zero when --db is missing");
    assert.match(r4.stderr, /Missing required argument: --db=/i);
  });

  // --- Agreement calculation test ---
  test("computeAgreementAtT30: computes agreement between primary bucket and T=30 risk score", () => {
    const rows = [
      // Agree: primary=BLOCKED, score=80 (>30 -> BLOCKED)
      { buyer: "B1", radar_verdict: JSON.stringify({ action: "block", riskScore: 80 }) },
      // Agree: primary=VERIFIED_SAFE, score=10 (<=30 -> PASSED)
      { buyer: "B2", radar_verdict: JSON.stringify({ action: "allow", riskScore: 10 }) },
      // Agree: primary=LOW_TRUST_WARMING, score=20 (<=30 -> PASSED)
      { buyer: "B3", radar_verdict: JSON.stringify({ action: "throttle", riskScore: 20 }) },
      // Differ: primary=BLOCKED (e.g. token freeze), but riskScore=15 (<=30)
      { buyer: "B4", radar_verdict: JSON.stringify({ action: "block", riskScore: 15 }) },
      // Differ: primary=LOW_TRUST_WARMING, but riskScore=50 (>30)
      { buyer: "B5", radar_verdict: JSON.stringify({ action: "throttle", riskScore: 50 }) },
      // Unclassified action: excluded from total
      { buyer: "B6", radar_verdict: JSON.stringify({ action: "invalid" }) },
    ];

    const ag = computeAgreementAtT30(rows);
    assert.equal(ag.total, 5);
    assert.equal(ag.agreed, 3);
    assert.equal(ag.differing, 2);
  });
});
