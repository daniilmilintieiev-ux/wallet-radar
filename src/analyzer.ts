import {
  Anomaly,
  Baseline,
  DEFAULT_CONFIG,
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
 * Deterministic anomaly detection: compare a fresh batch of transactions
 * against the wallet's learned baseline. Pure function — no I/O, no LLM.
 */
export function detectAnomalies(
  wallet: string,
  txs: EnhancedTx[],
  baseline: Baseline | null,
  config: RadarConfig = DEFAULT_CONFIG,
  prices: UsdPriceMap | null = null,
  mintRisk: MintRiskMap | null = null,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const ts = (tx: EnhancedTx) => tx.timestamp ?? 0;

  // DORMANT_ACTIVE: activity after N days of silence.
  // Judge the gap by the NEWEST tx only: the batch may legitimately contain
  // an already-seen tx (pagination overlap), which must not suppress the alert.
  if (baseline?.lastSeenAt && txs.length > 0) {
    const newest = Math.max(...txs.map(ts));
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
    const newest = Math.max(...txs.map(ts));
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
  // With a USD price map, sizes are compared in USD across ALL mints
  // (normalization makes different tokens comparable). Without prices,
  // fall back to major-only raw quantities — comparing 1 SOL vs 50M BONK
  // as raw numbers produces false alarms.
  if (baseline) {
    const usdMedian = baseline.medianSwapAmountUsd ?? 0;
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
    } else if (baseline.medianSwapAmount > 0) {
      for (const s of swaps) {
        if (!MAJOR_MINTS.includes(s.tokenIn.mint)) continue;
        const size = s.tokenIn.amount;
        if (size >= baseline.medianSwapAmount * config.largeSwapMultiplier) {
          anomalies.push({
            type: "LARGE_SWAP",
            wallet,
            severity: "high",
            timestamp: s.timestamp,
            evidence: {
              size: Number(size.toFixed(4)),
              median: Number(baseline.medianSwapAmount.toFixed(4)),
              sig: s.signature,
            },
            text: `Swap of ${size.toFixed(4)} is ${config.largeSwapMultiplier}x the wallet's median.`,
          });
        }
      }
    }
  }

  // CONCENTRATION: multiple swaps into the same token in a short window.
  const byToken = new Map<string, SwapEvent[]>();
  for (const s of swaps) {
    const list = byToken.get(s.tokenOut.mint) ?? [];
    list.push(s);
    byToken.set(s.tokenOut.mint, list);
  }
  for (const [mint, list] of byToken) {
    if (list.length < config.concentrationCount) continue;
    const newest = Math.max(...list.map((s) => s.timestamp));
    // Timestamps are Unix SECONDS.
    const windowSec = config.concentrationWindowMin * 60;
    if (newest - Math.min(...list.map((s) => s.timestamp)) <= windowSec) {
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
        timestamp: Math.max(...txs.map(ts)),
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
