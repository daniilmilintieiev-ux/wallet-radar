import { extractSwap } from "./analyzer.js";
import { swapUsdValue, UsdPriceMap } from "./pricing.js";
import {
  EnhancedTx,
  OpenLot,
  PnlSummary,
  SOL_MINT,
  SwapEvent,
  USDC_MINT,
  USDT_MINT,
} from "./types.js";

export { OpenLot };

const QUOTE_PRIORITY = [USDC_MINT, USDT_MINT, SOL_MINT];

/**
 * Realized PnL (PnL-lite) values every trade leg at the CURRENT spot price
 * (Jupiter feed), not the historical price at trade time. Valuing a trade from
 * months ago at today's spot distorts the result (a token that has since moved
 * 100x). To keep the approximation honest, realized matching is bounded to a
 * recent window: only legs within the last PNL_WINDOW_DAYS (relative to the
 * NEWEST leg in the batch, not the wall clock) participate in FIFO matching.
 * Open buy lots carried over from the previous scan (initialLots) are kept as
 * the cost basis for those recent legs. (Audit 3.1)
 */
export const PNL_WINDOW_DAYS = 30;

export interface TradeLeg {
  pair: string;
  baseMint: string;
  quoteMint: string;
  side: "BUY" | "SELL";
  amount: number;
  usdValue: number;
  timestamp: number;
}

export function classifyTradeLeg(swap: SwapEvent, prices: UsdPriceMap): TradeLeg | null {
  if (!swap) return null;
  const usd = swapUsdValue(swap, prices);
  if (usd === null || usd <= 0) return null;

  const mIn = swap.tokenIn?.mint;
  const mOut = swap.tokenOut?.mint;
  if (!mIn || !mOut || mIn === mOut) return null;

  const inQuoteIdx = QUOTE_PRIORITY.indexOf(mIn);
  const outQuoteIdx = QUOTE_PRIORITY.indexOf(mOut);

  let baseMint: string;
  let quoteMint: string;
  let side: "BUY" | "SELL";
  let amount: number;

  if (inQuoteIdx !== -1 && outQuoteIdx === -1) {
    quoteMint = mIn;
    baseMint = mOut;
    side = "BUY";
    amount = swap.tokenOut.amount;
  } else if (outQuoteIdx !== -1 && inQuoteIdx === -1) {
    quoteMint = mOut;
    baseMint = mIn;
    side = "SELL";
    amount = swap.tokenIn.amount;
  } else if (inQuoteIdx !== -1 && outQuoteIdx !== -1) {
    if (inQuoteIdx > outQuoteIdx) {
      baseMint = mIn;
      quoteMint = mOut;
      side = "SELL";
      amount = swap.tokenIn.amount;
    } else {
      baseMint = mOut;
      quoteMint = mIn;
      side = "BUY";
      amount = swap.tokenOut.amount;
    }
  } else {
    const sorted = [mIn, mOut].sort();
    baseMint = sorted[0];
    quoteMint = sorted[1];
    if (mIn === quoteMint) {
      side = "BUY";
      amount = swap.tokenOut.amount;
    } else {
      side = "SELL";
      amount = swap.tokenIn.amount;
    }
  }

  if (!amount || amount <= 0) return null;

  return {
    pair: `${baseMint}/${quoteMint}`,
    baseMint,
    quoteMint,
    side,
    amount,
    usdValue: usd,
    timestamp: swap.timestamp ?? 0,
  };
}

export interface PnlBatchResult extends PnlSummary {
  openLots?: Record<string, OpenLot[]>;
}

export function computePnlLite(
  txs: EnhancedTx[],
  prices: UsdPriceMap | null,
  initialLots?: Record<string, OpenLot[]>,
  wallet?: string,
): PnlBatchResult {
  const defaultEmpty: PnlBatchResult = {
    realizedUsd: null,
    winRate: null,
    roundTrips: 0,
    openLots: initialLots ? { ...initialLots } : undefined,
  };

  if (!txs || txs.length === 0 || !prices) {
    return { ...defaultEmpty, windowDays: PNL_WINDOW_DAYS };
  }

  // If txs is ordered descending (newest first, typical of Helius), reverse to chronological
  const isDescending =
    txs.length > 1 && (txs[0].timestamp ?? 0) > (txs[txs.length - 1].timestamp ?? 0);
  const orderedTxs = isDescending ? [...txs].reverse() : txs;

  const legs: TradeLeg[] = [];
  for (const tx of orderedTxs) {
    const swap = extractSwap(tx, wallet);
    if (!swap) continue;
    const leg = classifyTradeLeg(swap, prices);
    if (leg) legs.push(leg);
  }

  if (legs.length === 0 && (!initialLots || Object.keys(initialLots).length === 0)) {
    return { ...defaultEmpty, windowDays: PNL_WINDOW_DAYS };
  }

  legs.sort((a, b) => a.timestamp - b.timestamp);

  // (Audit 3.1) Bound realized matching to the recent window. Prices are the
  // current spot, so legs older than PNL_WINDOW_DAYS (relative to the newest
  // leg, not the wall clock) are priced too far from the spot reference to be
  // meaningful and are dropped from FIFO. Legs with a missing/zero timestamp
  // (fixtures) are kept only when there is no real newest timestamp, so
  // fixture behavior is unchanged.
  const newestLegTs = legs.length > 0 ? legs[legs.length - 1].timestamp : 0;
  const windowStartSec = newestLegTs > 0 ? newestLegTs - PNL_WINDOW_DAYS * 86_400 : 0;
  const windowedLegs =
    newestLegTs > 0 ? legs.filter((l) => l.timestamp > 0 && l.timestamp >= windowStartSec) : legs;

  const buyQueues = new Map<string, OpenLot[]>();
  if (initialLots) {
    for (const [pair, lots] of Object.entries(initialLots)) {
      buyQueues.set(
        pair,
        lots.map((l) => ({ amount: l.amount, pricePerUnit: l.pricePerUnit })),
      );
    }
  }

  let totalRealizedUsd = 0;
  let totalRoundTrips = 0;
  let positiveRoundTrips = 0;

  for (const leg of windowedLegs) {
    const queue = buyQueues.get(leg.pair) ?? [];
    if (leg.side === "BUY") {
      queue.push({
        amount: leg.amount,
        pricePerUnit: leg.usdValue / leg.amount,
      });
      buyQueues.set(leg.pair, queue);
    } else if (leg.side === "SELL") {
      let remainingToSell = leg.amount;
      const sellPricePerUnit = leg.usdValue / leg.amount;
      let matchedAmount = 0;
      let costBasis = 0;

      while (remainingToSell > 0 && queue.length > 0) {
        const oldestBuy = queue[0];
        const takeAmount = Math.min(remainingToSell, oldestBuy.amount);
        costBasis += takeAmount * oldestBuy.pricePerUnit;
        matchedAmount += takeAmount;
        oldestBuy.amount -= takeAmount;
        remainingToSell -= takeAmount;

        if (oldestBuy.amount <= 1e-9) {
          queue.shift();
        }
      }

      if (matchedAmount > 0) {
        const proceeds = matchedAmount * sellPricePerUnit;
        const pnl = proceeds - costBasis;
        totalRealizedUsd += pnl;
        totalRoundTrips += 1;
        if (pnl > 0.000001) {
          positiveRoundTrips += 1;
        }
      }
      buyQueues.set(leg.pair, queue);
    }
  }

  const remainingOpenLots: Record<string, OpenLot[]> = {};
  for (const [pair, queue] of buyQueues.entries()) {
    if (queue.length > 0) {
      // Report every open lot (not just the last 20) so the reported open
      // position matches the actual unmatched buy queue used for cost basis.
      remainingOpenLots[pair] = queue.map((lot) => ({
        amount: Math.round(lot.amount * 1e9) / 1e9,
        pricePerUnit: Math.round(lot.pricePerUnit * 1e6) / 1e6,
      }));
    }
  }

  if (totalRoundTrips === 0) {
    return {
      realizedUsd: null,
      winRate: null,
      roundTrips: 0,
      openLots: remainingOpenLots,
      windowDays: PNL_WINDOW_DAYS,
    };
  }

  let realizedUsd = Math.round(totalRealizedUsd * 100) / 100;
  if (realizedUsd === 0) realizedUsd = 0;
  const winRate = Math.round((positiveRoundTrips / totalRoundTrips) * 100) / 100;

  return {
    realizedUsd,
    winRate,
    roundTrips: totalRoundTrips,
    openLots: remainingOpenLots,
    windowDays: PNL_WINDOW_DAYS,
  };
}

export function mergePnl(prev: PnlSummary | undefined, next: PnlSummary): PnlSummary {
  if (!prev || prev.realizedUsd === null) return next;
  if (next.realizedUsd === null || next.roundTrips === 0) return prev;

  const totalRoundTrips = prev.roundTrips + next.roundTrips;
  const windowDays = next.windowDays ?? prev.windowDays;
  if (totalRoundTrips === 0) {
    return { realizedUsd: null, winRate: null, roundTrips: 0, windowDays };
  }

  const prevWins = Math.round((prev.winRate ?? 0) * prev.roundTrips);
  const nextWins = Math.round((next.winRate ?? 0) * next.roundTrips);
  const totalWins = prevWins + nextWins;

  let totalRealizedUsd = Math.round(((prev.realizedUsd ?? 0) + (next.realizedUsd ?? 0)) * 100) / 100;
  if (totalRealizedUsd === 0) totalRealizedUsd = 0;
  const winRate = Math.round((totalWins / totalRoundTrips) * 100) / 100;

  return {
    realizedUsd: totalRealizedUsd,
    winRate,
    roundTrips: totalRoundTrips,
    windowDays,
  };
}
