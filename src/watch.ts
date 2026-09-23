import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline } from "./baseline.js";
import { fetchWalletHistory, fetchWalletTransactions, HttpError } from "./collector.js";
import { fetchSwapPrices } from "./pricing.js";
import { fetchSwapMintRisk, MintRiskMap } from "./mint.js";
import { Store } from "./store.js";
import { AlertSink, formatAlert } from "./alerts.js";
import { bestEffortDigest, llmConfigFromEnv } from "./llmdigest.js";
import { computeDefenseAction, DefenseAction, DefenseStateInfo, DEFENSE_THRESHOLDS } from "./defense.js";
import { Anomaly, DEFAULT_CONFIG, EnhancedTx, PnlSummary } from "./types.js";

export function defaultSeedPages(): number {
  const raw = process.env.RADAR_SEED_PAGES;
  if (!raw) return 3;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 3;
  return Math.min(20, Math.max(1, parsed));
}

export function defaultQuietPolls(): number {
  const raw = process.env.RADAR_QUIET_POLLS;
  if (!raw) return 3;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 3;
  return parsed;
}

export function defaultMaxPollMs(): number {
  const raw = process.env.RADAR_MAX_POLL_MS;
  if (!raw) return 60 * 60 * 1000;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 60 * 60 * 1000;
  return parsed;
}

/**
 * Progressively stretch polling interval once quiet streak >= quietThreshold:
 * doubles interval on each quiet poll after threshold up to maxPollSec (cap).
 */
export function calculateAdaptiveInterval(
  basePollSec: number,
  maxPollSec: number,
  quietStreak: number,
  quietThreshold: number,
): number {
  if (quietStreak < quietThreshold) {
    return basePollSec;
  }
  const factor = Math.pow(2, quietStreak - quietThreshold + 1);
  const cap = Math.max(basePollSec, maxPollSec);
  return Math.min(cap, basePollSec * factor);
}

export interface WatchOptions {
  pollMs?: number;
  limit?: number;
  /** Fetch Jupiter prices for USD-normalized sizing (default true). */
  usePrices?: boolean;
  sink?: AlertSink;
  /** Injectable tx source (tests). Defaults to the Helius collector. */
  fetchTxs?: (wallet: string) => Promise<EnhancedTx[]>;
  nowSec?: number;
  /** Max pages to fetch on first seed (default 3, env RADAR_SEED_PAGES 1..20). */
  seedPages?: number;
  /** Number of consecutive quiet polls before stretching interval (default 3, env RADAR_QUIET_POLLS). */
  quietPolls?: number;
  /** Maximum stretched poll interval in ms (default 3600000 = 60m, env RADAR_MAX_POLL_MS). */
  maxPollMs?: number;
  /** Injectable seed history fetcher (tests). Defaults to fetchWalletHistory. */
  fetchSeedHistory?: (wallet: string, maxPages: number) => Promise<EnhancedTx[]>;
  /** Injectable price fetcher (tests). Defaults to fetchSwapPrices. */
  fetchPrices?: (txs: EnhancedTx[], wallet?: string) => Promise<Record<string, number> | null>;
  /** Injectable mint risk fetcher (tests). Defaults to fetchSwapMintRisk. */
  fetchMintRisk?: (txs: EnhancedTx[], wallet?: string) => Promise<MintRiskMap>;
  /** Abort signal to stop the continuous loop (in-process watch mode). */
  signal?: AbortSignal;
}

export interface WalletReport {
  wallet: string;
  freshTxCount: number;
  /** Whether this poll performed initial baseline seeding (true on first poll, false on subsequent polls). */
  seeded: boolean;
  /** Explicit alias for initial baseline seed cycle (audit 2.8-NEW) */
  initialSeed?: boolean;
  anomalyCount: number;
  riskScore: number;
  pnl?: PnlSummary;
  error?: string;
  skipped?: boolean;
  quiet?: boolean;
  backoffUntil?: number;
  nextPollAt?: number;
  /** Active-defense action taken this tick (Pillar 3), when evaluated. */
  defense?: DefenseAction;
}

export interface WatchReport {
  atSec: number;
  wallets: WalletReport[];
}

/**
 * Wallets currently being handled by a concurrent watchOnce in this process
 * (overlapping daemon + manual run). Guards against double-processing — and
 * double-alerting — the same fresh txs.
 */
const inFlightWallets = new Set<string>();

/**
 * Run the active-defense state machine for one wallet on one tick and persist
 * the result (stance + audit event). Pure decision lives in computeDefenseAction;
 * this only adds the store I/O. A freshly-armed wallet that stays quiet does not
 * accumulate rows (nothing to record until it escalates).
 */
function evaluateDefense(
  store: Store,
  wallet: string,
  nowSec: number,
  active: boolean,
  riskScore: number,
  anomalies: Anomaly[],
  quietStreak: number,
): DefenseAction | null {
  const current = store.getDefenseState(wallet);
  const hasHighSeverity = anomalies.some((a) => a.severity === "high");
  const stateQuietStreak = active ? 0 : (current ? (current.quietStreak ?? 0) + 1 : quietStreak);
  const effectiveQuietStreak = quietStreak >= DEFENSE_THRESHOLDS.clearQuietPolls ? quietStreak : stateQuietStreak;
  const action = computeDefenseAction({ riskScore, hasHighSeverity, active, current, quietStreak: effectiveQuietStreak, nowSec });
  if (current === null && !action.changed) return action;
  const prev = current?.state ?? "armed";
  const next: DefenseStateInfo = {
    state: action.state,
    riskAt: active ? riskScore : current?.riskAt ?? 0,
    setAt: nowSec,
    quietStreak: active ? 0 : (action.changed ? 0 : stateQuietStreak),
    actions: (current?.actions ?? 0) + (action.changed ? 1 : 0),
  };
  store.setDefenseState(wallet, next);
  if (action.changed) {
    store.recordDefenseEvent({
      wallet,
      ts: nowSec,
      fromState: prev,
      toState: action.state,
      action: action.action,
      risk: riskScore,
      reason: action.reason,
    });
  }
  return action;
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
  const seedPages = Math.min(20, Math.max(1, opts.seedPages ?? defaultSeedPages()));
  const fetchSeedHistory =
    opts.fetchSeedHistory ??
    (opts.fetchTxs
      ? (w: string, _pages: number) => opts.fetchTxs!(w)
      : (w: string, pages: number) => fetchWalletHistory(apiKey, w, { maxPages: pages }));
  const fetchPrices = opts.fetchPrices ?? ((txs: EnhancedTx[], wallet?: string) => fetchSwapPrices(txs, { wallet }));
  const fetchMintRisk =
    opts.fetchMintRisk ??
    ((txs: EnhancedTx[], wallet?: string) => fetchSwapMintRisk(txs, { apiKey, store, nowSec, wallet }));
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const quietThreshold = Math.max(1, opts.quietPolls ?? defaultQuietPolls());
  const maxPollMs = opts.maxPollMs ?? defaultMaxPollMs();
  const pollMs = opts.pollMs ?? DEFAULT_CONFIG.pollMs;
  const basePollSec = Math.max(1, Math.floor(pollMs / 1000));
  const maxPollSec = Math.max(basePollSec, Math.floor(maxPollMs / 1000));
  const report: WatchReport = { atSec: nowSec, wallets: [] };

  for (const wallet of store.listWallets()) {
    const prev = store.getBaseline(wallet);
    const isInitialSeed = prev === null;
    const seeded = isInitialSeed;

    // Concurrency guard: if another watchOnce is already handling this wallet
    // (overlapping daemon + manual run), skip it this tick. Signature dedupe +
    // the next tick pick up anything new without double-processing/alerting.
    if (inFlightWallets.has(wallet)) {
      report.wallets.push({
        wallet,
        freshTxCount: 0,
        seeded,
        initialSeed: isInitialSeed,
        anomalyCount: 0,
        riskScore: 0,
        skipped: true,
      });
      continue;
    }
    inFlightWallets.add(wallet);
    try {
      const backoff = store.getBackoff(wallet);
      if (backoff && nowSec < backoff.backoffUntil) {
        report.wallets.push({
          wallet,
          freshTxCount: 0,
          seeded,
          initialSeed: isInitialSeed,
          anomalyCount: 0,
          riskScore: 0,
          skipped: true,
          backoffUntil: backoff.backoffUntil,
        });
        continue;
      }

      const pacing = store.getPacing(wallet);
      if (pacing && pacing.quietStreak >= quietThreshold && nowSec < pacing.nextPollAt) {
        report.wallets.push({
          wallet,
          freshTxCount: 0,
          seeded,
          initialSeed: isInitialSeed,
          anomalyCount: 0,
          riskScore: 0,
          skipped: true,
          quiet: true,
          nextPollAt: pacing.nextPollAt,
        });
        continue;
      }

      let txs: EnhancedTx[];
      try {
        txs = seeded
          ? await fetchSeedHistory(wallet, seedPages)
          : await fetchTxs(wallet);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Watch fetch failed for ${wallet}: ${errMsg}`);

        const status = err instanceof HttpError ? err.status : undefined;
        const isRateOrServerError = status === 429 || (status !== undefined && status >= 500 && status < 600);

        let backoffUntil: number | undefined;
        if (isRateOrServerError) {
          const b = store.recordBackoff(wallet, nowSec);
          backoffUntil = b.backoffUntil;
        }

        report.wallets.push({
          wallet,
          freshTxCount: 0,
          seeded,
          initialSeed: isInitialSeed,
          anomalyCount: 0,
          riskScore: 0,
          error: errMsg,
          backoffUntil,
        });
        continue;
      }

      // Successful fetch: reset backoff
      store.clearBackoff(wallet);

      const fresh = txs.filter((t) => t.signature && !store.allSeen(wallet, [t.signature]));
      if (fresh.length === 0) {
        const prevStreak = pacing?.quietStreak ?? 0;
        const newStreak = prevStreak + 1;
        const intervalSec = calculateAdaptiveInterval(basePollSec, maxPollSec, newStreak, quietThreshold);
        store.recordPacing(wallet, newStreak, nowSec + intervalSec);
        // Active defense: sustained quiet relaxes the stance (de-escalate/clear).
        const defense = evaluateDefense(store, wallet, nowSec, false, 0, [], newStreak);
        if (defense?.changed) {
          report.wallets.push({
            wallet,
            freshTxCount: 0,
            seeded,
            initialSeed: isInitialSeed,
            anomalyCount: 0,
            riskScore: 0,
            quiet: true,
            nextPollAt: nowSec + intervalSec,
            defense,
          });
        }
        continue;
      }

      // fresh.length > 0: active wallet, reset quiet streak to base interval
      store.recordPacing(wallet, 0, nowSec + basePollSec);

      const prices = usePrices ? await fetchPrices(fresh, wallet) : null;
      const baseline = updateBaseline(wallet, prev, fresh, nowSec, prices);
      store.saveBaseline(baseline);

      let anomalyCount = 0;
      let riskScore = 0;
      let defense: DefenseAction | null = null;
      if (!seeded) {
        const mintRisk = await fetchMintRisk(fresh, wallet);
        const anomalies = detectAnomalies(wallet, fresh, prev, undefined, prices, mintRisk);
        if (anomalies.length > 0) {
          store.recordAnomalies(anomalies, nowSec);
          riskScore = computeRiskScore(anomalies);
        }
        // Active defense: evaluate the stance on every active tick — escalate on
        // risk, or hold (and reset the quiet streak so a still-transacting wallet
        // does not relax while it keeps moving money).
        defense = evaluateDefense(store, wallet, nowSec, true, riskScore, anomalies, 0);
        if (anomalies.length > 0) {
          const { digest, source } = await bestEffortDigest(
            wallet,
            riskScore,
            anomalies,
            llmConfigFromEnv(),
          );
          if (sink) {
            const defenseLine = defense?.changed ? `\nDEFENSE: ${defense.reason}` : "";
            await sink.send(
              formatAlert(wallet, riskScore, anomalies, source === "llm" ? digest : undefined) + defenseLine,
              { wallet, risk: riskScore, anomalies },
            );
            store.markAllAlerted(wallet);
          }
        }
        anomalyCount = anomalies.length;
      }

      store.markSeen(wallet, fresh.map((t) => ({ sig: t.signature, ts: t.timestamp })));
      report.wallets.push({
        wallet,
        freshTxCount: fresh.length,
        seeded,
        initialSeed: isInitialSeed,
        anomalyCount,
        riskScore,
        pnl: baseline.pnl,
        defense: defense ?? undefined,
      });
    } finally {
      inFlightWallets.delete(wallet);
    }
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
    if (opts.signal?.aborted) return;
    try {
      const report = await watchOnce(store, apiKey, opts);
      onIteration?.(report);
    } catch (err) {
      // A transient error (RPC hiccup, price/mint fetch, sink failure) must
      // not kill the whole monitor: log and retry on the next tick instead of
      // rejecting the loop and silently stopping all monitoring.
      if (process.env.RADAR_DEBUG === "1") {
        console.error(`watch iteration failed (will retry): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (opts.signal?.aborted) return;
    await sleep(pollMs);
  }
}
