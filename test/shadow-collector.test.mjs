import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  determineStrat,
  extractBuyerFromTx,
  classifyAccountForBuyer,
  resolveBuyer,
  resolvePoolCreationTx,
  fetchFreshPools,
  checkTokenAge,
  determineMintRiskFetched,
  queryGateCopy,
  COPY_AMOUNT_USD,
  POOL_MAX_AGE_MINUTES,
} from "../scripts/shadow/collect.mjs";
import {
  classifyOutcome,
  loadIssuerControlledMints,
  checkPoolLiquidityDrop,
  checkBuyerAccountState,
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Shadow Collector Unit Tests (Offline / Mocked, fetch injected)", () => {
  // --- Pure logic ---

  test("Outcome (a): buyer token account frozen -> DANGEROUS", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "frozen", reason: "frozen token account" },
      checkB: { drop: 0.1, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });
    assert.equal(res.outcome, "DANGEROUS");
    assert.equal(res.details.trigger, "frozen_ata");
  });

  test("Outcome (b): pool liquidity drop >= 90% without migration -> DANGEROUS", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized", reason: "active" },
      checkB: { drop: 0.95, migration: false, currentLiquidityUsd: 50, initialLiquidityUsd: 1000 },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });
    assert.equal(res.outcome, "DANGEROUS");
    assert.equal(res.details.trigger, "liquidity_collapse");
  });

  test("Outcome (b) migration: liquidity drop >= 90% with successor pool -> миграция, не исход", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized", reason: "active" },
      checkB: { drop: 0.98, migration: true, currentLiquidityUsd: 20, initialLiquidityUsd: 1000 },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });
    assert.equal(res.outcome, "миграция, не исход");
  });

  test("Outcome ISSUER_CONTROLLED: pre-registered mint in issuer-controlled list", () => {
    const issuerRecord = { mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", issuer: "Backed Assets (xStocks)", sourceUrl: "https://docs.xstocks.fi/" };
    const res = classifyOutcome({
      isIssuerControlled: true,
      checkA: { state: "initialized" },
      checkB: { drop: 0.05, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
      issuerRecord,
    });
    assert.equal(res.outcome, "ISSUER_CONTROLLED");
    assert.equal(res.details.issuerControlledOutcomeFired, false);
  });

  test("Outcome irrecoverable: buyer ATA closed -> невосстановимо (ATA закрыт)", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "closed", reason: "ATA закрыт" },
      checkB: { drop: 0.1, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });
    assert.equal(res.outcome, "невосстановимо (ATA закрыт)");
  });

  test("Outcome SAFE: normal trade with active account and stable liquidity", () => {
    const res = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized", reason: "active" },
      checkB: { drop: 0.15, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });
    assert.equal(res.outcome, "SAFE");
  });

  test("Outcome PAIR_MISSING: pair disappeared from DexScreener at t+N (own class, not DANGEROUS/SAFE)", () => {
    const checkB = { drop: null, initialLiquidityUsd: 5000, currentLiquidityUsd: null, pairMissing: true, migration: false, reason: "PAIR_MISSING" };
    const res = classifyOutcome({ isIssuerControlled: false, checkA: { state: "initialized" }, checkB, buyer: "BuyerWallet11111111111111111111111111111111" });
    assert.equal(res.outcome, "PAIR_MISSING");
    assert.equal(res.details.checkB.pairMissing, true);
  });

  test("Task 5a: ANY api error (checkA or checkB) yields outcome=null (retry later), NEVER DANGEROUS", () => {
    const resA = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "error", apiError: true, reason: "RPC timeout" },
      checkB: { drop: 0.1, migration: false },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });
    assert.equal(resA.outcome, null, "checkA API error must not produce a classified outcome");

    const resB = classifyOutcome({
      isIssuerControlled: false,
      checkA: { state: "initialized" },
      checkB: { apiError: true, reason: "DexScreener query failed: HTTP 500" },
      buyer: "BuyerWallet11111111111111111111111111111111",
    });
    assert.equal(resB.outcome, null, "checkB API error must not produce a classified outcome");
    assert.notEqual(resB.outcome, "DANGEROUS", "must never default an API error to DANGEROUS");
  });

  test("Stratum classification: Strat A (revoked authority) vs Strat B (active freeze/mint authority)", () => {
    assert.equal(determineStrat({ mintAuthority: null, freezeAuthority: null }), "A");
    assert.equal(determineStrat({ mintAuthority: null, freezeAuthority: "FreezeAuth1111111111111111111111111111111" }), "B");
    assert.equal(determineStrat({ mintAuthority: "MintAuth1111111111111111111111111111111", freezeAuthority: null }), "B");
  });

  test("NO_BUYER: extractBuyerFromTx returns null (not a sentinel string) when unresolvable", () => {
    const emptyTx = { meta: { preTokenBalances: [], postTokenBalances: [] } };
    assert.equal(extractBuyerFromTx(emptyTx, "Mint11111111111111111111111111111111", "Pair11111111111111111111111111111111"), null);

    const res = classifyOutcome({ isIssuerControlled: false, checkA: { state: "unresolvable", reason: "no buyer recorded at t" }, checkB: { drop: 0.05, migration: false }, buyer: null });
    assert.equal(res.outcome, "невосстановимо (NO_BUYER)");
  });

  // --- Task 3: buyer must be System-owned, non-executable, not a PDA ---

  test("classifyAccountForBuyer: rejects PDA / program-owned accounts, accepts plain System wallets", () => {
    const pdaAccount = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false };
    const rejected = classifyAccountForBuyer(pdaAccount);
    assert.equal(rejected.isRegularWallet, false);
    assert.match(rejected.reason, /PDA or program account/);

    const executableAccount = { owner: "11111111111111111111111111111111", executable: true };
    const rejectedExec = classifyAccountForBuyer(executableAccount);
    assert.equal(rejectedExec.isRegularWallet, false);

    const nullAccount = null;
    const rejectedNull = classifyAccountForBuyer(nullAccount);
    assert.equal(rejectedNull.isRegularWallet, false);
    assert.match(rejectedNull.reason, /never funded/);

    const plainWallet = { owner: "11111111111111111111111111111111", executable: false };
    const accepted = classifyAccountForBuyer(plainWallet);
    assert.equal(accepted.isRegularWallet, true);
  });

  test("resolveBuyer: rejects the pool-creation fee payer and a PDA candidate, accepts the first valid System-owned wallet after", async () => {
    const pair = "Pair11111111111111111111111111111111111111";
    const mint = "Mint11111111111111111111111111111111111111";
    const creatorWallet = "Creator1111111111111111111111111111111111";
    const pdaCandidate = "PDACandidate111111111111111111111111111111";
    const realBuyer = "RealBuyer1111111111111111111111111111111111";

    const creationSig = { signature: "sigCreation", blockTime: 1000 };
    const sigFromCreator = { signature: "sigFromCreator", blockTime: 1010 }; // newer than creation
    const sigFromPda = { signature: "sigFromPda", blockTime: 1020 };
    const sigFromRealBuyer = { signature: "sigFromRealBuyer", blockTime: 1030 };
    // allSignaturesNewestFirst: newest first
    const allSignaturesNewestFirst = [sigFromRealBuyer, sigFromPda, sigFromCreator, creationSig];

    const poolCreation = {
      signature: creationSig.signature,
      blockTime: creationSig.blockTime,
      tx: { transaction: { message: { accountKeys: [creatorWallet] } } },
      allSignaturesNewestFirst,
    };

    const txBySig = {
      sigFromCreator: { meta: { preTokenBalances: [], postTokenBalances: [{ mint, owner: creatorWallet, accountIndex: 0, uiTokenAmount: { amount: "5" } }] } },
      sigFromPda: { meta: { preTokenBalances: [], postTokenBalances: [{ mint, owner: pdaCandidate, accountIndex: 0, uiTokenAmount: { amount: "7" } }] }, blockTime: sigFromPda.blockTime },
      sigFromRealBuyer: { meta: { preTokenBalances: [], postTokenBalances: [{ mint, owner: realBuyer, accountIndex: 0, uiTokenAmount: { amount: "9" } }] }, blockTime: sigFromRealBuyer.blockTime },
    };

    const accountInfoByAddress = {
      [pdaCandidate]: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false } }, // PDA/token-owned, rejected
      [realBuyer]: { value: { owner: "11111111111111111111111111111111", executable: false } }, // plain wallet, accepted
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "getTransaction") {
        const sig = body.params[0];
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: txBySig[sig] });
      }
      if (body.method === "getAccountInfo") {
        const addr = body.params[0];
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: accountInfoByAddress[addr] ?? { value: null } });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
    };

    try {
      const result = await resolveBuyer(pair, mint, poolCreation, null);
      assert.equal(result.buyer, realBuyer, "should skip creator fee payer and PDA, land on the real wallet");
      assert.equal(result.buyerTxSignature, "sigFromRealBuyer");
      assert.equal(result.rejectedCandidates.length, 2);
      assert.match(result.rejectedCandidates[0].reason, /fee payer/);
      assert.match(result.rejectedCandidates[1].reason, /PDA or program account/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolveBuyer: pool-creation transaction itself is never considered a purchase", async () => {
    const pair = "Pair22222222222222222222222222222222222222";
    const mint = "Mint22222222222222222222222222222222222222";
    const creatorWallet = "Creator2222222222222222222222222222222222";
    const creationSig = { signature: "onlyCreationSig", blockTime: 2000 };
    // Only the creation signature exists -- no transactions after it.
    const poolCreation = {
      signature: creationSig.signature,
      blockTime: creationSig.blockTime,
      tx: { transaction: { message: { accountKeys: [creatorWallet] } } },
      allSignaturesNewestFirst: [creationSig],
    };
    const result = await resolveBuyer(pair, mint, poolCreation, null);
    assert.equal(result.buyer, null, "with no post-creation transactions, there is no buyer to resolve");
  });

  // --- Task 4: RADAR_ERROR is never recorded as a verdict ---

  test("queryGateCopy: non-200 response is flagged isRadarError, body is not treated as a verdict", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ error: "HELIUS_API_KEY is not set on the server." }, 503);
    try {
      const res = await queryGateCopy("http://localhost:7690", "SomeBuyer1111111111111111111111111111111", "SomeMint11111111111111111111111111111111", COPY_AMOUNT_USD);
      assert.equal(res.httpStatus, 503);
      assert.equal(res.isRadarError, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("queryGateCopy: network failure (radar unreachable) is also isRadarError with null httpStatus", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      const res = await queryGateCopy("http://localhost:7690", "SomeBuyer1111111111111111111111111111111", "SomeMint11111111111111111111111111111111", COPY_AMOUNT_USD);
      assert.equal(res.httpStatus, null);
      assert.equal(res.isRadarError, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("queryGateCopy: 200 response is not a radar error and carries the verdict body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ allow: true, action: "allow", riskScore: 5 }, 200);
    try {
      const res = await queryGateCopy("http://localhost:7690", "SomeBuyer1111111111111111111111111111111", "SomeMint11111111111111111111111111111111", COPY_AMOUNT_USD);
      assert.equal(res.isRadarError, false);
      assert.equal(res.body.action, "allow");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("determineMintRiskFetched: true only on positive TOXIC_MINT/CONCENTRATION evidence, else NOT_DETERMINABLE", () => {
    assert.equal(determineMintRiskFetched({ details: { simulation: { wouldTrigger: ["TOXIC_MINT"] } } }), true);
    assert.equal(determineMintRiskFetched({ details: { simulation: { wouldTrigger: ["LARGE_PAYMENT"] } } }), "NOT_DETERMINABLE");
    assert.equal(determineMintRiskFetched({ action: "allow" }), "NOT_DETERMINABLE");
    assert.equal(determineMintRiskFetched(null), "NOT_DETERMINABLE");
  });

  // --- Task 6: checkPoolLiquidityDrop with injected fetch ---

  test("checkPoolLiquidityDrop: drop detected, no successor -> DANGEROUS-eligible", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/pairs/solana/")) return jsonResponse({ pair: { liquidity: { usd: 50 } } });
      throw new Error("unexpected URL " + url);
    };
    const res = await checkPoolLiquidityDrop("PairAAA", "MintAAA", 1000, 1_000_000, null, fetchImpl);
    assert.equal(res.drop, 0.95);
    assert.equal(res.migration, false);
    assert.equal(res.apiError, undefined);
  });

  test("checkPoolLiquidityDrop: successor pool created AFTER t -> counted as migration", async () => {
    const t = 1_000_000; // seconds
    const fetchImpl = async (url) => {
      if (url.includes("/pairs/solana/")) return jsonResponse({ pair: { liquidity: { usd: 10 } } });
      if (url.includes("/tokens/")) {
        return jsonResponse({
          pairs: [{ pairAddress: "SuccessorPair", dexId: "pumpswap", liquidity: { usd: 50000 }, pairCreatedAt: (t + 3600) * 1000 }],
        });
      }
      throw new Error("unexpected URL " + url);
    };
    const res = await checkPoolLiquidityDrop("PairBBB", "MintBBB", 1000, t, null, fetchImpl);
    assert.equal(res.drop, 0.99);
    assert.equal(res.migration, true, "successor created after t must count as a migration");
  });

  test("checkPoolLiquidityDrop: pool that existed BEFORE t is NOT counted as a successor (task 5c)", async () => {
    const t = 1_000_000;
    const fetchImpl = async (url) => {
      if (url.includes("/pairs/solana/")) return jsonResponse({ pair: { liquidity: { usd: 10 } } });
      if (url.includes("/tokens/")) {
        return jsonResponse({
          pairs: [{ pairAddress: "PreexistingPair", dexId: "raydium", liquidity: { usd: 50000 }, pairCreatedAt: (t - 3600) * 1000 }],
        });
      }
      throw new Error("unexpected URL " + url);
    };
    const res = await checkPoolLiquidityDrop("PairCCC", "MintCCC", 1000, t, null, fetchImpl);
    assert.equal(res.migration, false, "a pool that predates t is not a successor, even with high liquidity");
    assert.equal(res.drop, 0.99);
  });

  test("checkPoolLiquidityDrop: DexScreener API failure -> apiError:true, no drop is inferred (task 5a)", async () => {
    const fetchImpl = async () => jsonResponse({ error: "server error" }, 500);
    const res = await checkPoolLiquidityDrop("PairDDD", "MintDDD", 1000, 1_000_000, null, fetchImpl);
    assert.equal(res.apiError, true);
    assert.equal(res.drop, undefined, "must not fabricate a drop value on API failure");
  });

  test("checkPoolLiquidityDrop: pair missing from direct lookup AND from /tokens/{mint} -> PAIR_MISSING", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/pairs/solana/")) return jsonResponse({});
      if (url.includes("/tokens/")) return jsonResponse({ pairs: [] });
      throw new Error("unexpected URL " + url);
    };
    const res = await checkPoolLiquidityDrop("PairEEE", "MintEEE", 1000, 1_000_000, null, fetchImpl);
    assert.equal(res.pairMissing, true);
  });

  // --- checkBuyerAccountState with injected fetch ---

  test("checkBuyerAccountState: frozen account detected", async () => {
    const fetchImpl = async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: [{ account: { data: { parsed: { info: { state: "frozen" } } } } }] } });
    const res = await checkBuyerAccountState("Buyer1111111111111111111111111111111111", "Mint1111111111111111111111111111111111", null, fetchImpl);
    assert.equal(res.state, "frozen");
  });

  test("checkBuyerAccountState: RPC failure -> apiError:true (task 5a)", async () => {
    const fetchImpl = async () => jsonResponse({ error: "server error" }, 500);
    const res = await checkBuyerAccountState("Buyer1111111111111111111111111111111111", "Mint1111111111111111111111111111111111", null, fetchImpl);
    assert.equal(res.state, "error");
    assert.equal(res.apiError, true);
  });

  test("checkBuyerAccountState: no buyer -> unresolvable, not an error", async () => {
    const res = await checkBuyerAccountState(null, "Mint1111111111111111111111111111111111", null);
    assert.equal(res.state, "unresolvable");
    assert.equal(res.apiError, undefined);
  });

  // --- GeckoTerminal pool discovery + token age (fetch injected) ---

  test("fetchFreshPools: filters by dex id and POOL_MAX_AGE_MINUTES, extracts mint from base_token id", async () => {
    const now = Date.now();
    const fresh = { attributes: { address: "FreshPair111", pool_created_at: new Date(now - 2 * 60 * 1000).toISOString() }, relationships: { dex: { data: { id: "pumpswap" } }, base_token: { data: { id: "solana_FreshMint1111111111111111111111111111" } } } };
    const stale = { attributes: { address: "StalePair111", pool_created_at: new Date(now - 60 * 60 * 1000).toISOString() }, relationships: { dex: { data: { id: "raydium" } }, base_token: { data: { id: "solana_StaleMint1111111111111111111111111111" } } } };
    const wrongDex = { attributes: { address: "OtherDexPair", pool_created_at: new Date(now - 1000).toISOString() }, relationships: { dex: { data: { id: "meteora" } }, base_token: { data: { id: "solana_OtherMint1111111111111111111111111111" } } } };

    const fetchImpl = async () => jsonResponse({ data: [fresh, wrongDex, stale] });
    const pools = await fetchFreshPools(null, fetchImpl, 1);
    assert.equal(pools.length, 1);
    assert.equal(pools[0].pair, "FreshPair111");
    assert.equal(pools[0].mint, "FreshMint1111111111111111111111111111");
  });

  test("checkTokenAge: minimum pairCreatedAt across all pairs older than 14 days -> tooOld:true", async () => {
    const fifteenDaysAgoMs = Date.now() - 15 * 86400 * 1000;
    const fetchImpl = async () => jsonResponse({ pairs: [{ pairCreatedAt: fifteenDaysAgoMs }, { pairCreatedAt: Date.now() }] });
    const res = await checkTokenAge("SomeOldMint111111111111111111111111111111", null, fetchImpl);
    assert.equal(res.tooOld, true);
  });

  test("checkTokenAge: all pairs within 14 days -> tooOld:false", async () => {
    const fetchImpl = async () => jsonResponse({ pairs: [{ pairCreatedAt: Date.now() - 60000 }] });
    const res = await checkTokenAge("SomeFreshMint1111111111111111111111111111", null, fetchImpl);
    assert.equal(res.tooOld, false);
  });

  // --- Resilience / DB lifecycle (unchanged behavior, re-verified against new schema) ---

  test("Resilience: daily ceiling tracking and error logging in SQLite", () => {
    const db = openDb(":memory:");
    const check1 = checkDailyCeiling(db, 5);
    assert.equal(check1.allowed, true);
    incrementRequestCounter(db, 3);
    incrementRequestCounter(db, 3);
    const check3 = checkDailyCeiling(db, 5);
    assert.equal(check3.allowed, false);
    logError(db, "test_script", "test_action", "Test error message", { extra: 123 });
    const logRow = db.prepare("SELECT * FROM error_logs WHERE script = ?").get("test_script");
    assert.ok(logRow);
  });

  test("Database lifecycle: append-only verdict at t, outcome written at t+N without verdict leakage, buyer_tx_signature/http_status/mint_risk_fetched persisted", () => {
    const db = openDb(":memory:");
    const tTime = Math.floor(Date.now() / 1000) - 4 * 86400;
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
      buyer_tx_signature: "sigBuyerTx1111",
      http_status: 200,
      copy_amount_usd: COPY_AMOUNT_USD,
      mint_risk_fetched: true,
      radar_verdict: { allow: true, action: "allow", riskScore: 12 },
      radar_code_version: "abc1234",
    });

    const pending = getPendingTrades(db, 3);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].radar_verdict, undefined, "outcomes worker query must not select radar_verdict");

    updateTradeOutcome(db, pending[0].id, "SAFE", { verified: true });

    const stored = db.prepare("SELECT * FROM shadow_trades WHERE id = ?").get(pending[0].id);
    assert.equal(stored.outcome, "SAFE");
    assert.equal(stored.buyer_tx_signature, "sigBuyerTx1111");
    assert.equal(stored.http_status, 200);
    assert.equal(stored.mint_risk_fetched, "true");
    assert.ok(stored.radar_verdict.includes("allow"));

    const secondUpdate = db.prepare("UPDATE shadow_trades SET outcome = ? WHERE id = ? AND outcome IS NULL").run("DANGEROUS", pending[0].id);
    assert.equal(secondUpdate.changes, 0);
  });

  test("Task 4: RADAR_ERROR trade is inserted with radar_verdict NULL and radar_error populated, never a fabricated verdict", () => {
    const db = openDb(":memory:");
    insertTrade(db, {
      mint: "MintErr111111111111111111111111111111111",
      pair: "PairErr111111111111111111111111111111111",
      t: Math.floor(Date.now() / 1000),
      strat: "A",
      buyer: "BuyerErr11111111111111111111111111111111",
      buyer_tx_signature: "sigErr1",
      http_status: 503,
      copy_amount_usd: COPY_AMOUNT_USD,
      mint_risk_fetched: "NOT_DETERMINABLE",
      radar_verdict: null,
      radar_error: { error: "HELIUS_API_KEY is not set on the server." },
      radar_code_version: "abc1234",
    });
    const row = db.prepare("SELECT * FROM shadow_trades WHERE mint = ?").get("MintErr111111111111111111111111111111111");
    assert.equal(row.radar_verdict, null);
    assert.ok(row.radar_error.includes("HELIUS_API_KEY"));
    assert.equal(row.http_status, 503);
  });
});
