import { Baseline, EnhancedTx } from "./types.js";
import { extractSwap, MAJOR_MINTS, txPrograms } from "./analyzer.js";
import { swapUsdValue, UsdPriceMap } from "./pricing.js";
import { computePnlLite, mergePnl } from "./pnl.js";
import { foldCounterparties } from "./counterparty.js";
import { median } from "./stats.js";

export { computePnlLite, mergePnl };

/**
 * How many most-recent swap sizes to retain for the recency-decayed
 * LARGE_SWAP reference. Old samples drop off the window instead of being
 * blended in forever, so a wallet's *current* behavior defines "normal".
 */
export const RECENT_SWAP_WINDOW = 32;

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
  let firstSeen = prevB.firstSeenAt ?? null;

  // 24-bucket histogram of tx counts by UTC hour (legacy baselines start empty).
  const activeHours =
    prevB.activeHours.length === 24 ? [...prevB.activeHours] : new Array<number>(24).fill(0);

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
      if (firstSeen === null || tx.timestamp < firstSeen) {
        firstSeen = tx.timestamp;
      }
      activeHours[new Date(tx.timestamp * 1000).getUTCHours()] += 1;
    }
  }

  // Reference swap size = median of the most-recent bounded window, so the
  // stored median tracks CURRENT behavior and old outliers fall out of the
  // window instead of being blended in forever. Falls back to the previous
  // value until the window has samples.
  const recentSwapAmounts = pushWindow(prevB.recentSwapAmounts, swapSizes, RECENT_SWAP_WINDOW);
  const recentSwapAmountsUsd = pushWindow(prevB.recentSwapAmountsUsd, swapSizesUsd, RECENT_SWAP_WINDOW);
  const medianSwapAmount = recentSwapAmounts.length > 0 ? median(recentSwapAmounts) : prevB.medianSwapAmount;
  const medianSwapAmountUsd =
    recentSwapAmountsUsd.length > 0 ? median(recentSwapAmountsUsd) : prevB.medianSwapAmountUsd;

  // Lifetime activity rate (tx per minute) over the full observed span,
  // clamped to at least one minute so same-second bursts do not divide by zero.
  const txTotal = prevB.txCount + txs.length;
  const spanMin = firstSeen !== null && lastSeen !== null ? (lastSeen - firstSeen) / 60 : 0;
  const medianTps = txTotal > 1 ? txTotal / Math.max(spanMin, 1) : 0;

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
    medianTps,
    activeHours,
    firstSeenAt: firstSeen,
    recentSwapAmounts,
    recentSwapAmountsUsd,
    lastSeenAt: lastSeen,
    txCount: txTotal,
    counterparties: foldCounterparties(prevB.counterparties, txs, nowSec, prices),
  };
}
