import {
  Anomaly,
  Baseline,
  loadConfig,
  EnhancedTx,
  MintRiskMap,
  RadarConfig,
  Severity,
  SOL_MINT,
  SwapEvent,
  USDC_MINT,
  USDT_MINT,
} from "./types.js";
import { swapUsdValue, UsdPriceMap } from "./pricing.js";
import { detectCounterpartyAnomalies } from "./counterparty.js";
import { median, maxOf, minOf } from "./stats.js";

/** Top-10 holder concentration (% of supply) at/above which a mint is flagged TOXIC_MINT. */
export const TOP10_CONCENTRATION_PCT = 60;
/** Top-10 holder concentration (% of supply) at/above which the TOXIC_MINT severity is `high`. */
export const TOP10_HIGH_PCT = 80;

// Re-exported for modules that import the well-known mints from the analyzer.
export { SOL_MINT, USDC_MINT, USDT_MINT };

/**
 * Major tokens whose UI quantities are comparable across wallets.
 * LARGE_SWAP is only evaluated on these — comparing raw quantities of
 * different tokens (e.g. 1 SOL median vs 50M BONK) produces false alarms.
 */
export const MAJOR_MINTS = [SOL_MINT, USDC_MINT, USDT_MINT];

/**
 * Baseline-poisoning defense: a swap-size reference built from fewer than this
 * many samples is too thin to be trusted for LARGE_SWAP (a wallet that makes
 * one or two trades then a big one would otherwise set its own "normal").
 */
export const MIN_BASELINE_SAMPLES = 3;

/**
 * COUNTERPARTY_CLUSTER soft-signal thresholds: at least this many counterparty
 * interactions in the batch, and the top counterparty accounting for at least
 * this % of them, flags concentrated/coordinated activity (wash trading).
 */
export const COUNTERPARTY_MIN_TXS = 4;
export const COUNTERPARTY_CLUSTER_PCT = 50;

/** Minimum baseline transaction count required before evaluating REGIME_SHIFT. */
export const REGIME_MIN_BASELINE_TXS = 5;

/** Minimum recent transaction count required to evaluate sustained REGIME_SHIFT. */
export const REGIME_MIN_RECENT_TXS = 3;

/** Factor threshold for sustained swap size shift in REGIME_SHIFT. */
export const REGIME_AMOUNT_FACTOR = 3;

/** Minimum ratio of recent transactions in an unseen venue/protocol for dominant shift. */
export const REGIME_DOMINANT_RATIO = 0.7;

/** Ratio threshold for inter-activity interval shift (acceleration or deceleration). */
export const REGIME_CADENCE_FACTOR = 4;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtUsd(n: number): string {
  return n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2);
}

function tokenUiAmount(item: {
  rawTokenAmount?: { tokenAmount?: string; decimals?: number };
}): number {
  const raw = item?.rawTokenAmount;
  if (!raw) return 0;
  const amount = Number(raw.tokenAmount ?? 0);
  const decimals = Number(raw.decimals ?? 0);
  return decimals > 0 ? amount / Math.pow(10, decimals) : amount;
}

export function extractSwap(
  tx: EnhancedTx,
): SwapEvent | null {
  const swap = tx.swap;
  if (swap) {
    const inLeg =
      swap.tokenInputs?.[0] ??
      (swap.nativeInput ? { rawTokenAmount: { tokenAmount: String(swap.nativeInput.amount ?? 0), decimals: 9 } } : undefined);
    const outLeg =
      swap.tokenOutputs?.[0] ??
      (swap.nativeOutput ? { rawTokenAmount: { tokenAmount: String(swap.nativeOutput.amount ?? 0), decimals: 9 } } : undefined);
    return {
      dex: tx.source ?? "unknown",
      signature: tx.signature,
      timestamp: tx.timestamp,
      tokenIn: {
        mint: inLeg?.mint ?? (swap.nativeInput ? SOL_MINT : ""),
        amount: inLeg ? tokenUiAmount(inLeg) : 0,
      },
      tokenOut: {
        mint: outLeg?.mint ?? (swap.nativeOutput ? SOL_MINT : ""),
        amount: outLeg ? tokenUiAmount(outLeg) : 0,
      },
    };
  }
  // Fallback for the newer Helius response shape (no `swap` field):
  // reconstruct the legs from token/native transfers relative to the fee payer.
  if (tx.type !== "SWAP") return null;
  const me = tx.feePayer;
  if (!me) return null;
  let inMint = "";
  let inAmount = 0;
  let outMint = "";
  let outAmount = 0;
  for (const t of tx.tokenTransfers ?? []) {
    if (!t.mint) continue;
    if (t.fromUserAccount === me && !inMint) {
      inMint = t.mint;
      inAmount = Number(t.tokenAmount ?? 0);
    }
    if (t.toUserAccount === me && !outMint) {
      outMint = t.mint;
      outAmount = Number(t.tokenAmount ?? 0);
    }
  }
  for (const t of tx.nativeTransfers ?? []) {
    if (t.fromUserAccount === me && !inMint) {
      inMint = SOL_MINT;
      inAmount = Number(t.amount ?? 0) / 1e9;
    }
    if (t.toUserAccount === me && !outMint) {
      outMint = SOL_MINT;
      outAmount = Number(t.amount ?? 0) / 1e9;
    }
  }
  if (!inMint && !outMint) return null;
  return {
    dex: tx.source ?? "unknown",
    signature: tx.signature,
    timestamp: tx.timestamp,
    tokenIn: { mint: inMint, amount: inAmount },
    tokenOut: { mint: outMint, amount: outAmount },
  };
}

/** Programs a tx touched: legacy `programs` field, else instruction programIds. */
export function txPrograms(tx: EnhancedTx): string[] {
  if (tx.programs) return tx.programs;
  const ids = new Set<string>();
  for (const i of tx.instructions ?? []) {
    if (i.programId) ids.add(i.programId);
  }
  return Array.from(ids);
}

/**
 * Counterparty user-accounts a tx interacted with. Prefers the explicit
 * `counterparties` field; otherwise derives the "other side" from the
 * token/native transfer lists relative to the fee payer (self is excluded).
 */
export function txCounterparties(tx: EnhancedTx): string[] {
  if (tx.counterparties && tx.counterparties.length > 0) return tx.counterparties;
  const me = tx.feePayer;
  const out: string[] = [];
  const from = (u?: string) => (u && u !== me ? u : undefined);
  for (const t of tx.tokenTransfers ?? []) {
    const other = t.fromUserAccount === me ? t.toUserAccount : t.fromUserAccount;
    const o = from(other);
    if (o) out.push(o);
  }
  for (const t of tx.nativeTransfers ?? []) {
    const other = t.fromUserAccount === me ? t.toUserAccount : t.fromUserAccount;
    const o = from(other);
    if (o) out.push(o);
  }
  return out;
}

/**
 * Deterministic anomaly detection: compare a fresh batch of transactions
 * against the wallet's learned baseline. Pure function — no I/O, no LLM.
 */
export function detectAnomalies(
  wallet: string,
  txs: EnhancedTx[],
  baseline: Baseline | null,
  config: RadarConfig = loadConfig(),
  prices: UsdPriceMap | null = null,
  mintRisk: MintRiskMap | null = null,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const ts = (tx: EnhancedTx) => tx.timestamp ?? 0;

  // DORMANT_ACTIVE: activity after N days of silence.
  // Judge the gap by the NEWEST tx only: the batch may legitimately contain
  // an already-seen tx (pagination overlap), which must not suppress the alert.
  if (baseline?.lastSeenAt && txs.length > 0) {
    const newest = maxOf(txs.map(ts));
    const daysSince = (newest - baseline.lastSeenAt) / 86_400;
    if (daysSince >= config.dormantDays) {
      anomalies.push({
        type: "DORMANT_ACTIVE",
        wallet,
        severity: "high",
        timestamp: newest,
        evidence: { daysSilent: Number(daysSince.toFixed(1)) },
        text: `Wallet reactivated after ~${Math.floor(daysSince)} days of inactivity.`,
      });
    }
  }

  // ACTIVITY_BURST: K+ tx within a short window.
  // NOTE: Helius timestamps are Unix SECONDS — the window must be in seconds too.
  if (txs.length > 0) {
    const newest = maxOf(txs.map(ts));
    const windowSec = config.burstWindowMin * 60;
    const inWindow = txs.filter((t) => newest - ts(t) <= windowSec).length;
    if (inWindow >= config.burstThreshold) {
      anomalies.push({
        type: "ACTIVITY_BURST",
        wallet,
        severity: inWindow >= config.burstThreshold * 2 ? "high" : "medium",
        timestamp: newest,
        evidence: {
          txInWindow: inWindow,
          windowMin: config.burstWindowMin,
          baselineTps: baseline?.medianTps ?? null,
        },
        text: `${inWindow} transactions in ${config.burstWindowMin} min (baseline ~${baseline?.medianTps ?? "unknown"}/min).`,
      });
    }
  }

  const swaps = txs
    .map(extractSwap)
    .filter((s): s is SwapEvent => s !== null);

  // NEW_VENUE: first swap on a venue not seen in the baseline.
  for (const s of swaps) {
    if (
      baseline &&
      s.dex &&
      s.dex !== "unknown" &&
      !baseline.knownVenues.includes(s.dex)
    ) {
      anomalies.push({
        type: "NEW_VENUE",
        wallet,
        severity: "medium",
        timestamp: s.timestamp,
        evidence: { venue: s.dex, sig: s.signature },
        text: `First swap on ${s.dex}.`,
      });
    }
  }

  // LARGE_SWAP: swap size > N x the wallet's median swap size.
  // The reference median is the RECENT-window median when one is available
  // (recency decay: a one-off historical outlier drops off instead of
  // permanently inflating "normal"). With a USD price map, sizes are compared
  // in USD across ALL mints; without prices, fall back to major-only raw
  // quantities. A sample floor guards against a poisoned thin baseline.
  if (baseline) {
    const usdRecent = baseline.recentSwapAmountsUsd;
    const usdMedian = usdRecent && usdRecent.length > 0 ? median(usdRecent) : baseline.medianSwapAmountUsd ?? 0;
    const rawRecent = baseline.recentSwapAmounts;
    const rawMedian = rawRecent && rawRecent.length > 0 ? median(rawRecent) : baseline.medianSwapAmount;
    const rawSamples = rawRecent && rawRecent.length > 0 ? rawRecent.length : baseline.txCount;
    if (prices && usdMedian > 0) {
      for (const s of swaps) {
        const usd = swapUsdValue(s, prices);
        if (usd === null) continue;
        if (usd >= usdMedian * config.largeSwapMultiplier) {
          anomalies.push({
            type: "LARGE_SWAP",
            wallet,
            severity: "high",
            timestamp: s.timestamp,
            evidence: {
              usd: round2(usd),
              medianUsd: round2(usdMedian),
              mint: s.tokenIn.mint,
              sig: s.signature,
            },
            text: `Swap of ~$${fmtUsd(usd)} is ${config.largeSwapMultiplier}x the wallet's median (~$${fmtUsd(usdMedian)}).`,
          });
        }
      }
    } else if (rawMedian > 0 && rawSamples >= MIN_BASELINE_SAMPLES) {
      for (const s of swaps) {
        if (!MAJOR_MINTS.includes(s.tokenIn.mint)) continue;
        const size = s.tokenIn.amount;
        if (size >= rawMedian * config.largeSwapMultiplier) {
          anomalies.push({
            type: "LARGE_SWAP",
            wallet,
            severity: "high",
            timestamp: s.timestamp,
            evidence: {
              size: Number(size.toFixed(4)),
              median: Number(rawMedian.toFixed(4)),
              sig: s.signature,
            },
            text: `Swap of ${size.toFixed(4)} is ${config.largeSwapMultiplier}x the wallet's median (~${rawMedian.toFixed(4)}).`,
          });
        }
      }
    }
  }

  // CONCENTRATION: multiple swaps into the same token in a short window.
  const byToken = new Map<string, SwapEvent[]>();
  for (const s of swaps) {
    // Skip unparseable swaps (empty output mint) — otherwise several of them
    // bucket under "" and form a false CONCENTRATION group.
    if (!s.tokenOut.mint) continue;
    const list = byToken.get(s.tokenOut.mint) ?? [];
    list.push(s);
    byToken.set(s.tokenOut.mint, list);
  }
  for (const [mint, list] of byToken) {
    if (list.length < config.concentrationCount) continue;
    const newest = maxOf(list.map((s) => s.timestamp));
    // Timestamps are Unix SECONDS.
    const windowSec = config.concentrationWindowMin * 60;
    if (newest - minOf(list.map((s) => s.timestamp)) <= windowSec) {
      anomalies.push({
        type: "CONCENTRATION",
        wallet,
        severity: "medium",
        timestamp: newest,
        evidence: { token: mint, count: list.length },
        text: `${list.length} swaps into ${mint} within ${config.concentrationWindowMin} min.`,
      });
    }
  }

  // COUNTERPARTY_CLUSTER: soft signal — the wallet's counterparty interactions
  // are concentrated on a single address (wash-trading / coordinated-activity
  // indicator). Low severity: it adds context and a little risk but never
  // blocks on its own.
  {
    const freq = new Map<string, number>();
    let total = 0;
    for (const tx of txs) {
      for (const cp of txCounterparties(tx)) {
        freq.set(cp, (freq.get(cp) ?? 0) + 1);
        total += 1;
      }
    }
    if (total >= COUNTERPARTY_MIN_TXS) {
      let top = "";
      let topCount = 0;
      for (const [cp, c] of freq) {
        if (c > topCount) {
          topCount = c;
          top = cp;
        }
      }
      const pct = Math.round((topCount / total) * 100);
      if (pct >= COUNTERPARTY_CLUSTER_PCT) {
        anomalies.push({
          type: "COUNTERPARTY_CLUSTER",
          wallet,
          severity: "low",
          timestamp: maxOf(txs.map(ts)),
          evidence: { topCounterparty: top, topCount, total, pct, distinct: freq.size },
          text: `${pct}% of ${total} counterparty interactions go to one wallet (${top}). Possible coordinated activity.`,
        });
      }
    }
  }

  // NEW_PROTOCOL: first interaction with a program not in the baseline.
  if (baseline) {
    const seen = new Set(baseline.knownPrograms);
    const fresh = new Set<string>();
    for (const tx of txs) {
      for (const p of txPrograms(tx)) {
        if (!seen.has(p)) fresh.add(p);
      }
    }
    for (const p of fresh) {
      anomalies.push({
        type: "NEW_PROTOCOL",
        wallet,
        severity: "low",
        timestamp: maxOf(txs.map(ts)),
        evidence: { program: p },
        text: `First interaction with program ${p}.`,
      });
    }
  }

  // TOXIC_MINT: swaps involving tokens with unrenounced freeze/mint authorities, OR extreme
  // top-holder concentration (top-10 wallets control most of the supply = rug risk).
  if (mintRisk) {
    const flaggedMints = new Set<string>();
    for (const s of swaps) {
      const candidateMints = [s.tokenIn.mint, s.tokenOut.mint].filter(
        (m) => m && !MAJOR_MINTS.includes(m),
      );
      for (const m of candidateMints) {
        if (flaggedMints.has(m)) continue;
        const meta = mintRisk[m];
        if (!meta) continue; // Fetch failed or no metadata: skip rule for this mint
        const hasFreeze = Boolean(meta.freezeAuthority);
        const hasMint = Boolean(meta.mintAuthority);
        const top10 = typeof meta.top10Pct === "number" ? meta.top10Pct : null;
        const concentrated = top10 != null && top10 >= TOP10_CONCENTRATION_PCT;
        if (hasFreeze || hasMint || concentrated) {
          flaggedMints.add(m);
          const veryConcentrated = top10 != null && top10 >= TOP10_HIGH_PCT;
          const severity: Severity = hasFreeze || veryConcentrated ? "high" : "medium";
          const reasons: string[] = [];
          if (hasFreeze) reasons.push(`freeze authority (${meta.freezeAuthority})`);
          if (hasMint) reasons.push(`mint authority (${meta.mintAuthority})`);
          if (concentrated) reasons.push(`top-10 holders control ${top10}% of supply`);
          anomalies.push({
            type: "TOXIC_MINT",
            wallet,
            severity,
            timestamp: s.timestamp,
            evidence: {
              mint: m,
              freezeAuthority: meta.freezeAuthority,
              mintAuthority: meta.mintAuthority,
              top10Pct: top10,
              sig: s.signature,
            },
            text: `Token ${m}: ${reasons.join("; ")}.`,
          });
        }
      }
    }
  }

  // COUNTERPARTY MEMORY: cross-batch relationship signals (new counterparty,
  // dominant hub, relationship escalation). Emitted before the anti-evasion
  // meta-rules so they participate in REGIME_SHIFT's distinct-type count.
  anomalies.push(...detectCounterpartyAnomalies(wallet, txs, baseline?.counterparties ?? null));

  // --- REGIME_SHIFT (8th rule): Behavioral Drift Detector ---
  // Fires when a wallet's recent behavior is a STRUCTURAL break from its own
  // established baseline (not a single spike) across one or more dimensions:
  // 1. Amount: sustained shift in typical swap size (recent median >= 3x baseline)
  // 2. Venue / Protocol diversity: new dominant venue/protocol or diversity collapse
  // 3. Cadence: sustained acceleration or deceleration of inter-activity intervals
  //
  // Guard: requires minimum baseline history (>= 5 txs) and minimum recent window (>= 3 txs)
  // so thin or newly initialized profiles never produce false positives.
  // Severity: medium (high if 2+ dimensions shift together, or multi-anomaly shift).
  const shiftReasons: string[] = [];
  const shiftedDimensions = new Set<string>();

  const hasBaselineHistory = baseline !== null && baseline.txCount >= REGIME_MIN_BASELINE_TXS;
  const hasRecentWindow = txs.length >= REGIME_MIN_RECENT_TXS;

  if (hasBaselineHistory && hasRecentWindow) {
    // 1. AMOUNT DIMENSION: sustained shift in typical swap size
    const usdRecent = baseline.recentSwapAmountsUsd;
    const usdMedian = usdRecent && usdRecent.length > 0 ? median(usdRecent) : baseline.medianSwapAmountUsd ?? 0;
    const rawRecent = baseline.recentSwapAmounts;
    const rawMedian = rawRecent && rawRecent.length > 0 ? median(rawRecent) : baseline.medianSwapAmount;

    if (prices && usdMedian > 0) {
      const recentUsds = swaps
        .map((s) => swapUsdValue(s, prices))
        .filter((v): v is number => v !== null && v > 0);
      if (recentUsds.length >= 2) {
        const recentMedianUsd = median(recentUsds);
        if (recentMedianUsd >= usdMedian * REGIME_AMOUNT_FACTOR) {
          const factor = (recentMedianUsd / usdMedian).toFixed(1);
          shiftReasons.push(`amount (recent median ~$${fmtUsd(recentMedianUsd)} is ${factor}x baseline ~$${fmtUsd(usdMedian)})`);
          shiftedDimensions.add("amount");
        }
      }
    } else if (rawMedian > 0) {
      const recentMajors = swaps
        .filter((s) => MAJOR_MINTS.includes(s.tokenIn.mint))
        .map((s) => s.tokenIn.amount)
        .filter((a) => a > 0);
      if (recentMajors.length >= 2) {
        const recentMedian = median(recentMajors);
        if (recentMedian >= rawMedian * REGIME_AMOUNT_FACTOR) {
          const factor = (recentMedian / rawMedian).toFixed(1);
          shiftReasons.push(`amount (recent median ${recentMedian.toFixed(2)} is ${factor}x baseline ${rawMedian.toFixed(2)})`);
          shiftedDimensions.add("amount");
        }
      }
    }

    // 2. VENUE / PROTOCOL DIVERSITY DIMENSION
    const venueTxs = txs.filter((t) => t.source && t.source !== "unknown");
    if (venueTxs.length >= 3) {
      const venueCounts = new Map<string, number>();
      for (const t of venueTxs) {
        const v = t.source!;
        venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
      }
      let topVenue = "";
      let topVenueCount = 0;
      for (const [v, c] of venueCounts) {
        if (c > topVenueCount) {
          topVenue = v;
          topVenueCount = c;
        }
      }
      const ratio = topVenueCount / venueTxs.length;
      if (!baseline.knownVenues.includes(topVenue) && ratio >= REGIME_DOMINANT_RATIO) {
        const pct = Math.round(ratio * 100);
        shiftReasons.push(`venue (new dominant venue ${topVenue} accounts for ${pct}% of recent txs, not in baseline)`);
        shiftedDimensions.add("venue");
      } else if (baseline.knownVenues.length >= 3 && venueCounts.size === 1) {
        shiftReasons.push(`venue (diversity collapsed from ${baseline.knownVenues.length} baseline venues to single venue ${topVenue})`);
        shiftedDimensions.add("venue");
      }
    }

    // Protocol diversity
    if (txs.length >= 3) {
      const progCounts = new Map<string, number>();
      for (const t of txs) {
        for (const p of txPrograms(t)) {
          progCounts.set(p, (progCounts.get(p) ?? 0) + 1);
        }
      }
      for (const [prog, count] of progCounts) {
        if (!baseline.knownPrograms.includes(prog)) {
          const ratio = count / txs.length;
          if (ratio >= REGIME_DOMINANT_RATIO && count >= 3) {
            const pct = Math.round(ratio * 100);
            shiftReasons.push(`protocol (new dominant program ${prog} accounts for ${pct}% of recent txs, not in baseline)`);
            shiftedDimensions.add("protocol");
            break;
          }
        }
      }
    }

    // 3. CADENCE DIMENSION: inter-activity interval distribution shifted
    if (baseline.medianTps > 0 && txs.length >= 3) {
      const sortedTs = txs.map(ts).filter((t) => t > 0).sort((a, b) => a - b);
      if (sortedTs.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < sortedTs.length; i++) {
          intervals.push(sortedTs[i] - sortedTs[i - 1]);
        }
        const recentIntervalSec = median(intervals);
        const baselineIntervalSec = 60 / baseline.medianTps;
        if (recentIntervalSec > 0 && baselineIntervalSec / recentIntervalSec >= REGIME_CADENCE_FACTOR) {
          const factor = (baselineIntervalSec / recentIntervalSec).toFixed(1);
          shiftReasons.push(`cadence (inter-activity interval accelerated to ${recentIntervalSec.toFixed(0)}s vs baseline ${baselineIntervalSec.toFixed(0)}s, ${factor}x faster)`);
          shiftedDimensions.add("cadence");
        } else if (baselineIntervalSec > 0 && recentIntervalSec / baselineIntervalSec >= REGIME_CADENCE_FACTOR) {
          const factor = (recentIntervalSec / baselineIntervalSec).toFixed(1);
          shiftReasons.push(`cadence (inter-activity interval decelerated to ${recentIntervalSec.toFixed(0)}s vs baseline ${baselineIntervalSec.toFixed(0)}s, ${factor}x slower)`);
          shiftedDimensions.add("cadence");
        }
      }
    }
  }

  // Multi-anomaly correlation (anti-evasion): 3+ distinct anomaly types firing in the batch
  const distinctTypes = new Set(anomalies.map((a) => a.type));
  const multiAnomalyShift = distinctTypes.size >= 3;

  if (shiftedDimensions.size > 0 || multiAnomalyShift) {
    if (multiAnomalyShift && shiftReasons.length === 0) {
      const types = Array.from(distinctTypes).join(", ");
      shiftReasons.push(`multi-anomaly shift (${distinctTypes.size} distinct anomaly types: ${types})`);
      shiftedDimensions.add("multi_anomaly");
    }
    const reasons = [...shiftReasons];
    const dimensions = Array.from(shiftedDimensions);
    const severity: Severity = (shiftedDimensions.size >= 2 || multiAnomalyShift) ? "high" : "medium";
    const newestTs = txs.length > 0 ? maxOf(txs.map(ts)) : 0;
    anomalies.push({
      type: "REGIME_SHIFT",
      wallet,
      severity,
      timestamp: newestTs,
      evidence: {
        reasons,
        dimensions,
        triggeredRules: Array.from(distinctTypes),
        count: distinctTypes.size,
        shiftedDimensionsCount: shiftedDimensions.size,
        recentTxCount: txs.length,
        baselineTxCount: baseline?.txCount ?? 0,
      },
      text: `Regime shift: ${reasons.join("; ")}.`,
    });
  }

  // --- Anti-evasion: WARMING ---
  // Detects wallets that build a short "normal" baseline (few tx over a short
  // period) then suddenly deviate. The baseline is MANUFACTURED: a few small
  // trades to look established, then a large or unusual action.
  // Signal: baseline has very few tx (< 5) AND the current batch contains
  // at least one HIGH severity anomaly that is disproportionate to the
  // thin baseline.
  if (baseline && baseline.txCount > 0 && baseline.txCount < 5) {
    const hasHigh = anomalies.some((a) => a.severity === "high");
    if (hasHigh) {
      anomalies.push({
        type: "WARMING",
        wallet,
        severity: "medium",
        timestamp: maxOf(txs.map(ts)),
        evidence: { baselineTxCount: baseline.txCount, currentAnomalies: anomalies.filter((a) => a.severity === "high").length },
        text: `Baseline is thin (${baseline.txCount} tx) yet current activity triggers high-severity anomalies. Possible manufactured baseline ("warming").`,
      });
    }
  }

  return anomalies;
}

const SEVERITY_POINTS: Record<string, number> = {
  low: 5,
  medium: 15,
  high: 30,
};

/**
 * Aggregate anomaly list into a single 0-100 risk score for humans and agents.
 * Deterministic: high=30, medium=15, low=5 points per anomaly, capped at 100.
 */
export function computeRiskScore(anomalies: Anomaly[]): number {
  const total = anomalies.reduce((sum, a) => sum + (SEVERITY_POINTS[a.severity] ?? 0), 0);
  return Math.min(100, total);
}
