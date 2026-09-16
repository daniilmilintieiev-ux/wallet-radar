import { Baseline, EnhancedTx } from "./types.js";
import { extractSwap, MAJOR_MINTS, txPrograms } from "./analyzer.js";
import { swapUsdValue, UsdPriceMap } from "./pricing.js";
import { computePnlLite, mergePnl } from "./pnl.js";

export { computePnlLite, mergePnl };

/**
 * How many most-recent swap sizes to retain for the recency-decayed
 * LARGE_SWAP reference. Old samples drop off the window instead of being
 * blended in forever, so a wallet's *current* behavior defines "normal".
 */
export const RECENT_SWAP_WINDOW = 32;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Append values to a most-recent window, keeping only the last `windowSize`. */
function pushWindow(prev: number[] | undefined, values: number[], windowSize: number): number[] {
  const next = [...(prev ?? []), ...values];
  return next.length > windowSize ? next.slice(next.length - windowSize) : next;
}

/**
 * Fold a batch of transactions into the wallet's behavioral profile.
 * Pure function: (baseline|null, txs) -> updated baseline.
 */
export function updateBaseline(
  wallet: string,
  prev: Baseline | null,
  txs: EnhancedTx[],
  nowSec: number = Date.now() / 1000,
  prices: UsdPriceMap | null = null,
): Baseline {
  const prevB: Baseline =
    prev ?? {
      walletAddress: wallet,
      updatedAt: nowSec,
      knownVenues: [],
      knownPrograms: [],
      medianSwapAmount: 0,
      medianTps: 0,
      activeHours: [],
      lastSeenAt: null,
      txCount: 0,
    };

  const venues = new Set(prevB.knownVenues);
  const programs = new Set(prevB.knownPrograms);
  const swapSizes: number[] = [];
  const swapSizesUsd: number[] = [];
  let lastSeen = prevB.lastSeenAt;

  for (const tx of txs) {
    if (tx.source) venues.add(tx.source);
    for (const p of txPrograms(tx)) programs.add(p);
    const s = extractSwap(tx);
    // Median is tracked on major tokens only — raw quantities of different
    // mints are not comparable (see LARGE_SWAP rule).
    if (s && MAJOR_MINTS.includes(s.tokenIn.mint)) swapSizes.push(s.tokenIn.amount);
    // USD sizing (price-normalized) is comparable across ALL mints.
    if (s && prices) {
      const usd = swapUsdValue(s, prices);
      if (usd !== null) swapSizesUsd.push(usd);
    }
    if (typeof tx.timestamp === "number") {
      if (lastSeen === null || tx.timestamp > lastSeen) {
        lastSeen = tx.timestamp;
      }
    }
  }

  // Recompute median over previous + new samples (approximate: keep running
  // median cheap by blending — good enough for v1 behavioral profile).
  const medianSwapAmount =
    swapSizes.length > 0
      ? (prevB.medianSwapAmount * prevB.txCount +
          median(swapSizes) * swapSizes.length) /
        (prevB.txCount + swapSizes.length)
      : prevB.medianSwapAmount;

  const medianSwapAmountUsd =
    swapSizesUsd.length > 0
      ? prevB.medianSwapAmountUsd !== undefined
        ? (prevB.medianSwapAmountUsd * prevB.txCount +
            median(swapSizesUsd) * swapSizesUsd.length) /
          (prevB.txCount + swapSizesUsd.length)
        : median(swapSizesUsd)
      : prevB.medianSwapAmountUsd;

  const batchPnl = computePnlLite(txs, prices, prevB.openLots);
  const pnl = mergePnl(prevB.pnl, batchPnl);
  const openLots = batchPnl.openLots;

  return {
    walletAddress: wallet,
    updatedAt: nowSec,
    knownVenues: Array.from(venues),
    knownPrograms: Array.from(programs),
    medianSwapAmount,
    medianSwapAmountUsd,
    pnl: {
      realizedUsd: pnl.realizedUsd,
      winRate: pnl.winRate,
      roundTrips: pnl.roundTrips,
    },
    openLots,
    medianTps: prevB.medianTps,
    activeHours: prevB.activeHours,
    recentSwapAmounts: pushWindow(prevB.recentSwapAmounts, swapSizes, RECENT_SWAP_WINDOW),
    recentSwapAmountsUsd: pushWindow(prevB.recentSwapAmountsUsd, swapSizesUsd, RECENT_SWAP_WINDOW),
    lastSeenAt: lastSeen,
    txCount: prevB.txCount + txs.length,
  };
}
