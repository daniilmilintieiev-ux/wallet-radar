#!/usr/bin/env node
/**
 * Automated Harvester for Solana Large Wallets Benchmark Dataset
 * 
 * Programmatically discovers and curates 100 to 400+ real Solana mainnet wallets:
 * 1. Mega Whales & Liquid Staking Holders (JitoSOL, mSOL, bSOL, WBTC, WETH, RENDER, BONK, WIF, JUP, etc.)
 * 2. Active High-Volume DEX Traders (Jupiter, Raydium, Meteora)
 * 3. Institutional Vaults & Exchange Custody (Binance, Coinbase, Squads DAOs)
 * 4. High-TPS Infrastructure (Validators, MM Arbitrageurs, Liquidity Pools)
 * 5. Cold Storage & Rare History (Dormant Wallets, Low Trust Warming)
 * 6. Negative Ground-Truth Controls (Rugs, Toxic Mints, Sybil Hubs, Exploits)
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface HarvestedWallet {
  address: string;
  name: string;
  category: "whale_defi" | "clean_retail" | "high_frequency_bot" | "institutional_vault" | "rare_low_history" | "scam_exploit" | "rekt_drawdown";
  tier: string;
  source: string;
  expectedVerdict: "VERIFIED_SAFE" | "LOW_TRUST_WARMING" | "BLOCKED";
}

const TOP_MINTS = [
  { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "JitoSOL", name: "Jito Staked SOL" },
  { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "mSOL", name: "Marinade Staked SOL" },
  { mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", symbol: "bSOL", name: "BlazeStake Staked SOL" },
  { mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", symbol: "WBTC", name: "Wormhole Wrapped BTC" },
  { mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", symbol: "WETH", name: "Wormhole Wrapped ETH" },
  { mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", symbol: "RENDER", name: "Render Token" },
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk Community Token" },
  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF", name: "Dogwifhat" },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter Governance Token" },
  { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", symbol: "RAY", name: "Raydium Token" },
  { mint: "KMNo3nJsBXfcpJTVhZnvabeWspjeiqujnmKyZpKwAhN", symbol: "KMNO", name: "Kamino Governance Token" },
  { mint: "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7", symbol: "DRIFT", name: "Drift Protocol Token" },
  { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", symbol: "PYTH", name: "Pyth Network Token" },
  { mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", symbol: "HNT", name: "Helium Network Token" },
  { mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", symbol: "MEW", name: "Cat in a Dogs World" },
  { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", symbol: "POPCAT", name: "Popcat Solana" }
];

// Baseline curated seed accounts (Threats, Infrastructure, CEX, Protocol Vaults)
const SEED_WALLETS: HarvestedWallet[] = [
  // 1. Core Threat Benchmarks (7 Ground-Truth BLOCKED)
  { address: "GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f", name: "Pump.fun Toxic Mint Deployer", category: "scam_exploit", tier: "malicious_deployer", source: "threat_seed", expectedVerdict: "BLOCKED" },
  { address: "8HWLHDkBTSQbinebQsSDxbXdxg5xgBorN1nEgEHCHGgf", name: "Wash-Trading / Sybil Ring Hub", category: "scam_exploit", tier: "sybil_hub", source: "threat_seed", expectedVerdict: "BLOCKED" },
  { address: "DmQSnFzRoENh3weu6EtBBhHTpQBQSsvjpMX8iYKRygQ4", name: "Pump.fun Insider Rugpuller", category: "scam_exploit", tier: "rugpuller", source: "threat_seed", expectedVerdict: "BLOCKED" },
  { address: "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j", name: "Pump.fun Toxic Rug Trader", category: "scam_exploit", tier: "toxic_trader", source: "threat_seed", expectedVerdict: "BLOCKED" },
  { address: "A2R6ydBWCfmJBAjF8GPedypA8BmCgFzHYV7oW3Yhnzpz", name: "Meteora DLMM to Toxic Token Shift", category: "scam_exploit", tier: "compromised", source: "threat_seed", expectedVerdict: "BLOCKED" },
  { address: "7aPo3npvLCXNKTWuApjdnyyGBwn2176Z3jFRrDvbGXN8", name: "Retail micro-trader on pump.fun (.01-.05)", category: "clean_retail", tier: "rekt_trader", source: "threat_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "F52NK7rsb3ChTfJsrzmDNU3rj2E3JYNDzgYiprq43Ztx", name: "Retail pump.fun trader with drawdown (.05-.20)", category: "clean_retail", tier: "rekt_trader", source: "threat_seed", expectedVerdict: "VERIFIED_SAFE" },

  // 2. High-Frequency Bots & Infrastructure (VERIFIED_SAFE)
  { address: "scs1NCSTafrUX6RBx113B9YDCepo1QdEzU8WwEkf25i", name: "Solana Validator Vote Account", category: "high_frequency_bot", tier: "infrastructure", source: "infra_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "Cn6CDLumBPssj1GkJ7SzdCnnJ4TWxUrNiVx8VbCqoMjX", name: "Raydium HF MM / Arbitrage Bot", category: "high_frequency_bot", tier: "market_maker", source: "infra_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "CzYQ2kFnBxsNEt9Zy34vQ3n5fSDhvA4o4XaTnq1rLvyr", name: "Meteora DLMM Liquidity Pool Account", category: "high_frequency_bot", tier: "liquidity_pool", source: "infra_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "AVzP2GeRmqGphJsMxWoqjpUifPpCret7LqWhD8NWQK49", name: "Jupiter Perps LP Custody Vault", category: "high_frequency_bot", tier: "institutional_vault", source: "infra_seed", expectedVerdict: "VERIFIED_SAFE" },

  // 3. Institutional Vaults & Exchange Custody (VERIFIED_SAFE)
  { address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", name: "Jupiter Aggregator v6 Protocol Authority", category: "institutional_vault", tier: "protocol_authority", source: "vault_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", name: "Binance Cold/Hot Storage (9.9M SOL)", category: "institutional_vault", tier: "exchange_custody", source: "vault_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "5tzFkiKscMRHK5ZXkrZXZ1RWhLPTDPJCnwMNh1AD1N83", name: "Binance Hot Wallet 1", category: "institutional_vault", tier: "exchange_custody", source: "vault_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm", name: "Coinbase Prime Custody Hot Wallet", category: "institutional_vault", tier: "exchange_custody", source: "vault_seed", expectedVerdict: "VERIFIED_SAFE" },

  // 4. Cold Storage & Rare History (LOW_TRUST_WARMING)
  { address: "HV43yQBZVK6ehg9WZfjUqk3ZthXoQQoErW9gV6uTYzzV", name: "Solana WBTC Cold Custody Whale", category: "rare_low_history", tier: "cold_whale", source: "cold_seed", expectedVerdict: "LOW_TRUST_WARMING" },
  { address: "6PrQJMNuquCvyjS6gPdvLvbQjoXeatuAZFjJdHWc6ggu", name: "Drained Inactive Wallet ($0.58)", category: "rare_low_history", tier: "drained", source: "cold_seed", expectedVerdict: "LOW_TRUST_WARMING" },
  { address: "CMZ2usUywD3REdjFiLqJYeqEPqZG8JqP21HwHywf6rwF", name: "Periodic Low-Frequency Swap User", category: "rare_low_history", tier: "thin_retail", source: "cold_seed", expectedVerdict: "LOW_TRUST_WARMING" },
  { address: "28tp7VCuo4YBXKTiKw3MYV3vLnSgjXXccMdktQEf36cj", name: "Sparse History Wallet (< 5 txs)", category: "rare_low_history", tier: "cold_start", source: "cold_seed", expectedVerdict: "LOW_TRUST_WARMING" },
  { address: "DfYMQQM7C1T4vEXWjQuKq5yFC3XScvgcGTmG3uZ1R6Vh", name: "Devnet Deployer (Idle on Mainnet)", category: "rare_low_history", tier: "cold_start", source: "cold_seed", expectedVerdict: "LOW_TRUST_WARMING" },

  // 5. Active Retail Traders
  { address: "2pcVVJtijz7o1GzJrq3o13CWdMe2iyHj8wDc22tnBC99", name: "Clean Retail DEX Trader (OKX / Titan)", category: "clean_retail", tier: "retail", source: "retail_seed", expectedVerdict: "VERIFIED_SAFE" },
  { address: "HMpTY7xwbk2rJZpVapq2vzyzdkfoWCe24MfbR18WYfU8", name: "Jupiter High-Frequency Trader", category: "clean_retail", tier: "active_trader", source: "retail_seed", expectedVerdict: "VERIFIED_SAFE" }
];

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
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!(key in process.env)) process.env[key] = val;
          }
        }
      } catch {}
      break;
    }
  }
}

async function main() {
  loadEnv();
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.error("Error: HELIUS_API_KEY is required to harvest on-chain whale wallets.");
    process.exit(1);
  }

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const targetCount = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || "1000", 10);
  console.log(`================================================================================`);
  console.log(`  WALLET RADAR: LARGE WALLET HARVESTER (Target: ${targetCount} Wallets)`);
  console.log(`================================================================================`);

  const outPath = path.resolve(process.cwd(), "benchmarks/large-wallets.json");
  const walletMap = new Map<string, HarvestedWallet>();

  // Load existing harvested wallets if present to incrementally build up to targetCount
  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, "utf8")) as HarvestedWallet[];
      for (const w of existing) {
        walletMap.set(w.address, w);
      }
      console.log(`[0/3] Loaded ${walletMap.size} existing wallets from benchmarks/large-wallets.json.`);
    } catch {}
  }

  // Add / update seed wallets
  for (const seed of SEED_WALLETS) {
    walletMap.set(seed.address, seed);
  }

  console.log(`[1/3] Seeded baseline benchmark wallets (${walletMap.size} loaded).`);

  // Discover top token holders across major assets
  console.log(`[2/3] Querying top token accounts across ${TOP_MINTS.length} leading Solana assets...`);
  
  for (const token of TOP_MINTS) {
    if (walletMap.size >= targetCount) break;
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [token.mint]
        })
      });
      const data = await res.json() as any;
      const topAccs = (data.result?.value || []).slice(0, 30);

      // Batch query account info to find owners
      for (const acc of topAccs) {
        if (walletMap.size >= targetCount) break;
        try {
          const r2 = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getAccountInfo",
              params: [acc.address, { encoding: "jsonParsed" }]
            })
          });
          const d2 = await r2.json() as any;
          const owner = d2.result?.value?.data?.parsed?.info?.owner;
          if (owner && !walletMap.has(owner) && owner.length >= 32) {
            walletMap.set(owner, {
              address: owner,
              name: `${token.symbol} Whale (${acc.uiAmountString} ${token.symbol})`,
              category: "whale_defi",
              tier: "token_whale",
              source: `top_holder_${token.symbol.toLowerCase()}`,
              expectedVerdict: "VERIFIED_SAFE"
            });
            process.stdout.write(`\rDiscovered: ${walletMap.size}/${targetCount} wallets (Latest: ${token.symbol} whale ${owner.slice(0, 8)}...)`);
          }
        } catch {}
      }
    } catch (e: any) {
      console.warn(`\nWarning: Failed to fetch holders for ${token.symbol}: ${e.message}`);
    }
  }

  // Query active Solana consensus validators (100% verified high_frequency_bot)
  if (walletMap.size < targetCount) {
    console.log(`\nQuerying active Solana Consensus Validators...`);
    try {
      const vRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getVoteAccounts"
        })
      });
      const vData = await vRes.json() as any;
      const validators = (vData.result?.current || []).slice(0, 120);
      for (const val of validators) {
        if (walletMap.size >= targetCount) break;
        if (val.votePubkey && !walletMap.has(val.votePubkey)) {
          walletMap.set(val.votePubkey, {
            address: val.votePubkey,
            name: `Solana Validator (${val.nodePubkey.slice(0, 8)}...)`,
            category: "high_frequency_bot",
            tier: "consensus_validator",
            source: "validator_registry",
            expectedVerdict: "VERIFIED_SAFE"
          });
        }
      }
      console.log(`Added validators. Total wallets now: ${walletMap.size}`);
    } catch (e: any) {
      console.warn("Failed to fetch validators:", e.message);
    }
  }

  // Query active DEX routers if we still need more wallets to reach targetCount
  const DEX_ROUTERS = [
    { name: "Jupiter Aggregator v6", program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", source: "jupiter_feed" },
    { name: "Raydium AMM v4", program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", source: "raydium_feed" },
    { name: "Meteora DLMM", program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", source: "meteora_feed" },
    { name: "Pump.fun Router", program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", source: "pumpfun_feed" },
  ];

  if (walletMap.size < targetCount) {
    console.log(`\n[3/3] Querying active DEX traders across major liquidity venues...`);
    for (const dex of DEX_ROUTERS) {
      if (walletMap.size >= targetCount) break;
      let beforeSig: string | null = null;
      let pages = 0;
      const maxPagesPerDex = 15;

      while (walletMap.size < targetCount && pages < maxPagesPerDex) {
        pages++;
        try {
          let url = `https://api.helius.xyz/v0/addresses/${dex.program}/transactions?api-key=${apiKey}&limit=100`;
          if (beforeSig) {
            url += `&before=${beforeSig}`;
          }
          const res = await fetch(url);
          const txs = await res.json() as any[];
          if (!Array.isArray(txs) || txs.length === 0) break;

          for (const t of txs) {
            if (walletMap.size >= targetCount) break;
            const payer = t.feePayer;
            if (payer && !walletMap.has(payer) && payer.length >= 32) {
              walletMap.set(payer, {
                address: payer,
                name: `Active ${dex.name} Trader (${payer.slice(0, 8)}...)`,
                category: "clean_retail",
                tier: "active_trader",
                source: dex.source,
                expectedVerdict: "VERIFIED_SAFE"
              });
              process.stdout.write(`\rDiscovered: ${walletMap.size}/${targetCount} wallets (Latest: ${dex.name} trader ${payer.slice(0, 8)}...)`);
            }
          }
          beforeSig = txs[txs.length - 1]?.signature || null;
          if (!beforeSig) break;
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          break;
        }
      }
    }
  }

  console.log(`\n\n✔ Successfully collected ${walletMap.size} benchmark wallets!`);

  const outputWallets = Array.from(walletMap.values());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(outputWallets, null, 2), "utf8");

  console.log(`Dataset saved to: ${outPath}`);
  console.log(`Breakdown by category:`);
  const catCounts: Record<string, number> = {};
  for (const w of outputWallets) {
    catCounts[w.category] = (catCounts[w.category] || 0) + 1;
  }
  for (const [c, n] of Object.entries(catCounts)) {
    console.log(`  • ${c.padEnd(22)}: ${n}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
