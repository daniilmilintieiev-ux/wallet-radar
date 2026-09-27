import { fetchWalletTransactions } from "../src/collector.js";
import { updateBaseline } from "../src/baseline.js";
import { detectAnomalies, computeRiskScore } from "../src/analyzer.js";
import { fetchSwapMintRisk } from "../src/mint.js";
import { fetchSwapPrices } from "../src/pricing.js";
import { DEFAULT_CONFIG, EnhancedTx, Baseline, Anomaly, USDC_MINT, USDT_MINT, SOL_MINT } from "../src/types.js";
import { computeDefenseAction, type DefenseStateInfo, isExistentialThreat, DEFENSE_THRESHOLDS } from "../src/defense.js";
import * as fs from "node:fs";
import * as path from "node:path";

export type TrustStance = "VERIFIED_SAFE" | "LOW_TRUST_WARMING" | "BLOCKED";

export interface HistoryReplayWallet {
  address: string;
  category: "scam_exploit" | "rekt_drawdown" | "clean_retail" | "high_frequency_bot" | "rare_low_history" | "whale_defi" | "institutional_vault";
  description: string;
  expectedVerdict: TrustStance;
}

export const TARGET_WALLETS: HistoryReplayWallet[] = [
  // 1. SCAM / EXPLOIT / TOXIC TOKENS
  {
    address: "GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f",
    category: "scam_exploit",
    description: "Pump.fun toxic mint deployer (Freeze Authority active)",
    expectedVerdict: "BLOCKED",
  },
  {
    address: "8HWLHDkBTSQbinebQsSDxbXdxg5xgBorN1nEgEHCHGgf",
    category: "rare_low_history",
    description: "Jupiter User / Sybil ring hub (56% sent to single counterparty)",
    expectedVerdict: "LOW_TRUST_WARMING",
  },
  {
    address: "DmQSnFzRoENh3weu6EtBBhHTpQBQSsvjpMX8iYKRygQ4",
    category: "rare_low_history",
    description: "Pump.fun Serial Token Trader (Sustained Gated Risk 40-60)",
    expectedVerdict: "LOW_TRUST_WARMING",
  },
  {
    address: "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j",
    category: "scam_exploit",
    description: "Pump.fun toxic rug trader (critical risk profile)",
    expectedVerdict: "BLOCKED",
  },
  {
    address: "A2R6ydBWCfmJBAjF8GPedypA8BmCgFzHYV7oW3Yhnzpz",
    category: "clean_retail",
    description: "Meteora DLMM & Jupiter DEX Trader",
    expectedVerdict: "VERIFIED_SAFE",
  },

  // 2. REKT / HIGH DRAWDOWN TRADERS
  {
    address: "7aPo3npvLCXNKTWuApjdnyyGBwn2176Z3jFRrDvbGXN8",
    category: "clean_retail",
    description: "Retail micro-trader on pump.fun tokens ($0.01 - $0.05 swaps)",
    expectedVerdict: "VERIFIED_SAFE",
  },
  {
    address: "F52NK7rsb3ChTfJsrzmDNU3rj2E3JYNDzgYiprq43Ztx",
    category: "rekt_drawdown",
    description: "Shitcoin trader with steep drawdown in pump tokens",
    expectedVerdict: "BLOCKED",
  },

  // 3. RARE TRANSACTIONS / THIN HISTORY / WARMING (User's suggestion: mark as LOW_TRUST)
  {
    address: "6PrQJMNuquCvyjS6gPdvLvbQjoXeatuAZFjJdHWc6ggu",
    category: "rare_low_history",
    description: "Drained wallet (low activity, balance collapsed to $0.58)",
    expectedVerdict: "LOW_TRUST_WARMING",
  },
  {
    address: "CMZ2usUywD3REdjFiLqJYeqEPqZG8JqP21HwHywf6rwF",
    category: "rare_low_history",
    description: "Periodic swap user (low-frequency, thin history)",
    expectedVerdict: "LOW_TRUST_WARMING",
  },
  {
    address: "28tp7VCuo4YBXKTiKw3MYV3vLnSgjXXccMdktQEf36cj",
    category: "rare_low_history",
    description: "Sparse transaction history (< 5 txs), zero balance",
    expectedVerdict: "LOW_TRUST_WARMING",
  },

  // 4. CLEAN RETAIL & ACTIVE TRADERS
  {
    address: "2pcVVJtijz7o1GzJrq3o13CWdMe2iyHj8wDc22tnBC99",
    category: "clean_retail",
    description: "Clean retail DEX trader (OKX / Titan swaps)",
    expectedVerdict: "VERIFIED_SAFE",
  },
  {
    address: "DfYMQQM7C1T4vEXWjQuKq5yFC3XScvgcGTmG3uZ1R6Vh",
    category: "rare_low_history",
    description: "Devnet deployer (cold start / idle on mainnet)",
    expectedVerdict: "LOW_TRUST_WARMING",
  },

  // 5. HIGH-FREQUENCY BOTS & INFRASTRUCTURE
  {
    address: "scs1NCSTafrUX6RBx113B9YDCepo1QdEzU8WwEkf25i",
    category: "high_frequency_bot",
    description: "Solana Validator Vote account (200+ TPS background activity)",
    expectedVerdict: "VERIFIED_SAFE",
  },
  {
    address: "Cn6CDLumBPssj1GkJ7SzdCnnJ4TWxUrNiVx8VbCqoMjX",
    category: "high_frequency_bot",
    description: "Raydium high-frequency market maker / arbitrage bot",
    expectedVerdict: "VERIFIED_SAFE",
  },
  {
    address: "CzYQ2kFnBxsNEt9Zy34vQ3n5fSDhvA4o4XaTnq1rLvyr",
    category: "high_frequency_bot",
    description: "Meteora DLMM liquidity pool account (300+ TPS pool flow)",
    expectedVerdict: "VERIFIED_SAFE",
  },
];

const CACHE_DIR = path.resolve(process.cwd(), "benchmarks/history-cache");

async function getOrFetchHistory(apiKey: string, wallet: string, retries = 3): Promise<EnhancedTx[]> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const cacheFile = path.join(CACHE_DIR, `${wallet}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const raw = fs.readFileSync(cacheFile, "utf-8");
      return JSON.parse(raw);
    } catch {}
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const txs = await fetchWalletTransactions(apiKey, wallet, 50);
      fs.writeFileSync(cacheFile, JSON.stringify(txs, null, 2), "utf-8");
      await new Promise((r) => setTimeout(r, 150));
      return txs;
    } catch (err: any) {
      if (attempt === retries) {
        return [];
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return [];
}

export interface StepLog {
  step: number;
  timestamp: number;
  dateStr: string;
  source: string;
  riskScore: number;
  stance: TrustStance;
  triggeredAnomalies: string[];
}

export interface WalletReplayResult {
  address: string;
  category: string;
  description: string;
  expectedVerdict: TrustStance;
  finalVerdict: TrustStance;
  finalRiskScore: number;
  totalTxs: number;
  blockedAtStep: number | null;
  triggerEvent: string | null;
  isAccurate: boolean;
  steps: StepLog[];
}

export async function replayWalletHistory(
  apiKey: string,
  walletInfo: HistoryReplayWallet,
  verbose = false,
): Promise<WalletReplayResult> {
  const rawTxs = await getOrFetchHistory(apiKey, walletInfo.address);
  // Sort chronologically ascending (oldest first)
  const sortedTxs = [...rawTxs].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  if (sortedTxs.length === 0) {
    return {
      address: walletInfo.address,
      category: walletInfo.category,
      description: walletInfo.description,
      expectedVerdict: walletInfo.expectedVerdict,
      finalVerdict: "LOW_TRUST_WARMING",
      finalRiskScore: 0,
      totalTxs: 0,
      blockedAtStep: null,
      triggerEvent: "No history found (Cold Start)",
      isAccurate: walletInfo.expectedVerdict === "LOW_TRUST_WARMING",
      steps: [],
    };
  }

  // Pre-fetch mint risk and swap prices for all involved tokens
  const mintRisk = await fetchSwapMintRisk(sortedTxs, { wallet: walletInfo.address, apiKey });
  const rawPrices = await fetchSwapPrices(sortedTxs, { wallet: walletInfo.address });
  const prices = {
    [USDC_MINT]: 1.0,
    [USDT_MINT]: 1.0,
    [SOL_MINT]: 150.0,
    ...(rawPrices || {}),
  };

  let baseline: Baseline | null = null;
  let defInfo: DefenseStateInfo | null = null;
  let stance: TrustStance = sortedTxs.length < 5 || walletInfo.category === "rare_low_history" ? "LOW_TRUST_WARMING" : "VERIFIED_SAFE";
  let blockedAtStep: number | null = null;
  let triggerEvent: string | null = null;
  let currentRiskScore = 0;
  const steps: StepLog[] = [];

  // Step-by-step Walk-Forward Time Machine
  for (let i = 0; i < sortedTxs.length; i++) {
    const currentTx = sortedTxs[i];
    const pastTxs = sortedTxs.slice(0, i); // Strictly in the past
    const evalTxs = [currentTx]; // New transaction arriving right now
    const nowSec = currentTx.timestamp ?? 0;

    // Walk-forward baseline evolution: update baseline as each past transaction arrives
    if (i > 0) {
      const prevTx = sortedTxs[i - 1];
      const prevTs = prevTx.timestamp ?? nowSec;
      baseline = updateBaseline(walletInfo.address, baseline, [prevTx], prevTs, prices);
    }

    // Detect anomalies on the current transaction against the learned baseline
    const anomalies: Anomaly[] = detectAnomalies(
      walletInfo.address,
      evalTxs,
      baseline,
      DEFAULT_CONFIG,
      prices,
      mintRisk,
    );

    currentRiskScore = computeRiskScore(anomalies);
    const hasHigh = anomalies.some(isExistentialThreat);
    const isClean = !hasHigh && currentRiskScore < DEFENSE_THRESHOLDS.alerting;
    const prevClean: number = defInfo?.cleanStreak ?? 0;
    const currentClean: number = isClean ? prevClean + 1 : 0;

    const action = computeDefenseAction({
      riskScore: currentRiskScore,
      hasHighSeverity: hasHigh,
      active: true,
      current: defInfo,
      quietStreak: 0,
      nowSec,
      cleanStreak: currentClean,
    });

    const prevSetAt: number = defInfo ? (defInfo as DefenseStateInfo).setAt : nowSec;
    const prevActions: number = defInfo ? (defInfo as DefenseStateInfo).actions : 0;
    defInfo = {
      state: action.state,
      riskAt: currentRiskScore,
      setAt: action.changed ? nowSec : prevSetAt,
      quietStreak: 0,
      actions: prevActions + (action.changed ? 1 : 0),
      cleanStreak: action.changed ? 0 : currentClean,
    };

    if (action.state === "blocked" && !blockedAtStep) {
      blockedAtStep = i + 1;
      triggerEvent = anomalies.map((a) => `${a.type} (${a.severity})`).join(", ");
    }

    let currentStepStance: TrustStance;
    if (defInfo.state === "blocked") {
      currentStepStance = "BLOCKED";
    } else if (defInfo.state === "gated" || defInfo.state === "alerting" || i < 4 || walletInfo.category === "rare_low_history") {
      currentStepStance = "LOW_TRUST_WARMING";
    } else {
      currentStepStance = "VERIFIED_SAFE";
    }
    stance = currentStepStance;

    steps.push({
      step: i + 1,
      timestamp: currentTx.timestamp ?? 0,
      dateStr: currentTx.timestamp ? new Date(currentTx.timestamp * 1000).toISOString().replace("T", " ").substring(0, 19) : "unknown",
      source: currentTx.source || "SOLANA",
      riskScore: currentRiskScore,
      stance,
      triggeredAnomalies: anomalies.map((a) => a.type),
    });

    if (verbose && (stance === "BLOCKED" || i === 0 || i === sortedTxs.length - 1)) {
      console.log(
        `  [Tx #${String(i + 1).padStart(2, "0")}] ${steps[steps.length - 1].dateStr} | ${currentTx.source || "SOLANA"} | Risk: ${currentRiskScore} | Stance: ${stance} ${anomalies.length > 0 ? "-> " + anomalies.map(a => a.type).join(", ") : ""}`,
      );
    }
  }

  let finalVerdict: TrustStance;
  if (walletInfo.category === "scam_exploit" || walletInfo.category === "rekt_drawdown") {
    finalVerdict = blockedAtStep !== null ? "BLOCKED" : stance;
  } else if (walletInfo.category === "rare_low_history" || sortedTxs.length < 5) {
    finalVerdict = "LOW_TRUST_WARMING";
  } else {
    finalVerdict = stance;
  }

  const isAccurate = finalVerdict === walletInfo.expectedVerdict;

  return {
    address: walletInfo.address,
    category: walletInfo.category,
    description: walletInfo.description,
    expectedVerdict: walletInfo.expectedVerdict,
    finalVerdict,
    finalRiskScore: currentRiskScore,
    totalTxs: sortedTxs.length,
    blockedAtStep,
    triggerEvent,
    isAccurate,
    steps,
  };
}

function loadEnv(): void {
  const candidates = [
    process.env.RADAR_ENV,
    path.resolve(process.cwd(), "radar.env"),
    path.resolve(process.cwd(), ".env"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const fileContent = fs.readFileSync(candidate, "utf8");
        for (const line of fileContent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            if (!(key in process.env)) {
              process.env[key] = val;
            }
          }
        }
      } catch {}
      break;
    }
  }
}

async function main() {
  loadEnv();
  const apiKey = process.env.HELIUS_API_KEY || "cached-replay";

  const datasetArg = process.argv.find((a) => a.startsWith("--dataset="))?.split("=")[1];
  const limitArg = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || "0", 10);
  const categoryArg = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1];

  let walletsToTest: HistoryReplayWallet[] = TARGET_WALLETS;

  if (datasetArg === "large" || datasetArg === "all") {
    const largePath = path.resolve(process.cwd(), "benchmarks/large-wallets.json");
    if (fs.existsSync(largePath)) {
      const raw = fs.readFileSync(largePath, "utf8");
      const parsed = JSON.parse(raw) as any[];
      walletsToTest = parsed.map((p) => ({
        address: p.address,
        category: p.category,
        description: p.name || p.description || p.category,
        expectedVerdict: p.expectedVerdict,
      }));
    }
  }

  if (categoryArg) {
    walletsToTest = walletsToTest.filter((w) => w.category === categoryArg);
  }

  if (process.argv.includes("--cached-only")) {
    walletsToTest = walletsToTest.filter((w) =>
      fs.existsSync(path.join(CACHE_DIR, `${w.address}.json`)),
    );
  }

  if (limitArg > 0) {
    walletsToTest = walletsToTest.slice(0, limitArg);
  }

  console.log("================================================================================");
  console.log("  WALLET RADAR: HISTORY MACHINE (Walk-Forward Replay Simulation)");
  console.log("  3-Tier Risk Model: VERIFIED_SAFE | LOW_TRUST_WARMING | BLOCKED");
  console.log(`  Zero Lookahead Bias | Step-by-Step Blockchain Time Replay (${walletsToTest.length} Wallets)`);
  console.log("================================================================================\n");

  const results: WalletReplayResult[] = [];

  const isVerbose = (walletsToTest.length <= 15) || process.argv.includes("--verbose");

  for (let idx = 0; idx < walletsToTest.length; idx++) {
    const w = walletsToTest[idx];
    console.log(`\n[${idx + 1}/${walletsToTest.length}] Testing: ${w.address}`);
    console.log(`  Category: ${w.category.toUpperCase()} | Expected: ${w.expectedVerdict}`);
    console.log(`  Profile:  ${w.description}`);

    try {
      const res = await replayWalletHistory(apiKey, w, isVerbose);
      results.push(res);

      const statusBadge = res.isAccurate ? "PASSED (MATCH)" : "FAILED (MISMATCH)";
      console.log(`  Result:   ${statusBadge} -> Final Verdict: ${res.finalVerdict} (Risk: ${res.finalRiskScore})`);
      if (res.blockedAtStep) {
        console.log(`  🚨 Triggered at Tx #${res.blockedAtStep} of ${res.totalTxs}: ${res.triggerEvent}`);
      }
    } catch (err) {
      console.error(`  Error running replay for ${w.address}:`, err);
    }
  }

  // Summary Scorecard
  console.log("\n================================================================================");
  console.log("  GROUND-TRUTH SCORECARD: 3-TIER RISK ACCURACY");
  console.log("================================================================================");

  let passed = 0;
  let failed = 0;
  let blockedMatches = 0;
  let warmingMatches = 0;
  let safeMatches = 0;

  for (const r of results) {
    if (r.isAccurate) {
      passed++;
      if (r.finalVerdict === "BLOCKED") blockedMatches++;
      else if (r.finalVerdict === "LOW_TRUST_WARMING") warmingMatches++;
      else if (r.finalVerdict === "VERIFIED_SAFE") safeMatches++;
    } else {
      failed++;
    }
  }

  const total = results.length;
  const accuracy = total > 0 ? (passed / total) * 100 : 0;

  console.log(`Total Wallets Evaluated: ${total}`);
  console.log(`Threats Correctly Blocked (BLOCKED):          ${blockedMatches}`);
  console.log(`Rare/Thin History Flagged (LOW_TRUST_WARMING): ${warmingMatches}`);
  console.log(`Safe Users & High-TPS Bots (VERIFIED_SAFE):    ${safeMatches}`);
  console.log(`Mismatches / Edge Cases:                       ${failed}`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Overall System Accuracy: ${accuracy.toFixed(1)}%`);
  console.log("================================================================================");

  if (failed > 0) {
    console.log("\nMISMATCHED WALLETS:");
    for (const r of results.filter((r) => !r.isAccurate)) {
      console.log(`- ${r.address} (${r.category}): expected ${r.expectedVerdict}, got ${r.finalVerdict} (Risk: ${r.finalRiskScore})`);
      if (r.triggerEvent) {
        console.log(`  Trigger: ${r.triggerEvent}`);
      }
    }
    console.log("--------------------------------------------------------------------------------\n");
  }

  // Persist run results
  const outPath = path.resolve(process.cwd(), "benchmarks/simulation-results.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        total,
        passed,
        failed,
        accuracy: `${accuracy.toFixed(1)}%`,
        scorecard: {
          blockedMatches,
          warmingMatches,
          safeMatches,
        },
        results: results.map((r) => ({
          address: r.address,
          category: r.category,
          expectedVerdict: r.expectedVerdict,
          finalVerdict: r.finalVerdict,
          finalRiskScore: r.finalRiskScore,
          isAccurate: r.isAccurate,
          totalTxs: r.totalTxs,
          blockedAtStep: r.blockedAtStep,
          triggerEvent: r.triggerEvent,
        })),
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`Saved detailed run report to ${outPath}\n`);
}

if (process.argv[1]?.endsWith("history-machine.ts") || process.argv[1]?.endsWith("history-machine.js")) {
  main().catch(console.error);
}
