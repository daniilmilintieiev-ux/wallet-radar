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
  MAX_CONSECUTIVE_RADAR_ERRORS,
  runCollectionCycle,
  fetchMintStateAtT,
  determineRadarTokenCheckMissing,
} from "../scripts/shadow/collect.mjs";
import { MAJOR_MINTS } from "../dist/src/types.js";
import { KNOWN_SAFE_MINTS } from "../dist/src/mint.js";
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

  test(`runCollectionCycle: ${MAX_CONSECUTIVE_RADAR_ERRORS} consecutive RADAR_ERROR responses abort the cycle (fatalRadarError:true), never recorded as a verdict (stage 7D task 3)`, async () => {
    const n = MAX_CONSECUTIVE_RADAR_ERRORS;
    const pools = Array.from({ length: n }, (_, i) => ({
      pair: `Pair${i}11111111111111111111111111111111111111`,
      mint: `Mint${i}11111111111111111111111111111111111111`,
      dexId: "raydium",
    }));
    const creator = "Creator999999999999999999999999999999999999";
    const buyers = pools.map((_, i) => `Buyer${i}9999999999999999999999999999999999999`);
    const creationSigs = pools.map((_, i) => ({ signature: `creationSig${i}`, blockTime: 1000 + i * 100 }));
    const buySigs = pools.map((_, i) => ({ signature: `buySig${i}`, blockTime: 1050 + i * 100 }));
    // Frozen BEFORE the mock runs -- fetchFreshPools snapshots its own `now` at the start of
    // the call, then awaits this mock; a timestamp generated live inside the mock (new Date() at
    // resolve time) can race past that snapshot and produce a negative age, flakily dropping the
    // pool. A fixed past timestamp removes the race entirely.
    const freshPoolCreatedAtIso = new Date(Date.now() - 60_000).toISOString();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("geckoterminal.com")) {
        return jsonResponse({
          data: pools.map((p) => ({
            attributes: { address: p.pair, pool_created_at: freshPoolCreatedAtIso },
            relationships: { dex: { data: { id: p.dexId } }, base_token: { data: { id: `solana_${p.mint}` } } },
          })),
        });
      }
      if (url.includes("dexscreener.com")) {
        return jsonResponse({ pairs: [{ pairCreatedAt: Date.now() - 60_000 }] }); // fresh, never TOKEN_TOO_OLD
      }
      if (url.includes("/gate-copy")) {
        return jsonResponse({ error: "HELIUS_API_KEY is not set on the server." }, 503); // always RADAR_ERROR
      }
      // Solana JSON-RPC
      const body = JSON.parse(init.body);
      if (body.method === "getAccountInfo") {
        const addr = body.params[0];
        if (pools.some((p) => p.mint === addr)) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: {} } } } } }); // strat A: no authorities
        }
        if (buyers.includes(addr)) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "11111111111111111111111111111111", executable: false } } });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: null } });
      }
      if (body.method === "getSignaturesForAddress") {
        const idx = pools.findIndex((p) => p.pair === body.params[0]);
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: [buySigs[idx], creationSigs[idx]] }); // newest first
      }
      if (body.method === "getTransaction") {
        const sig = body.params[0];
        const cIdx = creationSigs.findIndex((s) => s.signature === sig);
        if (cIdx !== -1) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { transaction: { message: { accountKeys: [creator] } }, blockTime: creationSigs[cIdx].blockTime } });
        }
        const bIdx = buySigs.findIndex((s) => s.signature === sig);
        if (bIdx !== -1) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: {
              blockTime: buySigs[bIdx].blockTime,
              meta: { preTokenBalances: [], postTokenBalances: [{ mint: pools[bIdx].mint, owner: buyers[bIdx], accountIndex: 0, uiTokenAmount: { amount: "1" } }] },
            },
          });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
    };

    try {
      const result = await runCollectionCycle({ dbPath: ":memory:", radarUrl: "http://fake-radar", limit: n });
      assert.equal(result.fatalRadarError, true, "must abort after N consecutive RADAR_ERROR responses");
      assert.equal(result.rows.length, n, `must have processed exactly ${n} pools before aborting`);
      for (const row of result.rows) {
        assert.equal(row.buyer, buyers[pools.findIndex((p) => p.mint === row.mint)], "buyer must have resolved for every row");
        assert.equal(row.http_status, 503);
        assert.equal(row.radar_verdict, null, "RADAR_ERROR must NEVER populate radar_verdict -- not a fabricated verdict");
        assert.ok(row.radar_error, "radar_error must be populated instead");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- Task 2 (stage 7D): independent mint-metadata-fetched fixation, since
  // /gate-copy's response never echoes back whether IT fetched mint metadata
  // (verified by reading src/simulate.ts's simulatePayment return object and
  // src/http-server.ts's toolGateCopy body -- neither contains `mintRisk`).

  test("fetchMintStateAtT: fetched=true when getAccountInfo returns a real account value", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { mintAuthority: null, freezeAuthority: "FreezeAuth111111111111111111111111111111" } } } } },
      });
    try {
      const state = await fetchMintStateAtT("SomeMint1111111111111111111111111111111", null);
      assert.equal(state.fetched, true);
      assert.equal(state.freezeAuthority, "FreezeAuth111111111111111111111111111111");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetchMintStateAtT: fetched=false when getAccountInfo returns a null value (account not found)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: null } });
    try {
      const state = await fetchMintStateAtT("SomeMint2222222222222222222222222222222", null);
      assert.equal(state.fetched, false);
      assert.equal(state.mintAuthority, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetchMintStateAtT: fetched=false (not throw) on RPC network failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNRESET");
    };
    try {
      const state = await fetchMintStateAtT("SomeMint3333333333333333333333333333333", null);
      assert.equal(state.fetched, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runCollectionCycle: verdict_unconfirmed_mint_check is true when a real verdict came back but the collector's own mint fetch failed", async () => {
    const pair = "PairUnconfirmed11111111111111111111111111";
    const mint = "MintUnconfirmed11111111111111111111111111";
    const creator = "CreatorUnconfirmed1111111111111111111111111";
    const buyer = "BuyerUnconfirmed11111111111111111111111111";
    const creationSig = { signature: "creationSigUC", blockTime: 5000 };
    const buySig = { signature: "buySigUC", blockTime: 5010 };
    const freshPoolCreatedAtIso = new Date(Date.now() - 60_000).toISOString(); // frozen before the mock runs -- see comment in the RADAR_ERROR abort test above

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("geckoterminal.com")) {
        return jsonResponse({
          data: [
            {
              attributes: { address: pair, pool_created_at: freshPoolCreatedAtIso },
              relationships: { dex: { data: { id: "raydium" } }, base_token: { data: { id: `solana_${mint}` } } },
            },
          ],
        });
      }
      if (url.includes("dexscreener.com")) {
        return jsonResponse({ pairs: [{ pairCreatedAt: Date.now() - 60_000 }] });
      }
      if (url.includes("/gate-copy")) {
        return jsonResponse({ allow: true, action: "allow", riskScore: 5 }, 200); // a REAL verdict
      }
      const body = JSON.parse(init.body);
      if (body.method === "getAccountInfo") {
        const addr = body.params[0];
        if (addr === mint) return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: null } }); // mint fetch FAILS (task 2)
        if (addr === buyer) return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "11111111111111111111111111111111", executable: false } } });
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: null } });
      }
      if (body.method === "getSignaturesForAddress") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: [buySig, creationSig] });
      }
      if (body.method === "getTransaction") {
        const sig = body.params[0];
        if (sig === creationSig.signature) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { transaction: { message: { accountKeys: [creator] } }, blockTime: creationSig.blockTime } });
        }
        if (sig === buySig.signature) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: { blockTime: buySig.blockTime, meta: { preTokenBalances: [], postTokenBalances: [{ mint, owner: buyer, accountIndex: 0, uiTokenAmount: { amount: "1" } }] } },
          });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
    };

    try {
      const result = await runCollectionCycle({ dbPath: ":memory:", radarUrl: "http://fake-radar", limit: 1 });
      assert.equal(result.rows.length, 1);
      const row = result.rows[0];
      assert.equal(row.http_status, 200, "a real verdict must have come back");
      assert.ok(row.radar_verdict, "radar_verdict must be populated -- this was a real 200 response");
      assert.equal(row.mint_metadata_fetched, false, "the collector's own getAccountInfo(mint) failed");
      assert.equal(row.verdict_unconfirmed_mint_check, true, "a verdict exists but with no confirmed mint check backing it");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runCollectionCycle: verdict_unconfirmed_mint_check is false when the collector's own mint fetch succeeded", async () => {
    const pair = "PairConfirmed111111111111111111111111111";
    const mint = "MintConfirmed111111111111111111111111111";
    const creator = "CreatorConfirmed11111111111111111111111111";
    const buyer = "BuyerConfirmed111111111111111111111111111";
    const creationSig = { signature: "creationSigC", blockTime: 6000 };
    const buySig = { signature: "buySigC", blockTime: 6010 };
    const freshPoolCreatedAtIso = new Date(Date.now() - 60_000).toISOString(); // frozen before the mock runs -- see comment in the RADAR_ERROR abort test above

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("geckoterminal.com")) {
        return jsonResponse({
          data: [
            {
              attributes: { address: pair, pool_created_at: freshPoolCreatedAtIso },
              relationships: { dex: { data: { id: "raydium" } }, base_token: { data: { id: `solana_${mint}` } } },
            },
          ],
        });
      }
      if (url.includes("dexscreener.com")) {
        return jsonResponse({ pairs: [{ pairCreatedAt: Date.now() - 60_000 }] });
      }
      if (url.includes("/gate-copy")) {
        return jsonResponse({ allow: true, action: "allow", riskScore: 5 }, 200);
      }
      const body = JSON.parse(init.body);
      if (body.method === "getAccountInfo") {
        const addr = body.params[0];
        if (addr === mint) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: {} } } } } }); // mint fetch SUCCEEDS
        }
        if (addr === buyer) return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "11111111111111111111111111111111", executable: false } } });
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: null } });
      }
      if (body.method === "getSignaturesForAddress") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: [buySig, creationSig] });
      }
      if (body.method === "getTransaction") {
        const sig = body.params[0];
        if (sig === creationSig.signature) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { transaction: { message: { accountKeys: [creator] } }, blockTime: creationSig.blockTime } });
        }
        if (sig === buySig.signature) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: { blockTime: buySig.blockTime, meta: { preTokenBalances: [], postTokenBalances: [{ mint, owner: buyer, accountIndex: 0, uiTokenAmount: { amount: "1" } }] } },
          });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
    };

    try {
      const result = await runCollectionCycle({ dbPath: ":memory:", radarUrl: "http://fake-radar", limit: 1 });
      assert.equal(result.rows.length, 1);
      const row = result.rows[0];
      assert.equal(row.mint_metadata_fetched, true);
      assert.equal(row.verdict_unconfirmed_mint_check, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- Task 3 (stage 7E): radar_token_check_missing ---
  // Determined by reading src/simulate.ts (wouldTrigger, TOXIC_MINT fires only on
  // freezeAuthority, simulate.ts:324) and src/http-server.ts's toolGateCopy (431-548):
  // details.simulation is absent entirely when trustResult.verdict is "hold"/"unknown"
  // (simulatePayment never runs) -- that case must be NOT_DETERMINABLE, never a guess.

  test("determineRadarTokenCheckMissing: false when mint has no authority at all (nothing for TOXIC_MINT to fire on)", () => {
    const res = determineRadarTokenCheckMissing({ mintAuthority: null, freezeAuthority: null }, "SomeMint1111111111111111111111111111111", { details: { simulation: { wouldTrigger: [] } } });
    assert.equal(res, false);
  });

  test("determineRadarTokenCheckMissing: false for a MAJOR_MINTS/KNOWN_SAFE_MINTS mint even with authority (correctly whitelisted)", () => {
    assert.ok(MAJOR_MINTS.length > 0, "sanity: real MAJOR_MINTS imported from dist/src/types.js");
    const usdc = MAJOR_MINTS[1]; // USDC -- has no live authority in reality, but we force one here to isolate the whitelist branch
    const res = determineRadarTokenCheckMissing({ mintAuthority: null, freezeAuthority: "SomeFreezeAuth111111111111111111111111111" }, usdc, { details: { simulation: { wouldTrigger: [] } } });
    assert.equal(res, false);
    assert.ok(KNOWN_SAFE_MINTS.has(usdc), "sanity: also present in KNOWN_SAFE_MINTS");
  });

  test("determineRadarTokenCheckMissing: false when TOXIC_MINT actually fired (check happened and worked)", () => {
    const res = determineRadarTokenCheckMissing(
      { mintAuthority: null, freezeAuthority: "FreezeAuth111111111111111111111111111111" },
      "RiskyMint1111111111111111111111111111111",
      { details: { simulation: { wouldTrigger: ["TOXIC_MINT"] } } }
    );
    assert.equal(res, false);
  });

  test("determineRadarTokenCheckMissing: true when mint has active freeze/mint authority, isn't whitelisted, and TOXIC_MINT did NOT fire", () => {
    const res = determineRadarTokenCheckMissing(
      { mintAuthority: null, freezeAuthority: "FreezeAuth222222222222222222222222222222" },
      "RiskyMint2222222222222222222222222222222",
      { details: { simulation: { wouldTrigger: [] } } }
    );
    assert.equal(res, true);
  });

  test("determineRadarTokenCheckMissing: NOT_DETERMINABLE when details.simulation is absent (trust check blocked before simulatePayment ran)", () => {
    // Exactly the shape toolGateCopy returns for verdict==="hold" or "unknown" (http-server.ts:444-461) -- no `simulation` key at all.
    const blockedEarly = { allow: false, reason: "BLOCKED by pre-trade firewall: ...", action: "block", riskScore: 80, maxSafeAmountUsd: 0, details: { trust: { verdict: "hold" } } };
    const res = determineRadarTokenCheckMissing({ mintAuthority: null, freezeAuthority: "FreezeAuth333333333333333333333333333333" }, "RiskyMint3333333333333333333333333333333", blockedEarly);
    assert.equal(res, "NOT_DETERMINABLE");
  });

  test("runCollectionCycle: radar_token_check_missing populated end-to-end with mocked network (TOXIC_MINT absent despite active freezeAuthority)", async () => {
    const pair = "PairTokenCheck111111111111111111111111111";
    const mint = "MintTokenCheck111111111111111111111111111";
    const creator = "CreatorTokenCheck11111111111111111111111111";
    const buyer = "BuyerTokenCheck111111111111111111111111111";
    const creationSig = { signature: "creationSigTC", blockTime: 7000 };
    const buySig = { signature: "buySigTC", blockTime: 7010 };
    const freshPoolCreatedAtIso = new Date(Date.now() - 60_000).toISOString();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("geckoterminal.com")) {
        return jsonResponse({
          data: [
            {
              attributes: { address: pair, pool_created_at: freshPoolCreatedAtIso },
              relationships: { dex: { data: { id: "raydium" } }, base_token: { data: { id: `solana_${mint}` } } },
            },
          ],
        });
      }
      if (url.includes("dexscreener.com")) {
        return jsonResponse({ pairs: [{ pairCreatedAt: Date.now() - 60_000 }] });
      }
      if (url.includes("/gate-copy")) {
        // A real 200 verdict where simulation ran but TOXIC_MINT did not fire.
        return jsonResponse({ allow: true, action: "allow", riskScore: 10, details: { simulation: { wouldTrigger: [] } } }, 200);
      }
      const body = JSON.parse(init.body);
      if (body.method === "getAccountInfo") {
        const addr = body.params[0];
        if (addr === mint) {
          // Mint HAS an active freezeAuthority -- strat B, and a candidate for radar_token_check_missing.
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { freezeAuthority: "FreezeAuthTC1111111111111111111111111111" } } } } },
          });
        }
        if (addr === buyer) return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "11111111111111111111111111111111", executable: false } } });
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: null } });
      }
      if (body.method === "getSignaturesForAddress") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: [buySig, creationSig] });
      }
      if (body.method === "getTransaction") {
        const sig = body.params[0];
        if (sig === creationSig.signature) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { transaction: { message: { accountKeys: [creator] } }, blockTime: creationSig.blockTime } });
        }
        if (sig === buySig.signature) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: { blockTime: buySig.blockTime, meta: { preTokenBalances: [], postTokenBalances: [{ mint, owner: buyer, accountIndex: 0, uiTokenAmount: { amount: "1" } }] } },
          });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
    };

    try {
      const result = await runCollectionCycle({ dbPath: ":memory:", radarUrl: "http://fake-radar", limit: 1 });
      assert.equal(result.rows.length, 1);
      const row = result.rows[0];
      assert.equal(row.strat, "B", "active freezeAuthority -> strat B");
      assert.equal(row.radar_token_check_missing, true, "TOXIC_MINT should have been checkable and didn't fire -- flagged missing");
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
      mint_metadata_fetched: true,
      verdict_unconfirmed_mint_check: false,
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
    assert.equal(stored.mint_metadata_fetched, "true");
    assert.equal(stored.verdict_unconfirmed_mint_check, "false");
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
