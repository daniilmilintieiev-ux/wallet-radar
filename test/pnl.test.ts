import test from "node:test";
import assert from "node:assert/strict";
import { classifyTradeLeg, computePnlLite, mergePnl, PNL_WINDOW_DAYS } from "../src/pnl.js";
import { updateBaseline } from "../src/baseline.js";
import { EnhancedTx, SOL_MINT, USDC_MINT, USDT_MINT } from "../src/types.js";

const TOKEN_A = "TokenA11111111111111111111111111111111111111";
const TOKEN_B = "TokenB11111111111111111111111111111111111111";
const UNPRICED_TOKEN = "Unpriced11111111111111111111111111111111111";
const WALLET = "Wallet111111111111111111111111111111111111111";

function makeSwapTx(
  sig: string,
  timestamp: number,
  inMint: string,
  inAmount: number,
  inDecimals: number,
  outMint: string,
  outAmount: number,
  outDecimals: number,
): EnhancedTx {
  return {
    signature: sig,
    timestamp,
    source: "JUPITER",
    swap: {
      tokenInputs: [
        {
          mint: inMint,
          rawTokenAmount: {
            tokenAmount: String(Math.round(inAmount * 10 ** inDecimals)),
            decimals: inDecimals,
          },
        },
      ],
      tokenOutputs: [
        {
          mint: outMint,
          rawTokenAmount: {
            tokenAmount: String(Math.round(outAmount * 10 ** outDecimals)),
            decimals: outDecimals,
          },
        },
      ],
    },
  };
}

test("classifyTradeLeg: correctly classifies buy and sell against quote mints", () => {
  const prices = { [USDC_MINT]: 1.0, [SOL_MINT]: 100.0 };

  // Buy TOKEN_A with USDC
  const buyTx = makeSwapTx("s1", 1000, USDC_MINT, 100, 6, TOKEN_A, 50, 6);
  const buyLeg = classifyTradeLeg(buyTx.swap ? {
    dex: "JUPITER",
    signature: "s1",
    timestamp: 1000,
    tokenIn: { mint: USDC_MINT, amount: 100 },
    tokenOut: { mint: TOKEN_A, amount: 50 },
  } : null as any, prices);

  assert.ok(buyLeg);
  assert.equal(buyLeg.pair, `${TOKEN_A}/${USDC_MINT}`);
  assert.equal(buyLeg.baseMint, TOKEN_A);
  assert.equal(buyLeg.quoteMint, USDC_MINT);
  assert.equal(buyLeg.side, "BUY");
  assert.equal(buyLeg.amount, 50);
  assert.equal(buyLeg.usdValue, 100);

  // Sell TOKEN_A for USDC
  const sellLeg = classifyTradeLeg({
    dex: "JUPITER",
    signature: "s2",
    timestamp: 2000,
    tokenIn: { mint: TOKEN_A, amount: 50 },
    tokenOut: { mint: USDC_MINT, amount: 150 },
  }, prices);

  assert.ok(sellLeg);
  assert.equal(sellLeg.pair, `${TOKEN_A}/${USDC_MINT}`);
  assert.equal(sellLeg.side, "SELL");
  assert.equal(sellLeg.amount, 50);
  assert.equal(sellLeg.usdValue, 150);

  // Buy SOL with USDC: SOL is base, USDC is quote
  const buySolLeg = classifyTradeLeg({
    dex: "JUPITER",
    signature: "s3",
    timestamp: 3000,
    tokenIn: { mint: USDC_MINT, amount: 200 },
    tokenOut: { mint: SOL_MINT, amount: 2 },
  }, prices);

  assert.ok(buySolLeg);
  assert.equal(buySolLeg.pair, `${SOL_MINT}/${USDC_MINT}`);
  assert.equal(buySolLeg.side, "BUY");
  assert.equal(buySolLeg.amount, 2);

  // Sell SOL for USDC
  const sellSolLeg = classifyTradeLeg({
    dex: "JUPITER",
    signature: "s4",
    timestamp: 4000,
    tokenIn: { mint: SOL_MINT, amount: 2 },
    tokenOut: { mint: USDC_MINT, amount: 250 },
  }, prices);

  assert.ok(sellSolLeg);
  assert.equal(sellSolLeg.pair, `${SOL_MINT}/${USDC_MINT}`);
  assert.equal(sellSolLeg.side, "SELL");
  assert.equal(sellSolLeg.amount, 2);

  // Unpriced pair returns null
  const unpricedLeg = classifyTradeLeg({
    dex: "JUPITER",
    signature: "s5",
    timestamp: 5000,
    tokenIn: { mint: UNPRICED_TOKEN, amount: 10 },
    tokenOut: { mint: TOKEN_A, amount: 20 },
  }, {});
  assert.equal(unpricedLeg, null);
});

test("computePnlLite: synthetic sequence with gain", () => {
  const prices = { [USDC_MINT]: 1.0 };
  const txs: EnhancedTx[] = [
    // Buy 100 TOKEN_A for 100 USDC ($1/token) at t=100
    makeSwapTx("b1", 100, USDC_MINT, 100, 6, TOKEN_A, 100, 6),
    // Sell 100 TOKEN_A for 150 USDC ($1.50/token) at t=200
    makeSwapTx("s1", 200, TOKEN_A, 100, 6, USDC_MINT, 150, 6),
  ];

  const res = computePnlLite(txs, prices);
  assert.equal(res.realizedUsd, 50);
  assert.equal(res.winRate, 1.0);
  assert.equal(res.roundTrips, 1);
});

test("computePnlLite: synthetic sequence with loss", () => {
  const prices = { [USDC_MINT]: 1.0 };
  const txs: EnhancedTx[] = [
    // Buy 100 TOKEN_A for 200 USDC ($2/token) at t=100
    makeSwapTx("b1", 100, USDC_MINT, 200, 6, TOKEN_A, 100, 6),
    // Sell 100 TOKEN_A for 80 USDC ($0.80/token) at t=200
    makeSwapTx("s1", 200, TOKEN_A, 100, 6, USDC_MINT, 80, 6),
  ];

  const res = computePnlLite(txs, prices);
  assert.equal(res.realizedUsd, -120);
  assert.equal(res.winRate, 0.0);
  assert.equal(res.roundTrips, 1);
});

test("computePnlLite: scaling out (partial sells with mixed profit/loss)", () => {
  const prices = { [USDC_MINT]: 1.0 };
  const txs: EnhancedTx[] = [
    // Buy 100 TOKEN_A for 100 USDC ($1/token) at t=100
    makeSwapTx("b1", 100, USDC_MINT, 100, 6, TOKEN_A, 100, 6),
    // Sell 40 TOKEN_A for 60 USDC ($1.50/token -> +$20 profit) at t=200
    makeSwapTx("s1", 200, TOKEN_A, 40, 6, USDC_MINT, 60, 6),
    // Sell 60 TOKEN_A for 30 USDC ($0.50/token -> -$30 loss) at t=300
    makeSwapTx("s2", 300, TOKEN_A, 60, 6, USDC_MINT, 30, 6),
  ];

  const res = computePnlLite(txs, prices);
  assert.equal(res.realizedUsd, -10);
  assert.equal(res.winRate, 0.5);
  assert.equal(res.roundTrips, 2);
});

test("computePnlLite: DCA buys into single sell", () => {
  const prices = { [USDC_MINT]: 1.0 };
  const txs: EnhancedTx[] = [
    // Buy 50 TOKEN_A for 50 USDC ($1/token) at t=100
    makeSwapTx("b1", 100, USDC_MINT, 50, 6, TOKEN_A, 50, 6),
    // Buy 50 TOKEN_A for 100 USDC ($2/token) at t=200
    makeSwapTx("b2", 200, USDC_MINT, 100, 6, TOKEN_A, 50, 6),
    // Sell 100 TOKEN_A for 200 USDC ($2/token) at t=300
    // FIFO: 50 @ $1 costBasis=$50 sold for $100 -> +$50; 50 @ $2 costBasis=$100 sold for $100 -> $0
    makeSwapTx("s1", 300, TOKEN_A, 100, 6, USDC_MINT, 200, 6),
  ];

  const res = computePnlLite(txs, prices);
  assert.equal(res.realizedUsd, 50);
  assert.equal(res.winRate, 1.0);
  assert.equal(res.roundTrips, 1);
});

test("computePnlLite: multiple token pairs aggregated correctly", () => {
  const prices = { [USDC_MINT]: 1.0, [SOL_MINT]: 100.0 };
  const txs: EnhancedTx[] = [
    // Pair 1: TOKEN_A/USDC -> Buy 10 @ $10, Sell 10 @ $20 -> +$100 (win)
    makeSwapTx("a_b", 100, USDC_MINT, 100, 6, TOKEN_A, 10, 6),
    makeSwapTx("a_s", 200, TOKEN_A, 10, 6, USDC_MINT, 200, 6),

    // Pair 2: TOKEN_B/SOL -> Buy 100 for 1 SOL ($100), Sell 100 for 0.6 SOL ($60) -> -$40 (loss)
    makeSwapTx("b_b", 150, SOL_MINT, 1, 9, TOKEN_B, 100, 6),
    makeSwapTx("b_s", 250, TOKEN_B, 100, 6, SOL_MINT, 0.6, 9),
  ];

  const res = computePnlLite(txs, prices);
  assert.equal(res.realizedUsd, 60);
  assert.equal(res.winRate, 0.5);
  assert.equal(res.roundTrips, 2);
});

test("computePnlLite edge cases: empty history, one-sided legs, missing prices emit null", () => {
  const prices = { [USDC_MINT]: 1.0 };

  // 1. Empty history -> nulls
  const emptyRes = computePnlLite([], prices);
  assert.deepEqual(emptyRes, { realizedUsd: null, winRate: null, roundTrips: 0, openLots: undefined, windowDays: PNL_WINDOW_DAYS });

  // 2. One-sided buys (no sells) -> nulls
  const buysOnly = [makeSwapTx("b1", 100, USDC_MINT, 100, 6, TOKEN_A, 100, 6)];
  const buysRes = computePnlLite(buysOnly, prices);
  assert.equal(buysRes.realizedUsd, null);
  assert.equal(buysRes.winRate, null);
  assert.equal(buysRes.roundTrips, 0);
  assert.ok(buysRes.openLots?.[`${TOKEN_A}/${USDC_MINT}`]);

  // 3. One-sided sells (no prior buys in history) -> nulls (cannot guess cost basis)
  const sellsOnly = [makeSwapTx("s1", 200, TOKEN_A, 100, 6, USDC_MINT, 150, 6)];
  const sellsRes = computePnlLite(sellsOnly, prices);
  assert.equal(sellsRes.realizedUsd, null);
  assert.equal(sellsRes.winRate, null);
  assert.equal(sellsRes.roundTrips, 0);

  // 4. Missing prices (prices === null) -> nulls
  const noPricesRes = computePnlLite(buysOnly, null);
  assert.deepEqual(noPricesRes, { realizedUsd: null, winRate: null, roundTrips: 0, openLots: undefined, windowDays: PNL_WINDOW_DAYS });

  // 5. Unpriced tokens (neither leg priceable) -> nulls
  const unpricedTxs = [
    makeSwapTx("u1", 100, UNPRICED_TOKEN, 100, 6, TOKEN_A, 100, 6),
    makeSwapTx("u2", 200, TOKEN_A, 100, 6, UNPRICED_TOKEN, 150, 6),
  ];
  const unpricedRes = computePnlLite(unpricedTxs, {});
  assert.equal(unpricedRes.realizedUsd, null);
  assert.equal(unpricedRes.winRate, null);
  assert.equal(unpricedRes.roundTrips, 0);
});

test("computePnlLite: handles descending order from Helius correctly", () => {
  const prices = { [USDC_MINT]: 1.0 };
  // Descending: newest first (s1 at t=200, then b1 at t=100)
  const txs: EnhancedTx[] = [
    makeSwapTx("s1", 200, TOKEN_A, 100, 6, USDC_MINT, 150, 6),
    makeSwapTx("b1", 100, USDC_MINT, 100, 6, TOKEN_A, 100, 6),
  ];

  const res = computePnlLite(txs, prices);
  assert.equal(res.realizedUsd, 50);
  assert.equal(res.winRate, 1.0);
  assert.equal(res.roundTrips, 1);
});

test("computePnlLite: cross-batch FIFO matching via initialLots", () => {
  const prices = { [USDC_MINT]: 1.0 };

  // Batch 1: Buy 100 TOKEN_A for 100 USDC ($1/token)
  const batch1 = [makeSwapTx("b1", 100, USDC_MINT, 100, 6, TOKEN_A, 100, 6)];
  const res1 = computePnlLite(batch1, prices);
  assert.equal(res1.realizedUsd, null);
  assert.equal(res1.roundTrips, 0);
  assert.ok(res1.openLots);

  // Batch 2: Sell 100 TOKEN_A for 200 USDC ($2/token) matching batch 1 lots
  const batch2 = [makeSwapTx("s1", 200, TOKEN_A, 100, 6, USDC_MINT, 200, 6)];
  const res2 = computePnlLite(batch2, prices, res1.openLots);
  assert.equal(res2.realizedUsd, 100);
  assert.equal(res2.winRate, 1.0);
  assert.equal(res2.roundTrips, 1);
});

test("audit 3.1: legs older than the 30d window are dropped from FIFO (stale cost basis)", () => {
  const prices = { [USDC_MINT]: 1.0 };
  const DAY = 86_400;
  const T = 1_700_000_000;
  // Old buy 40 days before the newest leg -> outside the 30d window, so its
  // cost basis is stale (priced at today's spot) and must be dropped.
  const oldBuy = makeSwapTx("b_old", T - 40 * DAY, USDC_MINT, 100, 6, TOKEN_A, 100, 6);
  // Recent sell at the newest timestamp -> inside the window but with no
  // in-window cost basis to match, so realized PnL must be null (not +$50).
  const recentSell = makeSwapTx("s_recent", T, TOKEN_A, 100, 6, USDC_MINT, 150, 6);

  const res = computePnlLite([oldBuy, recentSell], prices);
  assert.equal(res.realizedUsd, null);
  assert.equal(res.winRate, null);
  assert.equal(res.roundTrips, 0);
  assert.equal(res.windowDays, PNL_WINDOW_DAYS);
});

test("audit 3.1: an in-window round-trip still realizes PnL", () => {
  const prices = { [USDC_MINT]: 1.0 };
  const DAY = 86_400;
  const T = 1_700_000_000;
  // Buy 5 days before the newest leg and sell at the newest leg -> both inside
  // the 30d window, so the round-trip is realized as usual (+$50).
  const inWindowBuy = makeSwapTx("b", T - 5 * DAY, USDC_MINT, 100, 6, TOKEN_A, 100, 6);
  const inWindowSell = makeSwapTx("s", T, TOKEN_A, 100, 6, USDC_MINT, 150, 6);

  const res = computePnlLite([inWindowBuy, inWindowSell], prices);
  assert.equal(res.realizedUsd, 50);
  assert.equal(res.winRate, 1.0);
  assert.equal(res.roundTrips, 1);
  assert.equal(res.windowDays, PNL_WINDOW_DAYS);
});

test("audit 3.1: carried-over initialLots remain usable as cost basis", () => {
  const prices = { [USDC_MINT]: 1.0 };
  const DAY = 86_400;
  const T = 1_700_000_000;
  // Previous scan saw a buy 100 days ago -> recorded as an open lot.
  const oldBatch = [makeSwapTx("b_old", T - 100 * DAY, USDC_MINT, 100, 6, TOKEN_A, 100, 6)];
  const res1 = computePnlLite(oldBatch, prices);
  assert.ok(res1.openLots?.[`${TOKEN_A}/${USDC_MINT}`]);

  // Current scan sells at the newest timestamp. The in-window sell matches the
  // carried-over open lot (initialLots are kept as cost basis), realizing +$50.
  const curBatch = [makeSwapTx("s_now", T, TOKEN_A, 100, 6, USDC_MINT, 150, 6)];
  const res2 = computePnlLite(curBatch, prices, res1.openLots);
  assert.equal(res2.realizedUsd, 50);
  assert.equal(res2.winRate, 1.0);
  assert.equal(res2.roundTrips, 1);
});

test("mergePnl: combines summaries and handles nulls", () => {
  // Both valid
  const p1 = { realizedUsd: 100, winRate: 1.0, roundTrips: 1 };
  const p2 = { realizedUsd: -40, winRate: 0.0, roundTrips: 1 };
  const merged = mergePnl(p1, p2);
  assert.equal(merged.realizedUsd, 60);
  assert.equal(merged.winRate, 0.5);
  assert.equal(merged.roundTrips, 2);

  // Prev is null
  const nullPnl = { realizedUsd: null, winRate: null, roundTrips: 0 };
  assert.deepEqual(mergePnl(nullPnl, p1), p1);

  // Next is null or 0 round trips
  assert.deepEqual(mergePnl(p1, nullPnl), p1);

  // Both null
  assert.deepEqual(mergePnl(nullPnl, nullPnl), nullPnl);
});

test("updateBaseline: populates pnl and maintains cross-batch state", () => {
  const prices = { [USDC_MINT]: 1.0 };

  // 1. First seed with only buys -> baseline.pnl is nulls, openLots has TOKEN_A
  const batch1 = [makeSwapTx("b1", 100, USDC_MINT, 100, 6, TOKEN_A, 100, 6)];
  const b1 = updateBaseline(WALLET, null, batch1, 150, prices);
  assert.deepEqual(b1.pnl, { realizedUsd: null, winRate: null, roundTrips: 0, windowDays: PNL_WINDOW_DAYS });
  assert.ok(b1.openLots?.[`${TOKEN_A}/${USDC_MINT}`]);

  // 2. Incremental poll with sell -> matches openLots from b1, realizes profit
  const batch2 = [makeSwapTx("s1", 200, TOKEN_A, 100, 6, USDC_MINT, 180, 6)];
  const b2 = updateBaseline(WALLET, b1, batch2, 250, prices);
  assert.deepEqual(b2.pnl, { realizedUsd: 80, winRate: 1.0, roundTrips: 1, windowDays: PNL_WINDOW_DAYS });
});
