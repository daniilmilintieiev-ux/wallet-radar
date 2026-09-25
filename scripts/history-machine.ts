import { fetchWalletTransactions } from "../src/collector.js";
import { updateBaseline } from "../src/baseline.js";
import { detectAnomalies, computeRiskScore } from "../src/analyzer.js";
import { fetchSwapMintRisk } from "../src/mint.js";
import { DEFAULT_CONFIG, EnhancedTx, Baseline, Anomaly } from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

export type TrustStance = "VERIFIED_SAFE" | "LOW_TRUST_WARMING" | "BLOCKED";

export interface HistoryReplayWallet {
  address: string;
  category: "scam_exploit" | "rekt_drawdown" | "clean_retail" | "high_frequency_bot" | "rare_low_history";
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
    category: "scam_exploit",
    description: "Wash-trading / Sybil ring hub (56% sent to single counterparty)",
    expectedVerdict: "BLOCKED",
  },
  {
    address: "DmQSnFzRoENh3weu6EtBBhHTpQBQSsvjpMX8iYKRygQ4",
    category: "scam_exploit",
    description: "Pump.fun insider rug (85.8% token supply concentration)",
    expectedVerdict: "BLOCKED",
  },
  {
    address: "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j",
    category: "scam_exploit",
    description: "Pump.fun toxic rug trader (critical risk profile)",
    expectedVerdict: "BLOCKED",
  },
  {
    address: "A2R6ydBWCfmJBAjF8GPedypA8BmCgFzHYV7oW3Yhnzpz",
    category: "scam_exploit",
    description: "Meteora DLMM to Pump.fun shift with toxic token exposure",
    expectedVerdict: "BLOCKED",
  },

  // 2. REKT / HIGH DRAWDOWN TRADERS
  {
    address: "7aPo3npvLCXNKTWuApjdnyyGBwn2176Z3jFRrDvbGXN8",
    category: "rekt_drawdown",
    description: "Rekt trader on shitcoins (-$1,060 USD PnL, critical drawdown)",
    expectedVerdict: "BLOCKED",
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
    category: "clean_retail",
    description: "Standard retail user (regular swaps, clean history)",
    expectedVerdict: "VERIFIED_SAFE",
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

async function getOrFetchHistory(apiKey: string, wallet: string): Promise<EnhancedTx[]> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const cacheFile = path.join(CACHE_DIR, `${wallet}.json`);
  if (fs.existsSync(cacheFile)) {
    const raw = fs.readFileSync(cacheFile, "utf-8");
    return JSON.parse(raw);
  }

  // Fetch up to 50 transactions
  const txs = await fetchWalletTransactions(apiKey, wallet, 50);
  fs.writeFileSync(cacheFile, JSON.stringify(txs, null, 2), "utf-8");
  return txs;
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

  // Pre-fetch mint risk for all involved tokens
  const mintRisk = await fetchSwapMintRisk(sortedTxs, { wallet: walletInfo.address, apiKey });

  let baseline: Baseline | null = null;
  let stance: TrustStance = sortedTxs.length < 5 ? "LOW_TRUST_WARMING" : "VERIFIED_SAFE";
  let blockedAtStep: number | null = null;
  let triggerEvent: string | null = null;
  let currentRiskScore = 0;
  const steps: StepLog[] = [];

  // Step-by-step Walk-Forward Time Machine
  for (let i = 0; i < sortedTxs.length; i++) {
    const currentTx = sortedTxs[i];
    const pastTxs = sortedTxs.slice(0, i); // Strictly in the past
    const evalTxs = [currentTx]; // New transaction arriving right now

    // Update baseline using ONLY past transactions (no future leakage!)
    if (pastTxs.length > 0) {
      const pastNewest = pastTxs[pastTxs.length - 1].timestamp ?? 0;
      baseline = updateBaseline(walletInfo.address, baseline, pastTxs, pastNewest, null);
    }

    // Detect anomalies on the current transaction against the learned baseline
    const anomalies: Anomaly[] = detectAnomalies(
      walletInfo.address,
      evalTxs,
      baseline,
      DEFAULT_CONFIG,
      null,
      mintRisk,
    );

    currentRiskScore = computeRiskScore(anomalies);
    const hasHigh = anomalies.some((a) => a.severity === "high");

    let currentStepStance: TrustStance;
    if (currentRiskScore >= 50 || hasHigh || (currentRiskScore >= 30 && anomalies.some(a => a.type === "TOXIC_MINT" || a.type === "COUNTERPARTY_HUB"))) {
      currentStepStance = "BLOCKED";
    } else if (i < 4 || currentRiskScore >= 15) {
      currentStepStance = "LOW_TRUST_WARMING";
    } else {
      currentStepStance = "VERIFIED_SAFE";
    }

    if (currentStepStance === "BLOCKED" && stance !== "BLOCKED") {
      blockedAtStep = i + 1;
      triggerEvent = anomalies.map((a) => `${a.type} (${a.severity})`).join(", ");
      stance = "BLOCKED";
    } else if (stance !== "BLOCKED") {
      stance = currentStepStance;
    }

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

  // If wallet has very few lifetime transactions, mark as LOW_TRUST_WARMING
  if (stance !== "BLOCKED" && sortedTxs.length < 5) {
    stance = "LOW_TRUST_WARMING";
  }

  const isAccurate = stance === walletInfo.expectedVerdict;

  return {
    address: walletInfo.address,
    category: walletInfo.category,
    description: walletInfo.description,
    expectedVerdict: walletInfo.expectedVerdict,
    finalVerdict: stance,
    finalRiskScore: currentRiskScore,
    totalTxs: sortedTxs.length,
    blockedAtStep,
    triggerEvent,
    isAccurate,
    steps,
  };
}

async function main() {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.error("Error: HELIUS_API_KEY is required to run the History Machine.");
    process.exit(1);
  }

  console.log("================================================================================");
  console.log("  WALLET RADAR: HISTORY MACHINE (Walk-Forward Replay Simulation)");
  console.log("  3-Tier Risk Model: VERIFIED_SAFE | LOW_TRUST_WARMING | BLOCKED");
  console.log(`  Zero Lookahead Bias | Step-by-Step Blockchain Time Replay (${TARGET_WALLETS.length} Wallets)`);
  console.log("================================================================================\n");

  const results: WalletReplayResult[] = [];

  for (let idx = 0; idx < TARGET_WALLETS.length; idx++) {
    const w = TARGET_WALLETS[idx];
    console.log(`\n[${idx + 1}/${TARGET_WALLETS.length}] Testing: ${w.address}`);
    console.log(`  Category: ${w.category.toUpperCase()} | Expected: ${w.expectedVerdict}`);
    console.log(`  Profile:  ${w.description}`);

    try {
      const res = await replayWalletHistory(apiKey, w, true);
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
  const accuracy = (passed / total) * 100;

  console.log(`Total Wallets Evaluated: ${total}`);
  console.log(`Threats Correctly Blocked (BLOCKED):          ${blockedMatches}`);
  console.log(`Rare/Thin History Flagged (LOW_TRUST_WARMING): ${warmingMatches}`);
  console.log(`Safe Users & High-TPS Bots (VERIFIED_SAFE):    ${safeMatches}`);
  console.log(`Mismatches / Edge Cases:                       ${failed}`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Overall System Accuracy: ${accuracy.toFixed(1)}%`);
  console.log("================================================================================\n");
}

if (process.argv[1]?.endsWith("history-machine.ts") || process.argv[1]?.endsWith("history-machine.js")) {
  main().catch(console.error);
}
