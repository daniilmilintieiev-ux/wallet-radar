import { computeRiskScore, detectAnomalies } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { fetchWalletHistory, HistoryQuery } from "./collector.js";
import { fetchSwapPrices, UsdPriceMap } from "./pricing.js";
import { fetchSwapMintRisk, MintRiskMap } from "./mint.js";
import { AlertSink, formatAlert } from "./alerts.js";
import { bestEffortDigest, llmConfigFromEnv } from "./llmdigest.js";
import { Anomaly, Baseline, DEFAULT_CONFIG, EnhancedTx, RadarConfig } from "./types.js";

/**
 * Replay a historical awakening window through the exact same detection
 * pipeline the live watch loop uses — no SOL, no controlled wallet needed.
 *
 * The wallet's on-chain history is split at `sinceSec`:
 *   - history (ts <  sinceSec)  -> learned baseline ("what normal looked like")
 *   - burst   (ts >= sinceSec, < untilSec) -> the awakening, run through rules
 *
 * Deterministic for a fixed [since, until] window: the transaction set is
 * fixed history; only USD prices float with the live Jupiter feed.
 */

export interface ReplayWindow {
  sinceSec: number;
  untilSec?: number;
}

export interface ReplayResult {
  wallet: string;
  window: { sinceSec: number; untilSec: number | null };
  historyTxCount: number;
  burstTxCount: number;
  baseline: Baseline;
  anomalies: Anomaly[];
  riskScore: number;
  pricesAvailable: boolean;
  digest?: string;
  digestSource?: "llm" | "template";
}

export interface ReplayOptions {
  config?: RadarConfig;
  /** Fetch Jupiter prices for USD-normalized sizing (default true). */
  usePrices?: boolean;
  /** Max pages (100 txs each) to fetch per history side (default 20). */
  maxHistoryPages?: number;
  /** Deliver the formatted alert (TG when configured, console otherwise). */
  sink?: AlertSink;
  /** Use the LLM digest (RADAR_LLM_* env). Default off: deterministic template. */
  useLlm?: boolean;
  /** Injectable fetcher for tests. */
  fetchHistory?: (wallet: string, query: HistoryQuery) => Promise<EnhancedTx[]>;
  /** Injectable mint risk fetcher for tests. */
  fetchMintRisk?: (txs: EnhancedTx[]) => Promise<MintRiskMap>;
}

/**
 * Pure: split a tx list around `sinceSec` (optional upper bound `untilSec`).
 * Returns both sides sorted ascending; dedupes by signature (pagination
 * overlap between the two fetches must not distort the baseline).
 */
export function splitTxs(
  txs: EnhancedTx[],
  sinceSec: number,
  untilSec?: number,
): { history: EnhancedTx[]; burst: EnhancedTx[] } {
  const seen = new Set<string>();
  const history: EnhancedTx[] = [];
  const burst: EnhancedTx[] = [];
  for (const t of txs) {
    if (t.signature && seen.has(t.signature)) continue;
    if (t.signature) seen.add(t.signature);
    const ts = t.timestamp ?? 0;
    if (ts < sinceSec) history.push(t);
    else if (untilSec === undefined || ts < untilSec) burst.push(t);
  }
  const byTime = (a: EnhancedTx, b: EnhancedTx) => (a.timestamp ?? 0) - (b.timestamp ?? 0);
  history.sort(byTime);
  burst.sort(byTime);
  return { history, burst };
}

export interface ReplayAnalysis {
  baseline: Baseline;
  anomalies: Anomaly[];
  riskScore: number;
}

/** Pure: baseline from history, rules over the burst, aggregated risk score. */
export function buildReplay(
  wallet: string,
  history: EnhancedTx[],
  burst: EnhancedTx[],
  prices: UsdPriceMap | null,
  config: RadarConfig = DEFAULT_CONFIG,
  mintRisk: MintRiskMap | null = null,
): ReplayAnalysis {
  const burstNewest = burst.length > 0 ? Math.max(...burst.map((t) => t.timestamp ?? 0)) : 0;
  const baseline = updateBaseline(wallet, null, history, burstNewest, prices);
  const anomalies = detectAnomalies(wallet, burst, baseline, config, prices, mintRisk);
  return { baseline, anomalies, riskScore: computeRiskScore(anomalies) };
}

/** Accepts unix seconds or ISO 8601; throws on unparseable input. */
export function parseTime(value: string, flag: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${flag}: unparseable time "${value}" (unix seconds or ISO 8601)`);
  return Math.floor(ms / 1000);
}

/**
 * Fetch both sides of the window from Helius, split locally (block-time
 * filters and tx timestamps can disagree at the edges), build the baseline,
 * run the rules, and optionally deliver the alert.
 */
export async function replayWallet(
  apiKey: string,
  wallet: string,
  win: ReplayWindow,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const usePrices = opts.usePrices ?? true;
  const useLlm = opts.useLlm ?? false;
  const maxPages = Math.max(1, opts.maxHistoryPages ?? 20);
  const fetchHistory =
    opts.fetchHistory ?? ((w: string, q: HistoryQuery) => fetchWalletHistory(apiKey, w, q));
  const fetchMintRisk =
    opts.fetchMintRisk ?? ((txs: EnhancedTx[]) => fetchSwapMintRisk(txs, { apiKey }));

  const [burstSide, historySide] = await Promise.all([
    fetchHistory(wallet, { gteTime: win.sinceSec, ltTime: win.untilSec, maxPages }),
    fetchHistory(wallet, { ltTime: win.sinceSec, maxPages }),
  ]);
  const { history, burst } = splitTxs([...burstSide, ...historySide], win.sinceSec, win.untilSec);
  if (burst.length === 0) {
    throw new Error(
      `no transactions in the replay window [${win.sinceSec} .. ${win.untilSec ?? "now"}) for ${wallet}`,
    );
  }

  const prices = usePrices ? await fetchSwapPrices([...burst, ...history]) : null;
  const mintRisk = await fetchMintRisk(burst);
  const { baseline, anomalies, riskScore } = buildReplay(
    wallet,
    history,
    burst,
    prices,
    config,
    mintRisk,
  );

  const result: ReplayResult = {
    wallet,
    window: { sinceSec: win.sinceSec, untilSec: win.untilSec ?? null },
    historyTxCount: history.length,
    burstTxCount: burst.length,
    baseline,
    anomalies,
    riskScore,
    pricesAvailable: prices !== null,
  };

  const { digest, source } = await bestEffortDigest(
    wallet,
    riskScore,
    anomalies,
    useLlm ? llmConfigFromEnv() : null,
  );
  result.digest = digest;
  result.digestSource = source;

  if (opts.sink) {
    await opts.sink.send(
      formatAlert(wallet, riskScore, anomalies, source === "llm" ? digest : undefined),
      { wallet, risk: riskScore, anomalies },
    );
  }

  return result;
}
