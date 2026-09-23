import { SOL_MINT, USDC_MINT, USDT_MINT } from "./types.js";
import { Anomaly, EnhancedTx, Freshness } from "./types.js";
import { computeRiskScore, detectAnomalies } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { maxOf } from "./stats.js";
import { fetchWalletHistory } from "./collector.js";
import { fetchSwapPrices, fetchUsdPrices } from "./pricing.js";
import { anomalyReasons, anomalySummary, buildFreshness, buildAuditTrail, type AnomalyReason, type AuditTrail } from "./explain.js";
import { isValidBase58 } from "./config.js";
import { computeDecision, type DecisionResult } from "./decision.js";
import {
  aggregateConsensus,
  behaviorAgent,
  solvencyAgent,
  identityAgent,
  llmAgent,
  type AgentVote,
  type ConsensusResult,
} from "./consensus.js";
import type { DefenseView } from "./defense.js";

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

/** Solana System Program — the owner of a normal (keypair-created) account. */
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * Result of the account-authority check. `owner` is the account's owner
 * program id (null = account does not exist / not found). `isSystemAccount` is
 * `false` when the account is owned by a program other than the System Program
 * (i.e. a PDA / derived account) — a red flag for a counterparty you're about
 * to pay. `null` = unknown (check not run or RPC failed).
 */
export interface AccountAuthority {
  owner: string | null;
  isSystemAccount: boolean | null;
}

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
  /** Account-authority check; null/omitted = not run. A non-system owner forces "hold". */
  accountAuthority?: AccountAuthority | null;
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


const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;

export function liquidityOf(inputs: TrustInputs): number {
  if (inputs.balances === null) return 0;
  const usdc = Number.isFinite(inputs.balances.usdc) ? inputs.balances.usdc : 0;
  const usdt = Number.isFinite(inputs.balances.usdt) ? inputs.balances.usdt : 0;
  const solAmount = Number.isFinite(inputs.balances.sol) ? inputs.balances.sol : 0;
  const stable = usdc + usdt;
  const sol = inputs.solPriced && inputs.solPrice && Number.isFinite(inputs.solPrice) ? solAmount * inputs.solPrice : 0;
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

  if (inputs.riskScore === null || !Number.isFinite(inputs.riskScore) || inputs.balances === null) {
    if (inputs.riskScore === null || !Number.isFinite(inputs.riskScore)) reasons.push("no history to score risk");
    if (inputs.balances === null) reasons.push("balance data unavailable");
    return { verdict: "unknown", reasons, liquidityUsd: 0 };
  }

  if (inputs.riskScore > maxRisk) reasons.push(`risk score ${inputs.riskScore} > max ${maxRisk}`);
  if (liquidityUsd < minLiquidityUsd) {
    reasons.push(`liquidity $${liquidityUsd.toFixed(2)} < min $${minLiquidityUsd.toFixed(2)}`);
  }
  // Note: `solPriced: false` is carried by the result field (informational);
  // it narrows liquidity but does not by itself force "hold".
  // Account-authority check: a counterparty that is NOT a normal system
  // account (i.e. a program-derived / PDA account) can hold and move funds in
  // non-obvious ways — never call it "safe", at best "hold". Unknown (null)
  // does not block; only a confirmed non-system owner does.
  const authority = inputs.accountAuthority;
  if (authority && authority.owner !== null && authority.isSystemAccount === false) {
    reasons.push(`account owner ${authority.owner} is not the system program (not a normal account)`);
  }

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
  /** Account-authority check (best-effort); null when the RPC was unavailable. */
  accountAuthority: AccountAuthority;
  liquidityUsd: number;
  reasons: string[];
  /** Per-rule behavioral breakdown (human-first), when anomalies were detected. */
  anomalyReasons?: AnomalyReason[];
  /** Compact one-line summary of the detected anomalies. */
  summary?: string;
  /** Recency of the behavioral data behind the verdict. */
  freshness?: Freshness;
  /** Actionable decision for agents: allow/throttle/block/manual_review. */
  action?: DecisionResult;
  /** Multi-agent consensus (Pillar 2): per-agent votes, agreement, dissent. */
  consensus?: ConsensusResult;
  /** Active-defense posture (Pillar 3), attached when the wallet has a stance. */
  defense?: DefenseView;
  /** Full audit trail (opt-in via ?audit=true). */
  audit?: AuditTrail;
  txCount: number;
  windowDays: number;
  generatedAt: number;
  /** Median swap size (USD) over the scored baseline window, when known. */
  medianSwapAmountUsd: number | null;
}

/** Solana JSON-RPC call (getBalance / getTokenAccountsByOwner). */
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

/**
 * Resolve the owner program of a Solana account via getAccountInfo (base64).
 * Returns the owner program id, or null when the account does not exist.
 * The caller compares against SYSTEM_PROGRAM to tell normal accounts from
 * program-derived (PDA) accounts.
 */
export async function fetchAccountOwner(rpcUrl: string, wallet: string): Promise<string | null> {
  if (!isValidBase58(wallet)) throw new Error("Invalid Solana wallet address");
  const res = (await rpcCall(rpcUrl, "getAccountInfo", [wallet, { encoding: "base64" }])) as
    | { value: { owner: string } | null }
    | null;
  return res?.value?.owner ?? null;
}

/**
 * Payment capacity: SOL + USDC + USDT (stablecoins 1:1 USD).
 * Only these are counted — deliberately conservative.
 */
export async function fetchLiquidity(rpcUrl: string, wallet: string): Promise<TrustBalances> {
  if (!isValidBase58(wallet)) throw new Error("Invalid Solana wallet address");
  const balRes = (await rpcCall(rpcUrl, "getBalance", [wallet])) as { value: number };
  const sol = balRes.value / 1e9;

  async function stableBalance(mint: string): Promise<number> {
    if (!isValidBase58(mint)) throw new Error("Invalid token mint address");
    const res = (await rpcCall(rpcUrl, "getTokenAccountsByOwner", [
      wallet,
      { mint },
      { encoding: "jsonParsed" },
    ])) as {
      value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }>;
    };
    let total = 0;
    // RPC may return `value: 0` (or other non-array shapes) instead of the
    // expected array — guard so a zero-balance wallet does not throw.
    for (const entry of Array.isArray(res.value) ? res.value : []) {
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
  /** Include the full audit trail in the response. */
  includeAudit?: boolean;
  /**
   * Optional advisory LLM verdict for the consensus panel (Pillar 2). When set,
   * an LLM agent joins the panel as a conservative fourth voter — it can cast a
   * hold-veto but can never override a deterministic hold. Omit to run the
   * three deterministic agents only.
   */
  llmVerdict?: "safe" | "hold" | "unknown";
  /** Free-text note attached to the LLM vote (for transparency). */
  llmVerdictNote?: string;
}

/** Minimum prior-window samples before "change" signals are trusted. */
const MIN_PRIOR_SAMPLES = 3;

/**
 * Split fetched history into the baseline source and the scored set. With enough
 * prior-window history the baseline is the wallet's established behavior and only
 * the recent window is scored; otherwise the whole window is scored as a snapshot
 * (no "before" to be new relative to, so change-signals stay muted).
 */
export function selectScoring(
  txs: EnhancedTx[],
  windowStart: number,
  minPriorSamples: number = MIN_PRIOR_SAMPLES,
): { baselineTxs: EnhancedTx[]; evalTxs: EnhancedTx[] } {
  const priorTxs = txs.filter((t) => (t.timestamp ?? 0) < windowStart);
  const recentTxs = txs.filter((t) => (t.timestamp ?? 0) >= windowStart);
  if (priorTxs.length >= minPriorSamples) {
    return { baselineTxs: priorTxs, evalTxs: recentTxs };
  }
  return { baselineTxs: txs, evalTxs: txs };
}

/**
 * Run the trust check: behavioral risk over the requested window, scored
 * against the wallet's equal prior window (so change-over-time signals like
 * NEW_VENUE / NEW_PROGRAM / DORMANT_ACTIVE actually mean something), + payment
 * capacity + deterministic verdict.
 */
export async function runTrustCheck(
  apiKey: string,
  wallet: string,
  opts: TrustCheckOptions = {},
): Promise<TrustResult> {
  const windowDays = opts.windowDays ?? TRUST_DEFAULTS.windowDays;
  const generatedAt = Math.floor(Date.now() / 1000);
  const windowStart = generatedAt - windowDays * 86_400;
  const priorStart = generatedAt - 2 * windowDays * 86_400;

  // --- behavioral risk (one-shot: requested window scored vs prior behavior) ---
  let riskScore: number | null = null;
  let anomalies: Anomaly[] = [];
  let txCount = 0;
  let lastActivity: number | null = null;
  let medianSwapAmountUsd: number | null = null;
  try {
    // Fetch two windows: the requested window (to score) plus the equal prior
    // window (to establish "normal" behavior). This is what makes the
    // change-over-time signals meaningful — a reactivated wallet using a venue
    // it has never touched is exactly the scam pattern this gate exists to catch.
    const txs: EnhancedTx[] = await fetchWalletHistory(apiKey, wallet, {
      gteTime: priorStart,
      limit: 200,
      maxPages: 2,
    });
    const stamps = txs.map((t) => t.timestamp).filter((n) => typeof n === "number");
    lastActivity = stamps.length > 0 ? maxOf(stamps) : null;
    const prices = opts.noPrices ? null : await fetchSwapPrices(txs, { wallet });
    const { baselineTxs, evalTxs } = selectScoring(txs, windowStart);
    const baseline = updateBaseline(wallet, null, baselineTxs, generatedAt, prices);
    txCount = evalTxs.length;
    medianSwapAmountUsd = baseline.medianSwapAmountUsd ?? null;
    anomalies = detectAnomalies(wallet, evalTxs, baseline, undefined, prices);
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

  // --- account-authority check (best-effort) ---
  // Is the counterparty a normal system account, or a program-derived (PDA)
  // account that can hold/move funds in non-obvious ways? A confirmed
  // non-system owner downgrades the verdict to at most "hold".
  let accountAuthority: AccountAuthority = { owner: null, isSystemAccount: null };
  try {
    const owner = await fetchAccountOwner(rpcUrl, wallet);
    accountAuthority = { owner, isSystemAccount: owner === SYSTEM_PROGRAM };
  } catch (err) {
    console.error(`account authority check failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
    accountAuthority = { owner: null, isSystemAccount: null };
  }

  const inputs: TrustInputs = {
    riskScore,
    balances,
    solPriced: solPrice !== null,
    solPrice,
    accountAuthority,
  };
  const { verdict, reasons, liquidityUsd } = computeTrustVerdict(inputs, opts);

  // --- Multi-agent consensus (Pillar 2) ---
  // The same evidence is re-expressed as a panel of specialized voters. With
  // the default unanimous-safe rule and no LLM voter this reproduces
  // computeTrustVerdict exactly; the LLM voter (when provided) can only make
  // the consensus more conservative.
  const maxRisk = opts.maxRisk ?? TRUST_DEFAULTS.maxRisk;
  const minLiquidityUsd = opts.minLiquidityUsd ?? TRUST_DEFAULTS.minLiquidityUsd;
  const votes: AgentVote[] = [
    behaviorAgent(riskScore, maxRisk),
    solvencyAgent(balances, liquidityUsd, minLiquidityUsd),
    identityAgent(accountAuthority),
  ];
  const llm = llmAgent(opts.llmVerdict, opts.llmVerdictNote);
  if (llm) votes.push(llm);
  const consensus = aggregateConsensus(votes);

  // The consensus drives the verdict. It equals the legacy verdict unless the
  // LLM voter cast a hold-veto, in which case the LLM reason is surfaced.
  const finalVerdict = consensus.verdict;
  const finalReasons = [...reasons];
  if (finalVerdict !== verdict) {
    const llmHold = consensus.votes.find((v) => v.agent === "llm" && v.verdict === "hold");
    for (const r of llmHold?.reasons ?? []) {
      if (!finalReasons.includes(r)) finalReasons.push(r);
    }
  }

  // --- Decision Engine: actionable verdict for agents ---
  const decision = computeDecision({
    riskScore,
    anomalies,
    liquidityUsd,
    legacyVerdict: finalVerdict,
    maxRisk: opts.maxRisk,
    minLiquidityUsd: opts.minLiquidityUsd,
  });

  // --- Audit trail (opt-in) ---
  let audit: AuditTrail | undefined;
  if (opts.includeAudit) {
    audit = buildAuditTrail(
      anomalies,
      riskScore ?? 0,
      finalVerdict,
      decision.confidence,
      generatedAt,
    );
  }

  return {
    wallet,
    verdict: finalVerdict,
    riskScore,
    anomalyCount: anomalies.length,
    anomalies,
    anomalyReasons: anomalyReasons(anomalies),
    summary: anomalySummary(anomalies),
    freshness: buildFreshness(lastActivity, generatedAt, windowStart, generatedAt),
    balances,
    solPriced: solPrice !== null,
    solPrice,
    accountAuthority,
    liquidityUsd,
    reasons: finalReasons,
    action: decision,
    consensus,
    audit,
    txCount,
    windowDays,
    generatedAt,
    medianSwapAmountUsd,
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
      const genAt = Math.floor(Date.now() / 1000);
      out.push({
        wallet,
        verdict: "unknown",
        riskScore: null,
        anomalyCount: 0,
        anomalies: [],
        anomalyReasons: [],
        summary: "no anomalies in this window",
        freshness: buildFreshness(null, genAt, null, null),
        balances: null,
        solPriced: false,
        solPrice: null,
        accountAuthority: { owner: null, isSystemAccount: null },
        liquidityUsd: 0,
        reasons: [`check failed: ${msg}`],
        txCount: 0,
        windowDays: opts.windowDays ?? TRUST_DEFAULTS.windowDays,
        generatedAt: genAt,
        medianSwapAmountUsd: null,
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
