import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline, resolveScoringBaseline } from "./baseline.js";
import { maxOf, minOf } from "./stats.js";
import { digestAnomalies } from "./digest.js";
import { fetchWalletTransactions } from "./collector.js";
import { fetchSwapPrices, fetchUsdPrices } from "./pricing.js";
import { fetchSwapMintRisk } from "./mint.js";
import { Store } from "./store.js";
import { watchLoop, watchOnce, WatchOptions } from "./watch.js";
import { makeSink } from "./alerts.js";
import { parseTime, replayWallet, ReplayResult } from "./replay.js";
import { buildShortlist, formatShortlist, formatTrustLine, runTrustCheck, runTrustChecks } from "./trust.js";
import { renderHtmlReport, formatHistoryText, computeVerdict, HtmlReportData } from "./htmlreport.js";
import { renderDashboardHtml, formatLedgerTerminalTable } from "./dashboard.js";
import { readScanLedger } from "./oracle/index.js";
import { Anomaly, Baseline, EnhancedTx, DEFAULT_CONFIG } from "./types.js";

function usage(): void {
  console.log(`wallet-radar — continuous Solana wallet monitoring

usage:
  radar add <wallet>              add a wallet to the watchlist (SQLite: ~/.wallet-radar/radar.db)
  radar remove <wallet>           remove a wallet from the watchlist
  radar watch [--once]            poll the watchlist (needs HELIUS_API_KEY; TG alerts if TG_BOT_TOKEN+TG_CHAT_ID)
  radar report <wallet>           baseline + recent anomalies for one wallet
  radar history <wallet> [--export [out.html]] [--live] [--json]
                                  historical profile + anomalies (HTML report with --export [file], or stdout with --export -)
  radar ledger <wallet> [--export [out.html]] [--json]
                                  query on-chain ZK scan attestations (render HTML dashboard with --export, or terminal table)
  radar dashboard [wallet] [--export [out.html]]
                                  alias for ledger / dashboard exporter
  radar alerts [limit]            recent anomalies across the watchlist
  radar scan <wallet>             one-shot scan (needs HELIUS_API_KEY; prices via Jupiter)
  radar analyze <wallet> <txs.json>  run anomaly rules over a tx fixture
  radar prices <mint> [mint...]   fetch USD prices from the Jupiter Price API
  radar replay <wallet> --since <ts> [--until <ts>] [--alert] [--json]
                                   replay a historical awakening window through the live pipeline
                                   (baseline from history before --since, rules over [since,until])
   radar trust <wallet> [--max-risk N] [--min-liquidity N] [--window-days N] [--no-prices] [--json]
                                    pre-flight check for agent payments: risk + liquidity -> safe/hold/unknown
   radar trust --watchlist          run the trust check over the whole watchlist -> ranked shortlist
  radar selftest                  run the built-in offline fixture

env:
  HELIUS_API_KEY     Helius Enhanced Transactions (read-only)
  TG_BOT_TOKEN/TG_CHAT_ID  Telegram alerts (optional; console fallback)
  JUPITER_API_KEY / JUPITER_PRICE_BASE  price feed overrides (optional)
  RADAR_DB           custom SQLite path (default ~/.wallet-radar/radar.db)`);
}

function openStore(): Store {
  const dbPath = process.env.RADAR_DB ?? join(homedir(), ".wallet-radar", "radar.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new Store(dbPath);
  return store;
}

function requireApiKey(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.error("HELIUS_API_KEY is not set");
    process.exit(1);
  }
  return apiKey;
}

const VALUE_FLAGS = new Set(["--since", "--until", "--pages", "--max-risk", "--min-liquidity", "--window-days"]);

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function isFlagValue(args: string[], value: string): boolean {
  const i = args.indexOf(value);
  return i > 0 && VALUE_FLAGS.has(args[i - 1]);
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function printReplay(r: ReplayResult): void {
  const b = r.baseline;
  const median =
    b.medianSwapAmountUsd != null
      ? `~$${Math.round(b.medianSwapAmountUsd).toLocaleString("en-US")}`
      : `${b.medianSwapAmount} (raw units)`;
  console.log(`wallet-radar replay: ${r.wallet}`);
  console.log(
    `window:    ${iso(r.window.sinceSec)} .. ${r.window.untilSec !== null ? iso(r.window.untilSec) : "now"}`,
  );
  console.log(
    `history:   ${r.historyTxCount} txs  (baseline lastSeen ${b.lastSeenAt != null ? iso(b.lastSeenAt) : "n/a"}, median swap ${median}, ${b.knownVenues.length} venue(s), ${b.knownPrograms.length} program(s))`,
  );
  console.log(`burst:     ${r.burstTxCount} txs`);
  console.log(`prices:    ${r.pricesAvailable ? "available (Jupiter)" : "unavailable (major-only sizing)"}`);
  console.log("");
  console.log(
    `wallet-radar: ${r.wallet} — risk ${r.riskScore}/100, ${r.anomalies.length} anomal${r.anomalies.length === 1 ? "y" : "ies"}`,
  );
  if (r.anomalies.length > 0) {
    console.log(r.anomalies.map((a) => `- [${a.severity.toUpperCase()}] ${a.type}: ${a.text}`).join("\n"));
  }
  if (r.digest) console.log(`\n${r.digest}`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "add": {
      const wallet = args[0];
      if (!wallet) return usage();
      const store = openStore();
      store.addWallet(wallet);
      console.log(`watching ${wallet}`);
      store.close();
      return;
    }
    case "remove": {
      const wallet = args[0];
      if (!wallet) return usage();
      const store = openStore();
      store.removeWallet(wallet);
      console.log(`removed ${wallet}`);
      store.close();
      return;
    }
    case "watch": {
      const once = args.includes("--once");
      const apiKey = requireApiKey();
      const store = openStore();
      const wallets = store.listWallets();
      if (wallets.length === 0) {
        console.error("watchlist is empty — add a wallet first: radar add <wallet>");
        store.close();
        process.exit(1);
      }
      const opts: WatchOptions = { sink: makeSink() };
      console.error(`watching ${wallets.length} wallet(s), poll ${DEFAULT_CONFIG.pollMs}ms`);
      if (once) {
        const report = await watchOnce(store, apiKey, opts);
        console.log(JSON.stringify(report, null, 2));
      } else {
        await watchLoop(store, apiKey, opts, (report) => {
          const active = report.wallets.filter((w) => w.freshTxCount > 0);
          if (active.length > 0) console.error(new Date().toISOString(), JSON.stringify(active));
        });
      }
      store.close();
      return;
    }
    case "report": {
      const wallet = args[0];
      if (!wallet) return usage();
      const store = openStore();
      const baseline = store.getBaseline(wallet);
      if (!store.hasWallet(wallet)) {
        console.error(`wallet not in watchlist: ${wallet}`);
        store.close();
        process.exit(1);
      }
      const anomalies = store.recentAnomalies(wallet, 20);
      console.log(
        JSON.stringify(
          {
            wallet,
            baseline,
            pnl: baseline?.pnl ?? null,
            recentAnomalies: anomalies,
            riskScore: computeRiskScore(anomalies),
          },
          null,
          2,
        ),
      );
      store.close();
      return;
    }
    case "history": {
      const exportIdx = args.indexOf("--export");
      const hasExport = exportIdx !== -1;
      let exportPath: string | undefined = undefined;
      if (hasExport && exportIdx + 1 < args.length && !args[exportIdx + 1].startsWith("--")) {
        exportPath = args[exportIdx + 1];
      }
      const wallet = args.find((a, idx) => !a.startsWith("--") && (!hasExport || idx !== exportIdx + 1));
      if (!wallet) return usage();

      const store = openStore();
      let baseline: Baseline | null = null;
      let anomalies: Anomaly[] = [];
      let windowSince: number | null = null;
      let windowUntil: number | null = null;

      const isLive = args.includes("--live");
      const inStore = store.hasWallet(wallet);

      if (inStore && !isLive) {
        baseline = store.getBaseline(wallet);
        anomalies = store.recentAnomalies(wallet, 100);
        if (anomalies.length > 0) {
          const timestamps = anomalies.map((a) => a.timestamp).filter(Number.isFinite);
          if (timestamps.length > 0) {
            windowSince = minOf(timestamps);
            windowUntil = maxOf(timestamps);
          }
        }
        if (baseline?.lastSeenAt != null) {
          if (windowUntil == null || baseline.lastSeenAt > windowUntil) {
            windowUntil = baseline.lastSeenAt;
          }
        }
      } else {
        const apiKey = process.env.HELIUS_API_KEY;
        if (!apiKey) {
          if (!inStore) {
            console.error(`wallet not in watchlist: ${wallet}. Add it with 'radar add <wallet>' or set HELIUS_API_KEY to fetch live.`);
            store.close();
            process.exit(1);
          }
        } else {
          const txs = await fetchWalletTransactions(apiKey, wallet);
          const prices = await fetchSwapPrices(txs, { wallet });
          const mintRisk = await fetchSwapMintRisk(txs, { apiKey, wallet });
          const storedBaseline = inStore ? store.getBaseline(wallet) : null;
          baseline = updateBaseline(wallet, storedBaseline, txs, Math.floor(Date.now() / 1000), prices);
          store.saveBaseline(baseline);
          const scoringBaseline = resolveScoringBaseline(wallet, storedBaseline, txs, prices);
          anomalies = detectAnomalies(wallet, txs, scoringBaseline, undefined, prices, mintRisk);
          if (txs.length > 0) {
            windowSince = txs[txs.length - 1].timestamp;
            windowUntil = txs[0].timestamp;
          }
        }
      }
      store.close();

      const riskScore = computeRiskScore(anomalies);
      const verdict = computeVerdict(riskScore);
      const reportData: HtmlReportData = {
        wallet,
        riskScore,
        verdict,
        baseline,
        anomalies,
        window: {
          sinceSec: windowSince,
          untilSec: windowUntil,
        },
        generatedAt: Math.floor(Date.now() / 1000),
      };

      if (hasExport) {
        const html = renderHtmlReport(reportData);
        if (exportPath === "-") {
          process.stdout.write(html + "\n");
        } else {
          const dest = exportPath || `${wallet.slice(0, 8)}-history.html`;
          await import("node:fs/promises").then((fs) => fs.writeFile(dest, html, "utf8"));
          console.log(`exported HTML report to ${dest}`);
        }
      } else if (args.includes("--json")) {
        console.log(JSON.stringify(reportData, null, 2));
      } else {
        console.log(formatHistoryText(reportData));
      }
      return;
    }
    case "ledger":
    case "dashboard": {
      const wallet = args[0] && !args[0].startsWith("--") ? args[0] : "";
      const exportIdx = args.indexOf("--export");
      const hasExport = exportIdx !== -1;
      let exportPath: string | undefined;
      if (hasExport) {
        const nextArg = args[exportIdx + 1];
        if (nextArg && !nextArg.startsWith("--")) {
          exportPath = nextArg;
        }
      }

      const store = openStore();
      let watchlist: string[] = [];
      try {
        watchlist = store.listWallets();
      } catch {}
      store.close();

      const rpcUrl = process.env.SOLANA_RPC_URL;
      const records = wallet ? await readScanLedger(wallet, { rpcUrl, limit: 50 }) : [];

      if (hasExport) {
        const html = renderDashboardHtml({
          wallet,
          records,
          watchlist,
          rpcUrl,
        });
        if (exportPath === "-") {
          process.stdout.write(html + "\n");
        } else {
          const dest = exportPath || `${(wallet || "radar").slice(0, 8)}-dashboard.html`;
          await import("node:fs/promises").then((fs) => fs.writeFile(dest, html, "utf8"));
          console.log(`exported ledger dashboard to ${dest}`);
        }
      } else if (args.includes("--json")) {
        console.log(
          JSON.stringify(
            {
              wallet: wallet || null,
              latest: records.length > 0 ? records[0] : null,
              history: records,
              count: records.length,
            },
            null,
            2,
          ),
        );
      } else {
        if (!wallet) {
          console.log("wallet-radar ZK scan ledger dashboard");
          console.log(`Watchlist: ${watchlist.length} wallet(s)`);
          console.log("Usage: radar ledger <wallet> [--export [out.html]] [--json]");
          return;
        }
        console.log(`wallet-radar ZK scan ledger: ${wallet} (${records.length} attestations)`);
        console.log(formatLedgerTerminalTable(records));
      }
      return;
    }
    case "alerts": {
      const limit = args[0] ? Number(args[0]) : 20;
      const store = openStore();
      const anomalies = store.recentAnomalies(null, Number.isFinite(limit) ? limit : 20);
      console.log(JSON.stringify({ count: anomalies.length, anomalies }, null, 2));
      store.close();
      return;
    }
    case "scan": {
      const apiKey = requireApiKey();
      const wallet = args[0];
      if (!wallet) return usage();
      const txs = await fetchWalletTransactions(apiKey, wallet);
      const prices = await fetchSwapPrices(txs, { wallet });
      const mintRisk = await fetchSwapMintRisk(txs, { apiKey, wallet });
      const store = openStore();
      const storedBaseline = store.getBaseline(wallet);
      const baseline: Baseline = updateBaseline(wallet, storedBaseline, txs, Date.now() / 1000, prices);
      store.saveBaseline(baseline);
      const scoringBaseline = resolveScoringBaseline(wallet, storedBaseline, txs, prices);
      const anomalies = detectAnomalies(wallet, txs, scoringBaseline, undefined, prices, mintRisk);
      console.log(
        JSON.stringify(
          {
            wallet,
            txCount: txs.length,
            pricesAvailable: prices !== null,
            priceCount: prices ? Object.keys(prices).length : 0,
            prices,
            baseline,
            pnl: baseline.pnl ?? null,
            riskScore: computeRiskScore(anomalies),
            anomalies,
            digest: digestAnomalies(anomalies),
          },
          null,
          2,
        ),
      );
      store.close();
      return;
    }
    case "prices": {
      const mints = args;
      if (mints.length === 0) return usage();
      const prices = await fetchUsdPrices(mints);
      console.log(JSON.stringify(prices, null, 2));
      return;
    }
    case "analyze": {
      const wallet = args[0];
      const file = args[1];
      if (!wallet || !file) return usage();
      const raw: string = await import("node:fs/promises").then((m) => m.readFile(file, "utf8"));
      const txs = JSON.parse(raw) as EnhancedTx[];
      const baseline = resolveScoringBaseline(wallet, null, txs);
      const anomalies = detectAnomalies(wallet, txs, baseline);
      console.log(JSON.stringify({ riskScore: computeRiskScore(anomalies), anomalies, digest: digestAnomalies(anomalies) }, null, 2));
      return;
    }
    case "replay": {
      const apiKey = requireApiKey();
      const wallet = args.find((a) => !a.startsWith("--") && !isFlagValue(args, a));
      const sinceFlag = flagValue(args, "--since");
      if (!wallet || !sinceFlag) return usage();
      const sinceSec = parseTime(sinceFlag, "--since");
      const untilFlag = flagValue(args, "--until");
      const untilSec = untilFlag ? parseTime(untilFlag, "--until") : undefined;
      const usePrices = !args.includes("--no-prices");
      const useLlm = args.includes("--llm");
      const sendAlert = args.includes("--alert");
      const asJson = args.includes("--json");
      const pagesArg = flagValue(args, "--pages");
      const maxPages = pagesArg ? Math.max(1, Number(pagesArg)) : 20;

      const result: ReplayResult = await replayWallet(
        apiKey,
        wallet,
        { sinceSec, untilSec },
        {
          usePrices,
          useLlm,
          maxHistoryPages: maxPages,
          sink: sendAlert ? makeSink() : undefined,
        },
      );

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printReplay(result);
      return;
    }
    case "trust": {
      const apiKey = requireApiKey();
      const maxRiskFlag = flagValue(args, "--max-risk");
      const minLiqFlag = flagValue(args, "--min-liquidity");
      const windowFlag = flagValue(args, "--window-days");
      const common = {
        maxRisk: maxRiskFlag ? Number(maxRiskFlag) : undefined,
        minLiquidityUsd: minLiqFlag ? Number(minLiqFlag) : undefined,
        windowDays: windowFlag ? Number(windowFlag) : undefined,
        noPrices: args.includes("--no-prices"),
      };

      if (args.includes("--watchlist")) {
        const store = openStore();
        const wallets = store.listWallets();
        if (wallets.length === 0) {
          console.error("watchlist is empty — add a wallet first: radar add <wallet>");
          return;
        }
        const results = await runTrustChecks(apiKey, wallets, common);
        if (args.includes("--json")) {
          console.log(JSON.stringify({ shortlist: buildShortlist(results), results }, null, 2));
        } else {
          console.log(formatShortlist(buildShortlist(results)));
        }
        return;
      }

      const wallet = args.find((a) => !a.startsWith("--") && !isFlagValue(args, a));
      if (!wallet) return usage();
      const result = await runTrustCheck(apiKey, wallet, common);
      if (args.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatTrustLine(result));
        for (const a of result.anomalies) {
          console.log(`- [${a.severity.toUpperCase()}] ${a.type}: ${a.text}`);
        }
      }
      return;
    }
    case "selftest": {
      const wallet = "DemoWallet11111111111111111111111111111111";
      const txs: EnhancedTx[] = [
        { signature: "sigA", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
        { signature: "sigB", timestamp: 1_700_000_120, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
      ];
      const anomalies = detectAnomalies(wallet, txs, null);
      console.log(JSON.stringify({ riskScore: computeRiskScore(anomalies), anomalies, digest: digestAnomalies(anomalies) }, null, 2));
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
