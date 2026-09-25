import { Store } from "./store.js";
import { computeRiskScore } from "./analyzer.js";
import { Anomaly } from "./types.js";
import { getTelegramSink, TelegramSink } from "./alerts.js";

/** Human-readable archetype labels for known monitored mainnet wallets. */
export const KNOWN_WALLET_LABELS: Record<string, string> = {
  "GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f": "Pump.fun Trader",
  "CMZ2usUywD3REdjFiLqJYeqEPqZG8JqP21HwHywf6rwF": "Pump.fun Trader",
  "7aPo3npvLCXNKTWuApjdnyyGBwn2176Z3jFRrDvbGXN8": "Pump.fun Trader",
  "CA59n4oZNMEdzRPJWjjVEN5SL2kvhkasRMP73SNYh6x4": "Raydium Trader",
  "6PrQJMNuquCvyjS6gPdvLvbQjoXeatuAZFjJdHWc6ggu": "Raydium Trader",
  "Cn6CDLumBPssj1GkJ7SzdCnnJ4TWxUrNiVx8VbCqoMjX": "Raydium Trader",
  "DmQSnFzRoENh3weu6EtBBhHTpQBQSsvjpMX8iYKRygQ4": "Jupiter User",
  "8HWLHDkBTSQbinebQsSDxbXdxg5xgBorN1nEgEHCHGgf": "Jupiter User",
  "28tp7VCuo4YBXKTiKw3MYV3vLnSgjXXccMdktQEf36cj": "Jupiter User",
  "CzYQ2kFnBxsNEt9Zy34vQ3n5fSDhvA4o4XaTnq1rLvyr": "Meteora DLMM",
  "A2R6ydBWCfmJBAjF8GPedypA8BmCgFzHYV7oW3Yhnzpz": "Meteora DLMM",
  "F52NK7rsb3ChTfJsrzmDNU3rj2E3JYNDzgYiprq43Ztx": "Meteora DLMM",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium AMM Auth",
  "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j": "Dormant Whale",
  "scs1NCSTafrUX6RBx113B9YDCepo1QdEzU8WwEkf25i": "Validator Vote",
  "DfYMQQM7C1T4vEXWjQuKq5yFC3XScvgcGTmG3uZ1R6Vh": "Deployer Baseline",
  "3fNNuJcvV2bYmrh7XjTq7u22C7V6F2qXq8pE4jM5eYh": "x402 Payer",
  "2pcVVJtijz7o1GzJrq3o13CWdMe2iyHj8wDc22tnBC99": "Whale Reference",
};

/** Human-readable rule descriptions for clean presentation. */
export const RULE_LABELS: Record<string, string> = {
  TOXIC_MINT: "Toxic Token (Freeze/Mint auth active)",
  REGIME_SHIFT: "Behavioral Regime Shift",
  ACTIVITY_BURST: "Transaction Frequency Burst",
  CONCENTRATION: "Single Token Concentration",
  NEW_COUNTERPARTY: "New Counterparties",
  NEW_PROTOCOL: "New Protocol Interaction",
  DORMANT_ACTIVE: "Dormant Wallet Awakening",
  LARGE_SWAP: "Anomalous Large Swap",
  RAPID_DRAIN: "Rapid Liquidity Outflow",
};

export interface WalletDigestItem {
  wallet: string;
  shortAddress: string;
  label: string;
  riskScore: number;
  defenseState: string;
  anomaliesCount: number;
  topRuleNames: string[];
  anomalies: Array<{ type: string; severity: string; text: string }>;
}

export interface DailyDigestData {
  generatedAtSec: number;
  dateStr: string;
  timeStr: string;
  windowHours: number;
  totalWatched: number;
  activeInWindow: number;
  txsCount: number;
  totalAnomaliesCount: number;
  severityCounts: { high: number; medium: number; low: number };
  flaggedWallets: WalletDigestItem[];
  safeWalletsCount: number;
  defenseStats: { blocked: number; gated: number; alerting: number; armed: number };
  economics: {
    revenueUsdc: number;
    paymentsCount: number;
    costUsd: number;
    netUsd: number;
  };
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/** Builds aggregation data for the last N hours (default 24h). */
export function buildDailyDigestData(
  store: Store,
  options: { nowSec?: number; windowHours?: number } = {},
): DailyDigestData {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const windowHours = options.windowHours ?? 24;
  const sinceSec = nowSec - windowHours * 3600;

  const watched = store.listWallets();
  const defenseStates = store.listDefenseStates();
  const defenseMap = new Map<string, string>();
  for (const ds of defenseStates) {
    defenseMap.set(ds.wallet, ds.state.state);
  }

  // 1. Anomalies in window
  const rawAnomalies = store.getAnomaliesSince(sinceSec);
  const byWalletAnomalies = new Map<string, Anomaly[]>();
  const severityCounts = { high: 0, medium: 0, low: 0 };

  for (const a of rawAnomalies) {
    const sev = a.severity as "high" | "medium" | "low";
    if (sev in severityCounts) severityCounts[sev] += 1;
    const arr = byWalletAnomalies.get(a.wallet) ?? [];
    arr.push({
      type: a.type,
      wallet: a.wallet,
      severity: a.severity,
      timestamp: a.timestamp,
      evidence: a.evidence,
      text: a.text,
    });
    byWalletAnomalies.set(a.wallet, arr);
  }

  // 2. Transactions seen in window
  const seenStats = store.getSeenTxCountSince(sinceSec);

  // 3. Flagged wallets with anomalies in this window
  const flaggedWallets: WalletDigestItem[] = [];
  for (const [wallet, anomalies] of byWalletAnomalies.entries()) {
    const riskScore = computeRiskScore(anomalies);
    const ruleTypes = Array.from(new Set(anomalies.map((a) => a.type)));
    const topRuleNames = ruleTypes.map((t) => RULE_LABELS[t] || t);
    const label = KNOWN_WALLET_LABELS[wallet] || "Solana Wallet";
    const defenseState = defenseMap.get(wallet) || "armed";

    flaggedWallets.push({
      wallet,
      shortAddress: shortAddress(wallet),
      label,
      riskScore,
      defenseState,
      anomaliesCount: anomalies.length,
      topRuleNames,
      anomalies: anomalies.slice(0, 3).map((a) => ({ type: a.type, severity: a.severity, text: a.text })),
    });
  }

  // Sort flagged wallets by risk score descending, then anomalies count
  flaggedWallets.sort((a, b) => b.riskScore - a.riskScore || b.anomaliesCount - a.anomaliesCount);

  // 4. Defense posture stats across all watched wallets
  const defenseStats = { blocked: 0, gated: 0, alerting: 0, armed: 0 };
  for (const w of watched) {
    const st = (defenseMap.get(w) || "armed").toLowerCase();
    if (st === "blocked") defenseStats.blocked++;
    else if (st === "gated") defenseStats.gated++;
    else if (st === "alerting") defenseStats.alerting++;
    else defenseStats.armed++;
  }

  // 5. Unit economics in window
  const cost = store.getCostSummarySince(sinceSec);
  const rev = store.getRevenueSummarySince(sinceSec);
  const netUsd = Math.round((rev.totalUsdc - cost.totalUsd) * 1e6) / 1e6;

  // Active wallets count = wallets with txs or anomalies in this window
  const activeSet = new Set<string>([...Object.keys(seenStats.byWallet), ...byWalletAnomalies.keys()]);

  // Date and time formatting
  const d = new Date(nowSec * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr = `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const timeStr = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;

  return {
    generatedAtSec: nowSec,
    dateStr,
    timeStr,
    windowHours,
    totalWatched: watched.length,
    activeInWindow: activeSet.size,
    txsCount: seenStats.total,
    totalAnomaliesCount: rawAnomalies.length,
    severityCounts,
    flaggedWallets,
    safeWalletsCount: Math.max(0, watched.length - flaggedWallets.length),
    defenseStats,
    economics: {
      revenueUsdc: rev.totalUsdc,
      paymentsCount: rev.payments,
      costUsd: cost.totalUsd,
      netUsd,
    },
  };
}

/** Formats the aggregated data into a visually pleasing, human-readable Telegram HTML message. */
export function formatDailyDigestHtml(data: DailyDigestData): string {
  const lines: string[] = [];

  // Header
  lines.push("🛡️ <b>WALLET RADAR · DAILY DIGEST</b>");
  lines.push(`<i>${data.dateStr} · 07:00 (UTC+3) · Orange Pi Node</i>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("");

  // General monitoring stats
  lines.push("📊 <b>24-HOUR MONITORING SUMMARY</b>");
  lines.push(`• Wallets protected: <b>${data.totalWatched}</b>`);
  lines.push(`• Active in 24h: <b>${data.activeInWindow}</b>`);
  if (data.txsCount > 0) {
    lines.push(`• Transactions verified: <b>${data.txsCount}</b> tx`);
  }
  lines.push(
    `• Anomalies detected: <b>${data.totalAnomaliesCount}</b> ` +
      `(🔴 ${data.severityCounts.high} · 🟡 ${data.severityCounts.medium} · ⚪ ${data.severityCounts.low})`,
  );
  lines.push("");

  // Flagged wallets section
  if (data.flaggedWallets.length > 0) {
    lines.push("🚨 <b>KEY THREATS & HIGH-RISK EVENTS</b>");
    for (const w of data.flaggedWallets.slice(0, 6)) {
      const badge = w.riskScore >= 70 ? "🔴" : w.riskScore >= 30 ? "🟡" : "🟢";
      const postureBadge = w.defenseState === "blocked" ? " [BLOCKED 🛑]" : "";
      lines.push(`${badge} <code>${w.shortAddress}</code> [${escapeHtml(w.label)}]${postureBadge}`);
      lines.push(`   ├ Risk: <b>${w.riskScore}/100</b> · Anomalies: <b>${w.anomaliesCount}</b>`);
      const rulesList = w.topRuleNames.slice(0, 3).join(", ");
      lines.push(`   └ ⚠️ <i>${escapeHtml(rulesList)}</i>`);
      lines.push("");
    }
  } else {
    lines.push("🟢 <b>STATUS: ALL CLEAR</b>");
    lines.push("No critical anomalies or suspicious manipulations detected in the past 24 hours.");
    lines.push("");
  }

  // Safe wallets summary
  if (data.safeWalletsCount > 0) {
    lines.push(`🟢 <b>HEALTHY / UNFLAGGED (${data.safeWalletsCount}):</b>`);
    lines.push("• Validators, DEX market makers, and Jupiter traders operating within normal baseline.");
    lines.push("");
  }

  // Pillar 3 Active Defense Stances
  lines.push("🛡️ <b>ACTIVE DEFENSE (Pillar 3 Posture)</b>");
  if (data.defenseStats.blocked > 0) {
    lines.push(`• 🛑 <b>BLOCKED ($0 spend limit):</b> ${data.defenseStats.blocked} wallet(s)`);
  }
  if (data.defenseStats.gated > 0) {
    lines.push(`• ⚠️ <b>GATED ($100 spend limit):</b> ${data.defenseStats.gated} wallet(s)`);
  }
  lines.push(`• 🟢 <b>ARMED (Normal stance):</b> ${data.defenseStats.armed} wallet(s)`);
  lines.push("");

  // Economics
  lines.push("💰 <b>NODE UNIT ECONOMICS (x402 & API)</b>");
  lines.push(`• Revenue (USDC settled): <b>${data.economics.revenueUsdc} USDC</b>`);
  lines.push(`• RPC Cost (Helius): <b>$${data.economics.costUsd.toFixed(4)}</b>`);
  const netSign = data.economics.netUsd >= 0 ? "+" : "";
  const netEmoji = data.economics.netUsd >= 0 ? "✅" : "⚖️";
  lines.push(`• Daily Net PnL: <b>${netSign}$${data.economics.netUsd.toFixed(4)}</b> (${netEmoji})`);
  lines.push("");

  // Footer links
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push('🌐 <b>Dashboard:</b> <a href="https://radar.cbellory.xyz/dashboard">radar.cbellory.xyz/dashboard</a>');
  lines.push('⚡ <b>Blinks:</b> <a href="https://pay.cbellory.xyz/actions.json">pay.cbellory.xyz</a>');

  return lines.join("\n");
}

/** Sends the formatted daily digest to Telegram via TelegramSink. */
export async function sendDailyDigest(
  store: Store,
  options: {
    sink?: TelegramSink;
    nowSec?: number;
    windowHours?: number;
    markAlerted?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ ok: boolean; message: string; data: DailyDigestData; text: string }> {
  const data = buildDailyDigestData(store, options);
  const text = formatDailyDigestHtml(data);

  const sink = options.sink ?? getTelegramSink(options.fetchImpl);
  if (!sink) {
    return {
      ok: false,
      message: "TG_BOT_TOKEN or TG_CHAT_ID is not configured in environment.",
      data,
      text,
    };
  }

  await sink.sendHtml(text);

  if (options.markAlerted) {
    store.markAllAlerted(null);
  }

  return { ok: true, message: "Daily digest sent successfully.", data, text };
}
