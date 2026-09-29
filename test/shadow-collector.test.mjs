import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  determineStrat,
  extractBuyerFromTx,
} from "../scripts/shadow/collect.mjs";
import {
  classifyOutcome,
  loadIssuerControlledMints,
  checkPoolLiquidityDrop,
} from "../scripts/shadow/outcomes.mjs";
import {
  openDb,
  insertTrade,
  getPendingTrades,
  updateTradeOutcome,
  checkDailyCeiling,
  incrementRequestCounter,
  logError,
} from "../scripts/shadow/db.mjs";

describe("Shadow Collector Unit Tests (Offline / Mocked)", () => {
  // Test 1: Outcome (a) - Frozen buyer token account -> DANGEROUS
  test("Outcome (a): buyer token account frozen -> DANGEROUS", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "frozen", reason: "frozen token account" },
      checkB: { drop: 0.1, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });

    assert.equal(res.outcome, "DANGEROUS");
    assert.equal(res.details.trigger, "frozen_ata");
    assert.equal(res.details.checkA.state, "frozen");
  });

  // Test 2: Outcome (b) - Liquidity drop >= 90% without successor pool -> DANGEROUS
  test("Outcome (b): pool liquidity drop >= 90% without migration -> DANGEROUS", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized", reason: "active" },
      checkB: { drop: 0.95, migration: false, currentLiquidityUsd: 50, initialLiquidityUsd: 1000 },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });

    assert.equal(res.outcome, "DANGEROUS");
    assert.equal(res.details.trigger, "liquidity_collapse");
    assert.equal(res.details.checkB.drop, 0.95);
  });

  // Test 3: Outcome (b) migration exclusion -> миграция, не исход
  test("Outcome (b) migration: liquidity drop >= 90% with successor pool -> миграция, не исход", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized", reason: "active" },
      checkB: { drop: 0.98, migration: true, currentLiquidityUsd: 20, initialLiquidityUsd: 1000 },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });

    assert.equal(res.outcome, "миграция, не исход");
    assert.equal(res.details.checkB.migration, true);
  });

  // Test 4: ISSUER_CONTROLLED classification
  test("Outcome ISSUER_CONTROLLED: pre-registered mint in issuer-controlled list", () => {
    const issuerRecord = {
      mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
      issuer: "Backed Assets (xStocks)",
      sourceUrl: "https://docs.xstocks.fi/",
    };

    const res = classifyOutcome({
      isIssuerControlled: true,
      checkA: { state: "initialized" },
      checkB: { drop: 0.05, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
      issuerRecord,
    });

    assert.equal(res.outcome, "ISSUER_CONTROLLED");
    assert.equal(res.details.issuer, "Backed Assets (xStocks)");
    assert.equal(res.details.sourceUrl, "https://docs.xstocks.fi/");
    assert.equal(res.details.issuerControlledOutcomeFired, false);
  });

  // Test 5: Irrecoverable - Buyer ATA closed before t+N
  test("Outcome irrecoverable: buyer ATA closed -> невосстановимо (ATA закрыт)", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "closed", reason: "ATA закрыт" },
      checkB: { drop: 0.1, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });

    assert.equal(res.outcome, "невосстановимо (ATA закрыт)");
  });

  // Test 6: Clean trade -> SAFE
  test("Outcome SAFE: normal trade with active account and stable liquidity", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized", reason: "active" },
      checkB: { drop: 0.15, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });

    assert.equal(res.outcome, "SAFE");
  });

  // Test 7: Missing pair (пропажа пары) from DexScreener (v2.1 Section 2b)
  test("Missing pair: pair disappearance from DexScreener yields невосстановимо (пара пропала из DexScreener)", async () => {
    // When a pair is missing and no successor pairs exist on DexScreener
    const checkB = {
      drop: null,
      initialLiquidityUsd: 5000,
      currentLiquidityUsd: 0,
      pairMissing: true,
      migration: false,
      reason: "невосстановимо (пара пропала из DexScreener)",
    };

    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized" },
      checkB,
      buyer: "BuyerWallet11111111111111111111111111111111",
    });

    assert.equal(res.outcome, "невосстановимо (пара пропала из DexScreener)");
    assert.equal(res.details.checkB.pairMissing, true);
  });

  // Test 8: Strat A vs Strat B determination (v2.1 Section 1.3)
  test("Stratum classification: Strat A (clean/revoked authority) vs Strat B (active freeze/mint authority)", () => {
    // Strat A: both authorities revoked/null
    assert.equal(determineStrat({ mintAuthority: null, freezeAuthority: null }), "A");

    // Strat B: active freeze authority
    assert.equal(determineStrat({ mintAuthority: null, freezeAuthority: "FreezeAuth1111111111111111111111111111111" }), "B");

    // Strat B: active mint authority
    assert.equal(determineStrat({ mintAuthority: "MintAuth1111111111111111111111111111111", freezeAuthority: null }), "B");

    // Strat B: both active
    assert.equal(determineStrat({ mintAuthority: "MintAuth1111111111111111111111111111111", freezeAuthority: "FreezeAuth1111111111111111111111111111111" }), "B");
  });

  // Test 9: NO_BUYER handling and outcome
  test("NO_BUYER: falls back to NO_BUYER when unresolvable and yields невосстановимо (NO_BUYER)", () => {
    // Empty transaction -> NO_BUYER
    const emptyTx = { meta: { preTokenBalances: [], postTokenBalances: [] } };
    assert.equal(extractBuyerFromTx(emptyTx, "Mint11111111111111111111111111111111", "Pair11111111111111111111111111111111"), "NO_BUYER");

    // Transaction where pool account changes but no third-party buyer exists
    const poolOnlyTx = {
      meta: {
        preTokenBalances: [{ accountIndex: 0, mint: "Mint1111", owner: "Pair1111", uiTokenAmount: { amount: "100" } }],
        postTokenBalances: [{ accountIndex: 0, mint: "Mint1111", owner: "Pair1111", uiTokenAmount: { amount: "200" } }],
      },
    };
    assert.equal(extractBuyerFromTx(poolOnlyTx, "Mint1111", "Pair1111"), "NO_BUYER");

    // Outcome for NO_BUYER trade
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "unresolvable", reason: "NO_BUYER recorded at t" },
      checkB: { drop: 0.05, migration: false },
      buyer: "NO_BUYER",
    });
    assert.equal(res.outcome, "невосстановимо (NO_BUYER)");
  });

  // Test 10: Daily quota ceiling and error logging
  test("Resilience: daily ceiling tracking and error logging in SQLite", () => {
    const db = openDb(":memory:");

    // Initial ceiling check
    const check1 = checkDailyCeiling(db, 5);
    assert.equal(check1.allowed, true);
    assert.equal(check1.current, 0);

    // Increment counters
    incrementRequestCounter(db, 3);
    const check2 = checkDailyCeiling(db, 5);
    assert.equal(check2.current, 3);
    assert.equal(check2.allowed, true);

    // Reach ceiling
    incrementRequestCounter(db, 3);
    const check3 = checkDailyCeiling(db, 5);
    assert.equal(check3.current, 6);
    assert.equal(check3.allowed, false);

    // Error logging
    logError(db, "test_script", "test_action", "Test error message", { extra: 123 });
    const logRow = db.prepare("SELECT * FROM error_logs WHERE script = ?").get("test_script");
    assert.ok(logRow);
    assert.equal(logRow.error_message, "Test error message");
    assert.ok(logRow.details.includes("123"));
  });

  // Test 11: Database lifecycle: prospective save at t, outcomes calculation at t+N, irreversible
  test("Database lifecycle: append-only verdict at t, outcome written at t+N without verdict leakage", () => {
    const db = openDb(":memory:");

    // Save prospective trade at t with verdict
    const tTime = Math.floor(Date.now() / 1000) - 4 * 86400; // 4 days ago
    insertTrade(db, {
      mint: "MintTest1111111111111111111111111111111",
      pair: "PairTest1111111111111111111111111111111",
      t: tTime,
      liquidity_usd: 12000,
      mint_authority: null,
      freeze_authority: null,
      token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      token_2022_extensions: [],
      strat: "A",
      buyer: "BuyerTest1111111111111111111111111111111",
      radar_verdict: { allow: true, action: "allow", riskScore: 12 },
      radar_code_version: "abc1234",
    });

    // Query pending trades older than 3 days
    const pending = getPendingTrades(db, 3);
    assert.equal(pending.length, 1);
    // CRITICAL: verify radar_verdict is NOT included in pending trades query
    assert.equal(pending[0].radar_verdict, undefined);

    // Write outcome
    updateTradeOutcome(db, pending[0].id, "SAFE", { verified: true });

    // Verify written outcome
    const stored = db.prepare("SELECT * FROM shadow_trades WHERE id = ?").get(pending[0].id);
    assert.equal(stored.outcome, "SAFE");
    assert.ok(stored.outcome_computed_at);
    assert.ok(stored.outcome_details.includes("verified"));
    assert.ok(stored.radar_verdict.includes("allow")); // Original verdict untouched!

    // Verify it is no longer pending
    const remainingPending = getPendingTrades(db, 3);
    assert.equal(remainingPending.length, 0);

    // Verify irreversibility: attempting to overwrite outcome fails
    const secondUpdate = db.prepare("UPDATE shadow_trades SET outcome = ? WHERE id = ? AND outcome IS NULL").run("DANGEROUS", pending[0].id);
    assert.equal(secondUpdate.changes, 0); // No change!
  });
});
