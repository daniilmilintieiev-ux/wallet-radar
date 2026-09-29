import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  wilson95,
  intervalsOverlap,
  classifyVerdictBucket,
  classifyResponseForm,
  countRowsByForm,
  dangerousShareByForm,
  simulationSplit,
  classifyRow,
  splitTables,
  evaluateSplit,
  analyze,
  formatReport,
  formatCountersOnlyReport,
  countErrorLogs,
  MIN_DANGEROUS_FOR_PUBLICATION,
  loadSkipCounters,
  summarizeSkipCounters,
  formatSkipCountersReport,
  loadPoolCandidates,
  summarizePoolCandidatesByHour,
  formatPoolCandidatesByHourReport,
  countDistinctBuyers,
  topBuyers,
  oneRecordPerBuyer,
  evaluateClusteredUsefulness,
} from "../scripts/shadow/analyze.mjs";
import { openDb, insertTrade, updateTradeOutcome, incrementSkipCounter, getSkipCounters, logError, recordPoolCandidate } from "../scripts/shadow/db.mjs";

describe("Shadow Analyze Unit Tests (read-only, offline)", () => {
  // --- Wilson score interval, control values independently verified by hand
  // computation (PREREGISTRATION.md section 4.4 formula), not fitted to these numbers. ---

  test("wilson95: 0 of 10 -> approximately [0, 0.2775]", () => {
    const ci = wilson95(0, 10);
    assert.equal(ci.lower, 0);
    assert.ok(Math.abs(ci.upper - 0.2775) < 0.001, `expected ~0.2775, got ${ci.upper}`);
  });

  test("wilson95: 5 of 10 -> approximately [0.2366, 0.7634]", () => {
    const ci = wilson95(5, 10);
    assert.ok(Math.abs(ci.lower - 0.2366) < 0.001, `expected ~0.2366, got ${ci.lower}`);
    assert.ok(Math.abs(ci.upper - 0.7634) < 0.001, `expected ~0.7634, got ${ci.upper}`);
  });

  test("wilson95: n=0 returns nulls, not a fabricated interval", () => {
    const ci = wilson95(0, 0);
    assert.equal(ci.p, null);
    assert.equal(ci.lower, null);
    assert.equal(ci.upper, null);
  });

  test("wilson95: 10 of 10 -> upper bound is 1, lower bound < 1 (not a degenerate [1,1])", () => {
    const ci = wilson95(10, 10);
    assert.equal(ci.upper, 1);
    assert.ok(ci.lower > 0.6 && ci.lower < 1);
  });

  test("intervalsOverlap: detects overlap and non-overlap correctly", () => {
    assert.equal(intervalsOverlap({ lower: 0.1, upper: 0.3 }, { lower: 0.2, upper: 0.4 }), true);
    assert.equal(intervalsOverlap({ lower: 0.1, upper: 0.2 }, { lower: 0.5, upper: 0.6 }), false);
    assert.equal(intervalsOverlap({ lower: null, upper: null }, { lower: 0.1, upper: 0.2 }), null);
  });

  // --- Bucket classification (PREREGISTRATION.md section 4.1) ---

  test("classifyVerdictBucket: block/manual_review -> BLOCKED, throttle -> LOW_TRUST_WARMING, allow -> VERIFIED_SAFE, else UNCLASSIFIED (never null, task 4 stage 7F)", () => {
    assert.equal(classifyVerdictBucket(JSON.stringify({ action: "block" })), "BLOCKED");
    assert.equal(classifyVerdictBucket(JSON.stringify({ action: "manual_review" })), "BLOCKED");
    assert.equal(classifyVerdictBucket(JSON.stringify({ action: "throttle" })), "LOW_TRUST_WARMING");
    assert.equal(classifyVerdictBucket(JSON.stringify({ action: "allow" })), "VERIFIED_SAFE");
    assert.equal(classifyVerdictBucket(null), "UNCLASSIFIED");
    assert.equal(classifyVerdictBucket("not json{"), "UNCLASSIFIED");
    assert.equal(classifyVerdictBucket(JSON.stringify({ action: "something_new" })), "UNCLASSIFIED");
  });

  // --- Task 4 (stage 7F): one test per actual toolGateCopy return branch (src/http-server.ts),
  // using the real field shape each branch produces, cited by line range. ---

  test("classifyVerdictBucket: branch 1, trustResult.verdict==='hold' (http-server.ts:443-454) -> BLOCKED, no details.simulation", () => {
    const body = { allow: false, reason: "BLOCKED by pre-trade firewall: ...", action: "block", riskScore: 80, maxSafeAmountUsd: 0, executionTier: "blocked", details: { trust: { verdict: "hold", riskScore: 80 } } };
    assert.equal(classifyVerdictBucket(body), "BLOCKED");
    assert.equal(body.details.simulation, undefined, "sanity: this branch never populates details.simulation");
  });

  test("classifyVerdictBucket: branch 2, trustResult.verdict==='unknown' (http-server.ts:455-464) -> BLOCKED, no details.simulation", () => {
    const body = { allow: false, reason: "HOLD: insufficient historical data...", action: "manual_review", riskScore: 0, maxSafeAmountUsd: 0, details: { trust: { verdict: "unknown" } } };
    assert.equal(classifyVerdictBucket(body), "BLOCKED");
    assert.equal(body.details.simulation, undefined);
  });

  test("classifyVerdictBucket: branch 3, isBlocked (http-server.ts:493-505) -> BLOCKED, details.simulation present", () => {
    const body = {
      allow: false,
      reason: "BLOCKED: simulated payment exceeds risk capacity (...)",
      action: "block",
      riskScore: 90,
      maxSafeAmountUsd: 0,
      executionTier: "blocked",
      slippageToleranceBps: 0,
      cooldownSec: 300,
      details: { trust: { verdict: "safe" }, simulation: { wouldTrigger: ["TOXIC_MINT"], decision: { action: "block" } } },
    };
    assert.equal(classifyVerdictBucket(body), "BLOCKED");
  });

  test("classifyVerdictBucket: branch 4, isThrottled (http-server.ts:507-520) -> LOW_TRUST_WARMING, allow:true", () => {
    const body = {
      allow: true,
      reason: "THROTTLED: payment permitted up to tiered limit",
      action: "throttle",
      riskScore: 40,
      maxSafeAmountUsd: 25,
      executionTier: "guarded",
      slippageToleranceBps: 50,
      cooldownSec: 60,
      details: { trust: { verdict: "safe" }, simulation: { wouldTrigger: [], decision: { action: "throttle" } } },
    };
    assert.equal(classifyVerdictBucket(body), "LOW_TRUST_WARMING");
    assert.equal(body.allow, true, "sanity: throttled trades DO execute, per PREREGISTRATION.md section 4.1's table");
  });

  test("classifyVerdictBucket: branch 5, !simRes.safeToExecute (http-server.ts:522-534) -> BLOCKED (folded from manual_review), allow:false", () => {
    const body = {
      allow: false,
      reason: "HOLD: simulated payment cannot be safely executed as requested",
      action: "manual_review",
      riskScore: 55,
      maxSafeAmountUsd: 0,
      executionTier: "standard",
      slippageToleranceBps: 50,
      cooldownSec: 60,
      details: { trust: { verdict: "safe" }, simulation: { wouldTrigger: [], safeToExecute: false } },
    };
    assert.equal(classifyVerdictBucket(body), "BLOCKED");
  });

  test("classifyVerdictBucket: branch 6, final VERIFIED_SAFE fallback (http-server.ts:538-548) -> VERIFIED_SAFE, allow:true", () => {
    const body = {
      allow: true,
      reason: "VERIFIED_SAFE: risk 5 <= 30, liquidity $500 >= $50",
      action: "allow",
      riskScore: 5,
      maxSafeAmountUsd: 10,
      executionTier: "instant",
      slippageToleranceBps: 100,
      cooldownSec: 0,
      details: { trust: { verdict: "safe" }, simulation: { wouldTrigger: [] } },
    };
    assert.equal(classifyVerdictBucket(body), "VERIFIED_SAFE");
  });

  test("classifyVerdictBucket: branch 6a, final fallback WITHOUT simulation ever running (copyAmountUsd falsy) -> still VERIFIED_SAFE from action alone", () => {
    // toolGateCopy's `let simRes: any;` is declared but never assigned when
    // copyAmountUsd is undefined/<=0 -- details.simulation is `undefined` in this
    // specific sub-case of the same branch 6 return statement (http-server.ts:538-548).
    const body = { allow: true, reason: "VERIFIED_SAFE: ...", action: "allow", riskScore: 5, maxSafeAmountUsd: 100, executionTier: "instant", slippageToleranceBps: 100, cooldownSec: 0, details: { trust: { verdict: "safe" }, simulation: undefined } };
    assert.equal(classifyVerdictBucket(body), "VERIFIED_SAFE");
  });

  // --- Row classification (PREREGISTRATION.md section 5) ---

  test("classifyRow: RADAR_ERROR and NO_BUYER take priority, never fall through to outcome classes", () => {
    assert.equal(classifyRow({ radar_error: '{"error":"x"}', buyer: null, outcome: "DANGEROUS" }), "RADAR_ERROR");
    assert.equal(classifyRow({ radar_error: null, buyer: null, outcome: "SAFE" }), "NO_BUYER");
  });

  test("classifyRow: ISSUER_CONTROLLED, PAIR_MISSING, невосстановимо*, миграция, pending, resolved", () => {
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: "ISSUER_CONTROLLED" }), "ISSUER_CONTROLLED");
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: "PAIR_MISSING" }), "PAIR_MISSING");
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: "невосстановимо (ATA закрыт)" }), "IRRECOVERABLE");
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: "миграция, не исход" }), "MIGRATION_NOT_AN_OUTCOME");
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: null }), "PENDING");
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: "DANGEROUS" }), "RESOLVED");
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: "SAFE" }), "RESOLVED");
    assert.equal(classifyRow({ radar_error: null, buyer: "B", outcome: "something-unexpected" }), "UNKNOWN_OUTCOME");
  });

  // --- Table split (PREREGISTRATION.md sections 4.2/4.3) ---

  test("splitTables: throttle goes to 'pass' in table1, 'block' in table2", () => {
    const rows = [
      { bucket: "BLOCKED", id: 1 },
      { bucket: "LOW_TRUST_WARMING", id: 2 },
      { bucket: "VERIFIED_SAFE", id: 3 },
    ];
    const { table1, table2 } = splitTables(rows);
    assert.deepEqual(table1.block.map((r) => r.id), [1]);
    assert.deepEqual(table1.pass.map((r) => r.id).sort(), [2, 3]);
    assert.deepEqual(table2.block.map((r) => r.id).sort(), [1, 2]);
    assert.deepEqual(table2.pass.map((r) => r.id), [3]);
  });

  // --- evaluateSplit: section 4.5 (useful) / 4.6 (insufficient data) ---

  test("evaluateSplit: INSUFFICIENT_DATA when stratum has fewer than 30 DANGEROUS", () => {
    const block = Array.from({ length: 10 }, () => ({ outcome: "DANGEROUS" }));
    const pass = Array.from({ length: 10 }, () => ({ outcome: "SAFE" }));
    const res = evaluateSplit(block, pass, 10); // only 10 DANGEROUS total in stratum
    assert.equal(res.status, "INSUFFICIENT_DATA");
    assert.ok(res.reason.includes("10"));
  });

  test("evaluateSplit: RADAR_USEFUL when ratio >= 3x and CIs don't overlap, with >= 30 DANGEROUS", () => {
    // 40 DANGEROUS out of 40 blocked (p=1.0) vs 2 DANGEROUS out of 200 passed (p=0.01) -- huge, clean separation.
    const block = Array.from({ length: 40 }, () => ({ outcome: "DANGEROUS" }));
    const pass = [...Array.from({ length: 2 }, () => ({ outcome: "DANGEROUS" })), ...Array.from({ length: 198 }, () => ({ outcome: "SAFE" }))];
    const res = evaluateSplit(block, pass, 42);
    assert.equal(res.status, "RADAR_USEFUL");
    assert.ok(res.ratio >= 3);
  });

  test("evaluateSplit: DIFFERENCE_NOT_ESTABLISHED when >= 30 DANGEROUS but ratio/overlap conditions fail", () => {
    // Same DANGEROUS rate on both sides -- no real difference, despite plenty of data.
    const block = [...Array.from({ length: 15 }, () => ({ outcome: "DANGEROUS" })), ...Array.from({ length: 15 }, () => ({ outcome: "SAFE" }))];
    const pass = [...Array.from({ length: 15 }, () => ({ outcome: "DANGEROUS" })), ...Array.from({ length: 15 }, () => ({ outcome: "SAFE" }))];
    const res = evaluateSplit(block, pass, 30);
    assert.equal(res.status, "DIFFERENCE_NOT_ESTABLISHED");
  });

  // --- Full analyze() against a synthetic :memory: database ---

  test("analyze: summary over a synthetic :memory: database matches expected counts and classes", () => {
    const db = openDb(":memory:");
    let t = 1000;
    const baseTrade = (overrides) => ({
      mint: `Mint${t}`,
      pair: `Pair${t}`,
      t: t++,
      strat: "A",
      recorded_at: new Date().toISOString(),
      ...overrides,
    });

    // insertTrade never sets `outcome` (that column is only ever written later by
    // outcomes.mjs's updateTradeOutcome, by design -- see db.mjs's append-only comment).
    // This test helper mirrors that two-phase write for synthetic fixtures.
    const insertWithOutcome = (trade, outcome) => {
      const { lastInsertRowid } = insertTrade(db, trade);
      if (outcome !== undefined) updateTradeOutcome(db, lastInsertRowid, outcome, null);
      return lastInsertRowid;
    };

    // Strat A: 2 DANGEROUS blocked, 1 SAFE blocked, 1 DANGEROUS passed (allow), 2 SAFE passed (allow)
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B1", radar_verdict: { action: "block" } }), "DANGEROUS");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B2", radar_verdict: { action: "block" } }), "DANGEROUS");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B3", radar_verdict: { action: "block" } }), "SAFE");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B4", radar_verdict: { action: "allow" } }), "DANGEROUS");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B5", radar_verdict: { action: "allow" } }), "SAFE");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B6", radar_verdict: { action: "allow" } }), "SAFE");
    // Strat A: separate-line classes
    insertTrade(db, baseTrade({ strat: "A", buyer: null })); // NO_BUYER, outcome stays NULL
    insertTrade(db, baseTrade({ strat: "A", buyer: "B7", http_status: 503, radar_error: { error: "x" } })); // RADAR_ERROR
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B8", radar_verdict: { action: "allow" } }), "ISSUER_CONTROLLED");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B9", radar_verdict: { action: "allow" } }), "PAIR_MISSING");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B10", radar_verdict: { action: "allow" } }), "невосстановимо (ATA закрыт)");
    insertWithOutcome(baseTrade({ strat: "A", buyer: "B11", radar_verdict: { action: "allow" } }), "миграция, не исход");
    insertTrade(db, baseTrade({ strat: "A", buyer: "B12", radar_verdict: { action: "allow" } })); // PENDING (too young), outcome stays NULL
    // radar_token_check_missing distribution (four states, stage 7F task 2)
    insertWithOutcome(baseTrade({ strat: "B", buyer: "B13", radar_verdict: { action: "allow" }, radar_token_check_missing: true }), "SAFE");
    insertWithOutcome(baseTrade({ strat: "B", buyer: "B14", radar_verdict: { action: "allow" }, radar_token_check_missing: false }), "SAFE");
    insertWithOutcome(baseTrade({ strat: "B", buyer: "B15", radar_verdict: { action: "allow" }, radar_token_check_missing: "NOT_APPLICABLE" }), "SAFE");

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const result = analyze(rows);

    assert.equal(result.totalRows, 16);
    assert.equal(result.separateLines.NO_BUYER, 1);
    assert.equal(result.separateLines.RADAR_ERROR, 1);
    assert.equal(result.separateLines.ISSUER_CONTROLLED, 1);
    assert.equal(result.separateLines.PAIR_MISSING, 1);
    assert.equal(result.separateLines.IRRECOVERABLE, 1);
    assert.equal(result.separateLines.MIGRATION_NOT_AN_OUTCOME, 1);
    assert.equal(result.separateLines.PENDING, 1);
    assert.equal(result.separateLines.TOKEN_TOO_OLD, undefined, "TOKEN_TOO_OLD is not in shadow_trades at all -- now reported via skip_counters, not analyze()");

    assert.equal(result.strata.A.resolvedCount, 6); // the 6 DANGEROUS/SAFE rows only
    assert.equal(result.strata.A.totalDangerous, 3);
    assert.equal(result.strata.A.noBuyerInStratum, 1);

    // Table 1: block = {DANGEROUS,DANGEROUS,SAFE} (block action), pass = {DANGEROUS,SAFE,SAFE} (allow action)
    assert.equal(result.strata.A.table1.xBlock, 2);
    assert.equal(result.strata.A.table1.nBlock, 3);
    assert.equal(result.strata.A.table1.xPass, 1);
    assert.equal(result.strata.A.table1.nPass, 3);
    assert.equal(result.strata.A.table1.status, "INSUFFICIENT_DATA"); // only 3 DANGEROUS, far under 30

    assert.equal(result.radarTokenCheckMissing.true, 1);
    assert.equal(result.radarTokenCheckMissing.false, 1);
    assert.equal(result.radarTokenCheckMissing.NOT_APPLICABLE, 1);
    assert.equal(result.radarTokenCheckMissing["null (no verdict)"], 13);
  });

  test(`MIN_DANGEROUS_FOR_PUBLICATION constant is 30, per PREREGISTRATION.md section 4.6`, () => {
    assert.equal(MIN_DANGEROUS_FOR_PUBLICATION, 30);
  });

  // --- skip_counters (task 3 stage 7F): TOKEN_TOO_OLD/POOL_TOO_OLD/NO_BUYER/RADAR_ERROR/
  // PROCESSING_ERROR, persisted so analyze.mjs can recover them (previously impossible
  // for TOKEN_TOO_OLD, which never creates a shadow_trades row at all). ---

  test("incrementSkipCounter: accumulates across calls for the same (date, reason), separate rows per reason", () => {
    const db = openDb(":memory:");
    incrementSkipCounter(db, "TOKEN_TOO_OLD", 1, "2026-09-29");
    incrementSkipCounter(db, "TOKEN_TOO_OLD", 1, "2026-09-29");
    incrementSkipCounter(db, "TOKEN_TOO_OLD", 3, "2026-09-29");
    incrementSkipCounter(db, "NO_BUYER", 1, "2026-09-29");
    incrementSkipCounter(db, "TOKEN_TOO_OLD", 1, "2026-09-30"); // different date, separate row

    const rows = getSkipCounters(db);
    assert.equal(rows.length, 3);
    const byKey = Object.fromEntries(rows.map((r) => [`${r.date}:${r.reason}`, r.count]));
    assert.equal(byKey["2026-09-29:TOKEN_TOO_OLD"], 5);
    assert.equal(byKey["2026-09-29:NO_BUYER"], 1);
    assert.equal(byKey["2026-09-30:TOKEN_TOO_OLD"], 1);
  });

  test("summarizeSkipCounters: aggregates across all dates, by reason", () => {
    const rows = [
      { date: "2026-09-29", reason: "TOKEN_TOO_OLD", count: 5 },
      { date: "2026-09-30", reason: "TOKEN_TOO_OLD", count: 2 },
      { date: "2026-09-29", reason: "NO_BUYER", count: 1 },
    ];
    const summary = summarizeSkipCounters(rows);
    assert.deepEqual(summary, { TOKEN_TOO_OLD: 7, NO_BUYER: 1 });
  });

  test("formatSkipCountersReport: readable output, and an empty table is stated plainly, not left blank", () => {
    const report = formatSkipCountersReport([{ date: "2026-09-29", reason: "POOL_TOO_OLD", count: 4 }]);
    assert.match(report, /POOL_TOO_OLD: 4/);
    const emptyReport = formatSkipCountersReport([]);
    assert.match(emptyReport, /нет записей/);
  });

  test("loadSkipCounters: read-only query against a real (in-memory) database round-trips correctly", () => {
    const db = openDb(":memory:");
    incrementSkipCounter(db, "RADAR_ERROR", 2);
    incrementSkipCounter(db, "PROCESSING_ERROR", 1);
    const rows = loadSkipCounters(db);
    assert.equal(rows.length, 2);
    const summary = summarizeSkipCounters(rows);
    assert.equal(summary.RADAR_ERROR, 2);
    assert.equal(summary.PROCESSING_ERROR, 1);
  });

  // --- Task 1/2 (stage 7G): response forms F1..F6, simulation split, and the
  // --counters-only "look-ahead rule" mode. Reuses the same real branch shapes
  // toolGateCopy actually produces (src/http-server.ts), verified in stage 7F. ---

  const FORM_BODIES = {
    F1: { allow: false, action: "block", details: { trust: { verdict: "hold" } } },
    F2: { allow: false, action: "manual_review", details: { trust: { verdict: "unknown" } } },
    F3: { allow: false, action: "block", details: { trust: {}, simulation: { wouldTrigger: ["TOXIC_MINT"] } } },
    F4: { allow: true, action: "throttle", details: { trust: {}, simulation: { wouldTrigger: [] } } },
    F5: { allow: false, action: "manual_review", details: { trust: {}, simulation: { safeToExecute: false } } },
    F6: { allow: true, action: "allow", details: { trust: {}, simulation: { wouldTrigger: [] } } },
  };

  test("classifyResponseForm: recognizes each of F1..F6 from its real toolGateCopy shape, else UNCLASSIFIED", () => {
    for (const [form, body] of Object.entries(FORM_BODIES)) {
      assert.equal(classifyResponseForm(body), form, `expected ${form}`);
    }
    assert.equal(classifyResponseForm(null), "UNCLASSIFIED");
    assert.equal(classifyResponseForm("not json{"), "UNCLASSIFIED");
    assert.equal(classifyResponseForm({ action: "something_new" }), "UNCLASSIFIED");
  });

  test("countRowsByForm: counts across all rows without ever reading row.outcome (rows here have no outcome property at all)", () => {
    const rows = [
      { radar_verdict: JSON.stringify(FORM_BODIES.F1) },
      { radar_verdict: JSON.stringify(FORM_BODIES.F1) },
      { radar_verdict: JSON.stringify(FORM_BODIES.F4) },
      { radar_verdict: null }, // e.g. NO_BUYER/RADAR_ERROR row
    ];
    const counts = countRowsByForm(rows);
    assert.equal(counts.F1, 2);
    assert.equal(counts.F4, 1);
    assert.equal(counts.UNCLASSIFIED, 1);
    assert.equal(counts.F2 + counts.F3 + counts.F5 + counts.F6, 0);
  });

  test("dangerousShareByForm: per-form record count, DANGEROUS count, and Wilson CI, over RESOLVED rows only", () => {
    const resolvedRows = [
      { radar_verdict: JSON.stringify(FORM_BODIES.F1), outcome: "DANGEROUS" },
      { radar_verdict: JSON.stringify(FORM_BODIES.F1), outcome: "SAFE" },
      { radar_verdict: JSON.stringify(FORM_BODIES.F6), outcome: "SAFE" },
      { radar_verdict: JSON.stringify(FORM_BODIES.F6), outcome: "SAFE" },
    ];
    const byForm = dangerousShareByForm(resolvedRows);
    assert.equal(byForm.F1.count, 2);
    assert.equal(byForm.F1.dangerous, 1);
    assert.equal(byForm.F1.ci.p, 0.5);
    assert.equal(byForm.F6.count, 2);
    assert.equal(byForm.F6.dangerous, 0);
    assert.equal(byForm.F2.count, 0, "forms with zero rows are still reported, not omitted");
  });

  test("simulationSplit: F1/F2 (no simulation) vs F3-F6 (simulation ran), DANGEROUS counts kept separate", () => {
    const resolvedRows = [
      { radar_verdict: JSON.stringify(FORM_BODIES.F1), outcome: "DANGEROUS" }, // not run
      { radar_verdict: JSON.stringify(FORM_BODIES.F2), outcome: "SAFE" }, // not run
      { radar_verdict: JSON.stringify(FORM_BODIES.F3), outcome: "DANGEROUS" }, // ran
      { radar_verdict: JSON.stringify(FORM_BODIES.F6), outcome: "SAFE" }, // ran
      { radar_verdict: JSON.stringify(FORM_BODIES.F6), outcome: "SAFE" }, // ran
    ];
    const split = simulationSplit(resolvedRows);
    assert.equal(split.simulationNotRun.count, 2);
    assert.equal(split.simulationNotRun.dangerous, 1);
    assert.equal(split.simulationRan.count, 3);
    assert.equal(split.simulationRan.dangerous, 1);
  });

  test("analyze()/formatReport(): section 12 tables are present, combined across strata, descriptive-only wording included", () => {
    const db = openDb(":memory:");
    const insertWithOutcome = (trade, outcome) => {
      const { lastInsertRowid } = insertTrade(db, trade);
      updateTradeOutcome(db, lastInsertRowid, outcome, null);
    };
    let t = 5000;
    const base = (overrides) => ({ mint: `M${t}`, pair: `P${t}`, t: t++, strat: "A", recorded_at: new Date().toISOString(), ...overrides });
    insertWithOutcome(base({ buyer: "B1", radar_verdict: FORM_BODIES.F1 }), "DANGEROUS");
    insertWithOutcome(base({ buyer: "B2", strat: "B", radar_verdict: FORM_BODIES.F6 }), "SAFE");

    const result = analyze(db.prepare("SELECT * FROM shadow_trades").all());
    assert.equal(result.responseForms.F1.count, 1);
    assert.equal(result.responseForms.F1.dangerous, 1);
    assert.equal(result.responseForms.F6.count, 1);
    assert.equal(result.simulationSplit.simulationNotRun.count, 1);
    assert.equal(result.simulationSplit.simulationRan.count, 1);

    const report = formatReport(result);
    assert.match(report, /F1..F6/);
    assert.match(report, /section 12a/);
    assert.match(report, /section 12b/);
    assert.match(report, /section 12c/);
    assert.match(report, /завершаются до проверки токена/);
  });

  test("--counters-only: formatCountersOnlyReport never mentions outcome/DANGEROUS/SAFE/BLOCKED/bucket names, only counts", () => {
    const db = openDb(":memory:");
    const insertWithOutcome = (trade, outcome) => {
      const { lastInsertRowid } = insertTrade(db, trade);
      updateTradeOutcome(db, lastInsertRowid, outcome, null);
    };
    insertWithOutcome({ mint: "M1", pair: "P1", t: 1, strat: "A", buyer: "B1", recorded_at: new Date().toISOString(), radar_verdict: FORM_BODIES.F1 }, "DANGEROUS");
    insertWithOutcome({ mint: "M2", pair: "P2", t: 2, strat: "B", buyer: "B2", recorded_at: new Date().toISOString(), radar_verdict: FORM_BODIES.F6 }, "SAFE");
    incrementSkipCounter(db, "TOKEN_TOO_OLD", 3);
    logError(db, "collect", "processPool:x", new Error("boom"));

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const report = formatCountersOnlyReport(rows, loadSkipCounters(db), countErrorLogs(db));

    assert.match(report, /Всего строк в shadow_trades: 2/);
    assert.match(report, /Записей в error_logs: 1/);
    assert.match(report, /TOKEN_TOO_OLD: 3/);
    assert.match(report, /F1: 1/);
    assert.match(report, /F6: 1/);

    // The look-ahead rule: no outcome/danger-rate vocabulary anywhere in the text.
    assert.doesNotMatch(report, /outcome/i);
    assert.doesNotMatch(report, /DANGEROUS/);
    assert.doesNotMatch(report, /\bSAFE\b/);
    assert.doesNotMatch(report, /BLOCKED/);
    assert.doesNotMatch(report, /VERIFIED_SAFE/);
    assert.doesNotMatch(report, /LOW_TRUST_WARMING/);
    assert.doesNotMatch(report, /Wilson|CI95|доля/i);
  });

  // --- Task 3 (stage 7H): pool_candidates seen/selected by UTC hour ---

  test("summarizePoolCandidatesByHour: buckets by the UTC hour of seen_at, seen vs selected kept separate", () => {
    const rows = [
      { seen_at: "2026-09-29T03:15:00.000Z", selected: 1 },
      { seen_at: "2026-09-29T03:45:00.000Z", selected: 0 },
      { seen_at: "2026-09-29T14:05:00.000Z", selected: 1 },
    ];
    const byHour = summarizePoolCandidatesByHour(rows);
    assert.equal(byHour["03"].seen, 2);
    assert.equal(byHour["03"].selected, 1);
    assert.equal(byHour["14"].seen, 1);
    assert.equal(byHour["14"].selected, 1);
    assert.equal(byHour["00"].seen, 0, "hours with no candidates are still present, reported as 0");
  });

  test("formatPoolCandidatesByHourReport: prints all 24 UTC hours, seen and selected counts", () => {
    const report = formatPoolCandidatesByHourReport([{ seen_at: "2026-09-29T09:00:00.000Z", selected: 1 }]);
    assert.match(report, /09:00 UTC -- увидено: 1, выбрано: 1/);
    assert.match(report, /00:00 UTC -- увидено: 0, выбрано: 0/);
    assert.equal(report.split("\n").length, 24, "all 24 hours printed, not just the ones with data");
  });

  test("loadPoolCandidates: read-only query against a real (in-memory) database round-trips correctly", () => {
    const db = openDb(":memory:");
    recordPoolCandidate(db, { cycleTs: 1, pool: "Pair1", mint: "Mint1", seenAt: "2026-09-29T05:00:00.000Z", selected: true });
    recordPoolCandidate(db, { cycleTs: 1, pool: "Pair2", mint: "Mint2", seenAt: "2026-09-29T05:01:00.000Z", selected: false });
    const rows = loadPoolCandidates(db);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.selected).length, 1);
  });

  test("formatCountersOnlyReport: includes the pool_candidates-by-hour section without leaking outcome data", () => {
    const report = formatCountersOnlyReport([], [], 0, [{ seen_at: "2026-09-29T11:00:00.000Z", selected: 1 }]);
    assert.match(report, /11:00 UTC -- увидено: 1, выбрано: 1/);
    assert.doesNotMatch(report, /outcome/i);
    assert.doesNotMatch(report, /DANGEROUS/);
  });

  // --- Task 5 (stage 7H): independence of observations ---

  test("countDistinctBuyers: counts unique buyer addresses, ignores rows with no buyer", () => {
    const rows = [{ buyer: "B1" }, { buyer: "B1" }, { buyer: "B2" }, { buyer: null }];
    assert.equal(countDistinctBuyers(rows), 2);
  });

  test("topBuyers: sorted descending by record count, capped at n", () => {
    const rows = [
      ...Array(5).fill({ buyer: "Sniper1" }),
      ...Array(2).fill({ buyer: "Sniper2" }),
      { buyer: "Occasional1" },
    ];
    const top = topBuyers(rows, 2);
    assert.equal(top.length, 2);
    assert.deepEqual(top[0], { buyer: "Sniper1", count: 5 });
    assert.deepEqual(top[1], { buyer: "Sniper2", count: 2 });
  });

  test("oneRecordPerBuyer: keeps the EARLIEST record (by t) per buyer, drops the rest", () => {
    const rows = [
      { buyer: "B1", t: 300, outcome: "SAFE" },
      { buyer: "B1", t: 100, outcome: "DANGEROUS" }, // earlier -- this one should win
      { buyer: "B1", t: 200, outcome: "SAFE" },
      { buyer: "B2", t: 150, outcome: "SAFE" },
    ];
    const deduped = oneRecordPerBuyer(rows);
    assert.equal(deduped.length, 2);
    const b1 = deduped.find((r) => r.buyer === "B1");
    assert.equal(b1.t, 100);
    assert.equal(b1.outcome, "DANGEROUS");
  });

  test("evaluateClusteredUsefulness: RADAR_USEFUL only when BOTH the main and deduplicated tables say so", () => {
    assert.equal(evaluateClusteredUsefulness("RADAR_USEFUL", "RADAR_USEFUL"), "RADAR_USEFUL");
    assert.equal(evaluateClusteredUsefulness("RADAR_USEFUL", "INSUFFICIENT_DATA"), "INSUFFICIENT_DATA");
    assert.equal(evaluateClusteredUsefulness("RADAR_USEFUL", "DIFFERENCE_NOT_ESTABLISHED"), "INSUFFICIENT_DATA");
    assert.equal(evaluateClusteredUsefulness("DIFFERENCE_NOT_ESTABLISHED", "RADAR_USEFUL"), "INSUFFICIENT_DATA");
    assert.equal(evaluateClusteredUsefulness("INSUFFICIENT_DATA", "INSUFFICIENT_DATA"), "INSUFFICIENT_DATA");
  });

  test("analyze()/formatReport(): buyer independence section present, F1 share reported, clusteredStatus wired into strata tables", () => {
    const db = openDb(":memory:");
    const insertWithOutcome = (trade, outcome) => {
      const { lastInsertRowid } = insertTrade(db, trade);
      updateTradeOutcome(db, lastInsertRowid, outcome, null);
    };
    let t = 9000;
    const base = (overrides) => ({ mint: `M${t}`, pair: `P${t}`, t: t++, strat: "A", recorded_at: new Date().toISOString(), ...overrides });
    // Same buyer ("Sniper") shows up twice -- should collapse to 1 in the deduplicated table.
    insertWithOutcome(base({ buyer: "Sniper", radar_verdict: FORM_BODIES.F1 }), "DANGEROUS");
    insertWithOutcome(base({ buyer: "Sniper", radar_verdict: FORM_BODIES.F1 }), "SAFE");
    insertWithOutcome(base({ buyer: "Occasional", radar_verdict: FORM_BODIES.F6 }), "SAFE");
    insertTrade(db, base({ buyer: null })); // NO_BUYER -- not counted in F1 share denominator exclusion, but IS in totalRows

    const rows = db.prepare("SELECT * FROM shadow_trades").all();
    const result = analyze(rows);

    assert.equal(result.buyerIndependence.distinctBuyers, 2);
    assert.equal(result.buyerIndependence.topBuyers[0].buyer, "Sniper");
    assert.equal(result.buyerIndependence.topBuyers[0].count, 2);
    assert.equal(result.buyerIndependence.oneRecordPerBuyerStrata.A.resolvedCount, 2, "Sniper's 2 records collapse to 1 -- 2 distinct buyers total in strat A");

    assert.equal(result.f1Share.count, 2);
    assert.equal(result.f1Share.totalRows, 4);
    assert.ok(Math.abs(result.f1Share.share - 0.5) < 1e-9);

    assert.ok("clusteredStatus" in result.strata.A.table1);

    const report = formatReport(result);
    assert.match(report, /Независимость наблюдений/);
    assert.match(report, /Различных покупателей.*: 2/);
    assert.match(report, /Топ-10 покупателей/);
    assert.match(report, /одна запись на покупателя/i);
    assert.match(report, /Доля формы F1/);
    assert.match(report, /section 14г/);
  });
});
