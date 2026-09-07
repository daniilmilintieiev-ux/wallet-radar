import { SOL_MINT, USDC_MINT, USDT_MINT } from "./types.js";
import { Anomaly, EnhancedTx } from "./types.js";
import { computeRiskScore, detectAnomalies } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { fetchWalletHistory } from "./collector.js";
import { fetchSwapPrices, fetchUsdPrices } from "./pricing.js";

/**
 * `radar trust <wallet>` — pre-flight check for agent payments (x402 and
 * agent-to-agent). Answers "is it safe to deal with this wallet right now?"
 * with one deterministic verdict. No LLM in the verdict path: the verdict is a
 * pure function of (behavioral risk, payment capacity) so any agent can
 * recompute it from the same evidence.
 *
 * Spec: docs/trust-spec.md
 */

export type TrustVerdict = "safe" | "hold" | "unknown";

export interface TrustBalances {
  sol: number;
  usdc: number;
  usdt: number;
}

export interface TrustOptions {
  /** Max acceptable risk score (0-100). Default 30. */
  maxRisk?: number;
  /** Minimum acceptable liquidity in USD. Default 50. */
  minLiquidityUsd?: number;
  /** Behavioral risk window in days. Default 7. */
  windowDays?: number;
}

/** Inputs to the pure verdict function. */
export interface TrustInputs {
  /** Risk score 0-100, or null when there is no history to score. */
  riskScore: number | null;
  /** null = balance data unavailable (RPC failure). */
  balances: TrustBalances | null;
  /** false = SOL price feed unavailable; SOL is excluded from liquidity. */
  solPriced: boolean;
  solPrice: number | null;
}

export interface TrustVerdictResult {
  verdict: TrustVerdict;
  reasons: string[];
  /** USD liquidity used for the verdict (stablecoins always; SOL only when priced). */
  liquidityUsd: number;
}

export const TRUST_DEFAULTS = {
  maxRisk: 30,
  minLiquidityUsd: 50,
  windowDays: 7,
};

export function liquidityOf(inputs: TrustInputs): number {
  if (inputs.balances === null) return 0;
  const stable = inputs.balances.usdc + inputs.balances.usdt;
  const sol = inputs.solPriced && inputs.solPrice ? inputs.balances.sol * inputs.solPrice : 0;
  return Math.round((stable + sol) * 1e6) / 1e6;
}

/**
 * Pure, deterministic verdict. Conservative on uncertainty:
 * missing data yields "unknown", never "safe".
 */
export function computeTrustVerdict(inputs: TrustInputs, opts: TrustOptions = {}): TrustVerdictResult {
  const maxRisk = opts.maxRisk ?? TRUST_DEFAULTS.maxRisk;
  const minLiquidityUsd = opts.minLiquidityUsd ?? TRUST_DEFAULTS.minLiquidityUsd;
  const reasons: string[] = [];
  const liquidityUsd = liquidityOf(inputs);

  if (inputs.riskScore === null || inputs.balances === null) {
    if (inputs.riskScore === null) reasons.push("no history to score risk");
    if (inputs.balances === null) reasons.push("balance data unavailable");
    return { verdict: "unknown", reasons, liquidityUsd: 0 };
  }

  if (inputs.riskScore > maxRisk) reasons.push(`risk score ${inputs.riskScore} > max ${maxRisk}`);
  if (liquidityUsd < minLiquidityUsd) {
    reasons.push(`liquidity $${liquidityUsd.toFixed(2)} < min $${minLiquidityUsd.toFixed(2)}`);
  }
  // Note: `solPriced: false` is carried by the result field (informational);
  // it narrows liquidity but does not by itself force "hold".

  return { verdict: reasons.length > 0 ? "hold" : "safe", reasons, liquidityUsd };
}

/** Full result of a trust check (JSON payload for CLI and MCP). */
export interface TrustResult {
  wallet: string;
  verdict: TrustVerdict;
  riskScore: number | null;
  anomalyCount: number;
  anomalies: Anomaly[];
  balances: TrustBalances | null;
  solPriced: boolean;
  solPrice: number | null;
  liquidityUsd: number;
  reasons: string[];
  txCount: number;
  windowDays: number;
  generatedAt: number;
}

/** Solana JSON-RPC call (getBalance / getTokenAccountsByOwner). */
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

/**
 * Payment capacity: SOL + USDC + USDT (stablecoins 1:1 USD).
 * Only these are counted — deliberately conservative.
 */
export async function fetchLiquidity(rpcUrl: string, wallet: string): Promise<TrustBalances> {
  const balRes = (await rpcCall(rpcUrl, "getBalance", [wallet])) as { value: number };
  const sol = balRes.value / 1e9;

  async function stableBalance(mint: string): Promise<number> {
    const res = (await rpcCall(rpcUrl, "getTokenAccountsByOwner", [
      wallet,
      { mint },
      { encoding: "jsonParsed" },
    ])) as {
      value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }>;
    };
    let total = 0;
    for (const entry of res.value ?? []) {
      total += entry.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    }
    return total;
  }

  const [usdc, usdt] = await Promise.all([stableBalance(USDC_MINT), stableBalance(USDT_MINT)]);
  return { sol, usdc, usdt };
}

export interface TrustCheckOptions extends TrustOptions {
  /** Skip the Jupiter price feed (SOL then unpriced). */
  noPrices?: boolean;
  /** RPC endpoint override (default: Helius RPC derived from HELIUS_API_KEY). */
  rpcUrl?: string;
}

/**
 * Run the trust check: behavioral risk over the window (one-shot, replay
 * semantics) + payment capacity + deterministic verdict.
 */
export async function runTrustCheck(
  apiKey: string,
  wallet: string,
  opts: TrustCheckOptions = {},
): Promise<TrustResult> {
  const windowDays = opts.windowDays ?? TRUST_DEFAULTS.windowDays;
  const generatedAt = Math.floor(Date.now() / 1000);
  const sinceSec = generatedAt - windowDays * 86_400;

  // --- behavioral risk (one-shot over the window) ---
  let riskScore: number | null = null;
  let anomalies: Anomaly[] = [];
  let txCount = 0;
  try {
    const txs: EnhancedTx[] = await fetchWalletHistory(apiKey, wallet, {
      gteTime: sinceSec,
      limit: 100,
      maxPages: 1,
    });
    txCount = txs.length;
    const prices = opts.noPrices ? null : await fetchSwapPrices(txs);
    const baseline = updateBaseline(wallet, null, txs, generatedAt, prices);
    anomalies = detectAnomalies(wallet, txs, baseline, undefined, prices);
    riskScore = computeRiskScore(anomalies);
  } catch (err) {
    console.error(`history fetch failed, risk unknown: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- payment capacity ---
  const rpcUrl = opts.rpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  let balances: TrustBalances | null = null;
  try {
    balances = await fetchLiquidity(rpcUrl, wallet);
  } catch (err) {
    console.error(`balance fetch failed, capacity unknown: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- SOL price (best-effort) ---
  let solPrice: number | null = null;
  if (balances && balances.sol > 0 && !opts.noPrices) {
    try {
      const prices = await fetchUsdPrices([SOL_MINT]);
      solPrice = prices[SOL_MINT] ?? null;
    } catch {
      solPrice = null;
    }
  }

  const inputs: TrustInputs = {
    riskScore,
    balances,
    solPriced: solPrice !== null,
    solPrice,
  };
  const { verdict, reasons, liquidityUsd } = computeTrustVerdict(inputs, opts);

  return {
    wallet,
    verdict,
    riskScore,
    anomalyCount: anomalies.length,
    anomalies,
    balances,
    solPriced: solPrice !== null,
    solPrice,
    liquidityUsd,
    reasons,
    txCount,
    windowDays,
    generatedAt,
  };
}

/** One-line human-readable summary (stdout without --json). */
export function formatTrustLine(r: TrustResult): string {
  const risk = r.riskScore === null ? "n/a" : `${r.riskScore}/100`;
  const liq = r.liquidityUsd > 0 || r.balances !== null ? `$${r.liquidityUsd.toFixed(2)}` : "n/a";
  const notes: string[] = [...r.reasons];
  if (r.balances !== null && !r.solPriced) notes.push("SOL unpriced, excluded from liquidity");
  const why = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  return `wallet-radar: ${r.wallet} — ${r.verdict.toUpperCase()} — risk ${risk}, liquidity ${liq}${why}`;
}

/**
 * Run the trust check over several wallets (e.g. the whole watchlist).
 * Wallets are checked sequentially: each check is a handful of RPC calls and
 * the pre-flight use case is a short list, so no concurrency is added here.
 * A per-wallet failure never aborts the batch — it is reported as "unknown".
 */
export async function runTrustChecks(
  apiKey: string,
  wallets: string[],
  opts: TrustCheckOptions = {},
): Promise<TrustResult[]> {
  const out: TrustResult[] = [];
  for (const wallet of wallets) {
    try {
      out.push(await runTrustCheck(apiKey, wallet, opts));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`trust check failed for ${wallet}: ${msg}`);
      out.push({
        wallet,
        verdict: "unknown",
        riskScore: null,
        anomalyCount: 0,
        anomalies: [],
        balances: null,
        solPriced: false,
        solPrice: null,
        liquidityUsd: 0,
        reasons: [`check failed: ${msg}`],
        txCount: 0,
        windowDays: opts.windowDays ?? TRUST_DEFAULTS.windowDays,
        generatedAt: Math.floor(Date.now() / 1000),
      });
    }
  }
  return out;
}

export interface TrustShortlist {
  generatedAt: number;
  total: number;
  counts: { safe: number; hold: number; unknown: number };
  /** Verdict "safe", ranked: lowest risk first, then highest liquidity. */
  shortlist: TrustResult[];
  /** Verdict "hold", ranked: lowest risk first, then highest liquidity. */
  borderline: TrustResult[];
  /** Verdict "unknown" (no data / failed check). */
  unknown: TrustResult[];
}

const VERDICT_RANK: Record<TrustVerdict, number> = { safe: 0, hold: 1, unknown: 2 };

function rankCompare(a: TrustResult, b: TrustResult): number {
  const byVerdict = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
  if (byVerdict !== 0) return byVerdict;
  const aRisk = a.riskScore ?? 101;
  const bRisk = b.riskScore ?? 101;
  if (aRisk !== bRisk) return aRisk - bRisk;
  return b.liquidityUsd - a.liquidityUsd;
}

/**
 * Pure, deterministic shortlist over a set of trust results:
 * "which wallets in this set are safe to deal with right now, and in what
 * order?" No network, no side effects — any agent can recompute the same
 * shortlist from the same results.
 */
export function buildShortlist(results: TrustResult[], generatedAt: number = Math.floor(Date.now() / 1000)): TrustShortlist {
  const counts = { safe: 0, hold: 0, unknown: 0 };
  for (const r of results) counts[r.verdict] += 1;
  const ranked = [...results].sort(rankCompare);
  return {
    generatedAt,
    total: results.length,
    counts,
    shortlist: ranked.filter((r) => r.verdict === "safe"),
    borderline: ranked.filter((r) => r.verdict === "hold"),
    unknown: ranked.filter((r) => r.verdict === "unknown"),
  };
}

/** Human-readable shortlist report (stdout without --json). */
export function formatShortlist(s: TrustShortlist): string {
  const lines: string[] = [];
  lines.push(
    `wallet-radar: trust shortlist — ${s.total} wallet(s): ` +
      `${s.counts.safe} safe, ${s.counts.hold} hold, ${s.counts.unknown} unknown`,
  );
  const row = (r: TrustResult, i: number): string => {
    const risk = r.riskScore === null ? "n/a" : `${r.riskScore}/100`;
    const liq = r.balances === null ? "n/a" : `$${r.liquidityUsd.toFixed(2)}`;
    const why = r.reasons.length > 0 ? ` (${r.reasons.join("; ")})` : "";
    return `  ${i + 1}. ${r.wallet} — risk ${risk}, liquidity ${liq}${why}`;
  };
  if (s.shortlist.length > 0) {
    lines.push("SAFE (ranked by risk, then liquidity):");
    s.shortlist.forEach((r, i) => lines.push(row(r, i)));
  } else {
    lines.push("SAFE: none");
  }
  if (s.borderline.length > 0) {
    lines.push("HOLD:");
    s.borderline.forEach((r, i) => lines.push(row(r, i)));
  }
  if (s.unknown.length > 0) {
    lines.push("UNKNOWN:");
    s.unknown.forEach((r, i) => lines.push(row(r, i)));
  }
  return lines.join("\n");
}
