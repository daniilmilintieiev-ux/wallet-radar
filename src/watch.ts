import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { fetchWalletTransactions } from "./collector.js";
import { fetchSwapPrices } from "./pricing.js";
import { Store } from "./store.js";
import { AlertSink, formatAlert } from "./alerts.js";
import { bestEffortDigest, llmConfigFromEnv } from "./llmdigest.js";
import { DEFAULT_CONFIG, EnhancedTx } from "./types.js";

export interface WatchOptions {
  pollMs?: number;
  limit?: number;
  /** Fetch Jupiter prices for USD-normalized sizing (default true). */
  usePrices?: boolean;
  sink?: AlertSink;
  /** Injectable tx source (tests). Defaults to the Helius collector. */
  fetchTxs?: (wallet: string) => Promise<EnhancedTx[]>;
  nowSec?: number;
}

export interface WalletReport {
  wallet: string;
  freshTxCount: number;
  seeded: boolean;
  anomalyCount: number;
  riskScore: number;
}

export interface WatchReport {
  atSec: number;
  wallets: WalletReport[];
}

/**
 * One polling iteration over the whole watchlist.
 *
 * First-seed semantics: a wallet without a baseline gets its profile built
 * from the fetched history silently (no alerts on old activity). After that,
 * only txs with unseen signatures are processed — signature dedupe keeps the
 * loop correct even when Helius timestamps collide within one second.
 */
export async function watchOnce(
  store: Store,
  apiKey: string,
  opts: WatchOptions = {},
): Promise<WatchReport> {
  const limit = opts.limit ?? 50;
  const usePrices = opts.usePrices ?? true;
  const sink = opts.sink;
  const fetchTxs = opts.fetchTxs ?? ((w: string) => fetchWalletTransactions(apiKey, w, limit));
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const report: WatchReport = { atSec: nowSec, wallets: [] };

  for (const wallet of store.listWallets()) {
    const txs = await fetchTxs(wallet);
    const fresh = txs.filter((t) => t.signature && !store.allSeen(wallet, [t.signature]));
    if (fresh.length === 0) continue;

    const prev = store.getBaseline(wallet);
    const seeded = prev === null;

    const prices = !seeded && usePrices ? await fetchSwapPrices(fresh) : null;
    const baseline = updateBaseline(wallet, prev, fresh, nowSec, prices);
    store.saveBaseline(baseline);

    let anomalyCount = 0;
    let riskScore = 0;
    if (!seeded) {
      const anomalies = detectAnomalies(wallet, fresh, prev, undefined, prices);
      if (anomalies.length > 0) {
        store.recordAnomalies(anomalies, nowSec);
        riskScore = computeRiskScore(anomalies);
        const { digest, source } = await bestEffortDigest(
          wallet,
          riskScore,
          anomalies,
          llmConfigFromEnv(),
        );
        if (sink) {
          await sink.send(formatAlert(wallet, riskScore, anomalies, source === "llm" ? digest : undefined));
          store.markAllAlerted(wallet);
        }
      }
      anomalyCount = anomalies.length;
    }

    store.markSeen(wallet, fresh.map((t) => ({ sig: t.signature, ts: t.timestamp })));
    report.wallets.push({ wallet, freshTxCount: fresh.length, seeded, anomalyCount, riskScore });
  }

  return report;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Continuous watch loop: poll the watchlist every `pollMs` until aborted. */
export async function watchLoop(
  store: Store,
  apiKey: string,
  opts: WatchOptions = {},
  onIteration?: (report: WatchReport) => void,
): Promise<void> {
  const pollMs = opts.pollMs ?? DEFAULT_CONFIG.pollMs;
  for (;;) {
    const report = await watchOnce(store, apiKey, opts);
    onIteration?.(report);
    await sleep(pollMs);
  }
}
