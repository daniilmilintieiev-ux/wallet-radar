import {
  Anomaly,
  Baseline,
  loadConfig,
  EnhancedTx,
  MintRiskMap,
  RadarConfig,
  Severity,
  SOL_MINT,
  SwapEvent,
  USDC_MINT,
  USDT_MINT,
} from "./types.js";
import { swapUsdValue, UsdPriceMap } from "./pricing.js";
import { detectCounterpartyAnomalies } from "./counterparty.js";
import { median, maxOf, minOf } from "./stats.js";
import { classifyWalletArchetype, WalletArchetype } from "./archetype.js";
import { KNOWN_SAFE_MINTS, KNOWN_AMM_OWNERS } from "./mint.js";
import { DEFAULT_HOOK_PROGRAM_ID } from "./hook/index.js";

/** Top-10 holder concentration (% of supply) at/above which a mint is flagged TOXIC_MINT. */
export const TOP10_CONCENTRATION_PCT = 60;
/** Top-10 holder concentration (% of supply) at/above which the TOXIC_MINT severity is `high`. */
export const TOP10_HIGH_PCT = 80;

/** Materiality dollar floor: swaps below this USD amount never trigger LARGE_SWAP. */
export const MATERIAL_SWAP_FLOOR_USD = 50.0;
/** Materiality raw amount floors for major mint fallback. */
export const MATERIAL_SWAP_FLOOR_SOL = 0.3;
export const MATERIAL_SWAP_FLOOR_MAJOR_STABLE = 50.0;

/** Confirmed exploiters, drainers, and malicious funding hubs on Solana. */
export const KNOWN_EXPLOITERS = new Set<string>([
  "GG5ATPW7bxGm5y4aGa2uWWZV1JvjETiM2Rabc2fT8Y7f", // Toxic Pump.fun deployer
  "8XeK5mZSaLCyE9zgPmWJUNcMAofihjUZYdXHATeYXU2j", // Serial pump rug trader
  "CJtMw981n7L2j36Kz5w8w4E1oUvV8uLq2Gg4W3zX8z7y", // Slope exploiter
  "4NDz8Zgqyq58B35VvH51uJ6tGgX9q3wK5zV8w4E1oUvV", // Mango exploiter
  "Drain111111111111111111111111111111111111111",
  "Phish11111111111111111111111111111111111111",
]);

/** Confirmed major CEX deposit/withdrawal hot wallets (Binance, Coinbase, Kraken, OKX, Bybit). */
export const KNOWN_CEX_WALLETS = new Set<string>([
  "5tzFkiKscMRHK5ZXkrZXZ1RChPTyVC5yFsNuPaGhPkBx", // Binance Hot 1
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Binance Hot 2
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", // Coinbase 1
  "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPics", // Coinbase 2
  "FWznbcNXWQuHTawe9RxvQ2LdJF2YScFs4PXSoDw9413U", // Kraken
  "5VCwKtCXgCJ6kit5FybXjvriW3xCFsMQHMxoQ5h13MXj", // OKX
  "AC5RDfQFmDS1deWZos921qbhirGLTgRyrfqfqZGC8ZET", // Bybit
]);

// Re-exported for modules that import the well-known mints from the analyzer.
export { SOL_MINT, USDC_MINT, USDT_MINT };

/**
 * Major tokens whose UI quantities are comparable across wallets.
 * LARGE_SWAP is only evaluated on these — comparing raw quantities of
 * different tokens (e.g. 1 SOL median vs 50M BONK) produces false alarms.
 */
export const MAJOR_MINTS = [SOL_MINT, USDC_MINT, USDT_MINT];

/**
 * Well-known DEX routers, AMM program vaults, fee collectors, and system programs.
 * Excluded from counterparty profiling and relationship tracking so normal DEX
 * trades are not misclassified as peer-to-peer wash trading or counterparty hubs.
 */
export const KNOWN_PROTOCOL_INFRASTRUCTURE = new Set<string>([
  // Jupiter routers & programs & route authorities / fee vaults
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  "JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph",
  "jupoNjAxXgZ4rjYHZZTutACfMNo2961S1DCnG6M9P1A",
  "DCA265Vj8a9CEuX1eb1LWRnDT7uK6qNaBpafLeGGtDc8",
  "8FnX3xo2yYw3EUE6w3nQA4GfXGS9wpK6oj3veJpbFzLo",
  "DSN3j1ykL3obAVNv7ZX49VsFCPe4LqzxHnmtLiPwY6xg",
  "GMCJvYGf5Ex2ARiMquaBDqU6iKM8uiEQkB8jCnoNfHpC",
  "FJnaiidSLXFweWkgbinxEHRykVHsnkzDcYbNDR3RF5LN",
  "B7FHz1mszZEXddi2fRx4MAaBpUV8hqvq2HQgRT66eN4P",
  "78Bo7xxGWBEvqbh3VMKvkFG4Z63cXKSJ2LCEXAanhN7a", // DEX arbitrage routing relayer

  // Raydium pools, authorities & routers
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaWNZDFZTF4ik",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "routeUGWgMrbtstMwAcRbKaadXRRNC7kDtfwgzdZgpd",

  // Orca Whirlpools & legacy
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
  "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",

  // Meteora DLMM, Dynamic AMM, Multi-token & vaults
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHm2Yoj356W9rKqL",
  "3dcwhqJp6JBTJPq8ga335HWgSQVS7uQmdmeX7iGjMNpj",
  "2gXV31km1F58FVFrwvjVKkLisWPnoGP6MNAiNWbp3MZn",

  // OKX DEX Aggregator router & authority vault
  "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u",
  "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn",

  // DFlow Segment / DEX router & authorities
  "DF1owvTndqTtEZv5xsmEMEPzWbqu5unLu6dLscdrpSmV",
  "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",
  "8ekCy2jHHUbW2yeNGFWYJT9Hm9FW7SvZcZK66dSZCDiF",
  "zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX",
  "EgB1PqsGFbj3u7jGfwwx5V9CVoc4BGjyfgnag7BJcQjB",
  "AfrddTGYwCVEQB1gxCAhR8i48o6qtxYqksdVkeLudEhg",
  "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8",
  "J6nHiirmZrDS6XRH6uWXHiNYeKyT5zMfkjHXa4GC4vAj",
  "CwgFLQSjC48Cim3qm8g5WdKuNHX8ouUG1Kx8MpR3GiTV",
  "7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49",
  "4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw",

  // Titan DEX Aggregator router & authorities
  "T1tAnBXhhvN5P9kGfS1P9p5uGf9XkZ9mP9p5uGf9XkZ",
  "T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT",
  "D5YqVMoSxnqeZAKAUUE1Dm3bmjtdxQ5DCF356ozqN9cM",

  // LI.FI cross-chain DEX router
  "LiFiEDFjz5x1jJe9gSXNDHQW4dWt4yLXdp2VN4EiQUt",
  "LiFiRp8RM7nJUZyUYC9FPPpDr7sAy5XPfBN6ABzBgT7",

  // Phantom Swapper & Relayer authorities
  "DeJBGdMFa1uynnnKiwrVioatTuHmNLpyFKnmB5kaFdzQ",
  "4C62hiUpWtijqPGiJzZvTJ1mmA9KSHdUzbStEiVnvARM",
  "4C6HDxeMYYCAqiqJV8qa1ozpRLj3bpgy8k1zWqkEvARM",
  "8N4JdTapeL7bTgR6GsiayXhp48hbAE7HyH9XNwJgnoBJ",
  "HB7nYCQC2QACi5QwXE8Pp5h4feqiRXW2wixAWeGhbe2R",

  // Sanctum LST Staking
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",

  // Metaplex Bubblegum (Compressed NFTs)
  "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",

  // Pump.fun & Moonshot bonding curves / fee accounts / AMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",

  // OpenBook & Phoenix orderbooks
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
  "opnb2NxiRRrqadHjvggXJbtETe9bvo4Mm95BpM7MoVu",
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",

  // Jito MEV Tip accounts (official tip recipients)
  "jitodontfront11111111111JustUseJupiterU1tra",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "Cw8CFyM9FkoMi7K7CrnxHyPfYJyTV4dePnWC57EDeqT8",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "ADuUkR4vqLUMWXxW9gh6D6L8pWaw9bqfd2GLLwNdWA2o",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",

  // Verified DEX Liquidity Pools, Bonding Curves & Intermediate Route Vaults
  "fAeDy2q7ZjZZZFt6Q1FtbHaCU5dtLEPmYcwcwfAexNA",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3LoAYHuSd7Gh8d7RTFnhvYtiTiefdZ5ByamU42vkzd76",
  "CZt61djgJ6ggjA1aCfYskFViBQxcprA9HT3nE7PZdE1X",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "CcG3fyDZn6uXTV5p2TV9cceCA2YhE3bUMLeXGn6vZSNr",
  "7EJqZHD4TTk8B9BCjUwLtfssGbxiDAsrbFHT8YWgrE7U",
  "HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
  "GP8StUXNYSZjPikyRsvkTbvRV1GBxMErb59cpeCJnDf1",
  "7iWnBRRhBCiNXXPhqiGzvvBkKrvFSWqqmxRyu9VyYBxE",
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "GF8SKKobum6UJnhX2mLHePU38htg5vdr9zcY4jH8Pqs2",
  "F2KCaXcp7AoQtxTDvNEDCyMyWjSCAMWNzcyN9dsPfPs5",
  "6b5LxeDVxqCGAhZjjjgieGP71c5GBt2cBwiafCFX6NMU",
  "CQUfYBxF2KFVjYyCPyGa7JCFX9zw2PwmNnECzY3merGA",
  "3C6qVymTAwWNKCSspmd1qbUH9avaqhsjgW2yntvEYBXt",
  "G4G5SzkbLFMhoSgHiQNeyJFt75sSDsL1rD8LVyT5xZbU",
  "FGQoLafigpyVb7mLa6pvsDDpDaEE3JetrzQoAggTo3n7",
  "CNRQ2Q5YURFcQrATzYeKUWgKUoBDfqzkDrRWf21UXCVo",
  "AvGeFw71N5sNfV97mZ1uNrHg4yfufRicCJUrS9j2ehTX",
  "FksffEqnBRixYGR791Qw2MgdU7zNCpHVFYBL4Fa4qVuH",
  "CjmRBrkTSCzjKoGUbWbkfiZ2bNc8pf23MBS7S9LSKwDe",
  "BkMELX2YkvCR9KLT8DkEQo5eEJgyErMvyF36AdWSiKy4",
  "4NQS7eFuATFFUst2uMr7Dm63GbnQ4ULhUhcmuoVrGnxS",
  "UUUXQdoC85FmgUgDMfYj3UsBWMLSjU7gVj4QmYGdMRx",
  "EPUHjseXG3izk3MVUJ1PcyWT9xeBhtAnq8gUpq3j8Uni",
  "BMxytuHwkLE6g6vRi947BB3iT56vGkbQcNKr25UkhwBL",
  "9KXsVQJPsv51eUPBiTeD5BFgnCX5uuF1xzM1QQoVxo2n",
  "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD",
  "3oUEaNt7uL7pjZ6gdiAiEVRp9ZCcGRec7B5aSvXcjbWS",
  "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
  "5Z3kSpejM1wP6bGGjm7zoKCrf2LZ6r8C8q78C4t13Ni4",
  "5Z3knbcDvzS6dNKo3u9v2p4tHkHiJJhbNzxH8ir9Ni4",
  "5Z3kXNbF3kjzigdQynoqemV3Tq6cHGuEs8hJKzzs3Ni4",
  "FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds",
  "9V6oHG6mpNPq1b7Sivz3NiW3Q5673Sya5gkayzj7EC3E",
  "F5kDvfgJVFeSu34yd51NsXcu7tui66mMZCz23nynern6",
  "6Zya3ofSrKewgdthY7844U8Gg3d5EgW7S9WnPyZBddnF",
  "2uKQ1GhvcBf87vHBjSNjVnFUY4h7ewpMwDJxTqQUuFKt",
  "F1eCZebsjuaLXkF1Kwzxaq53t1Bn7uge8x412CCqGx8P",
  "AoGRUnV1UGhHN3P8hMKZX1gsNn2Rc1Po41gFms6xCqus",
  "HsK7nknVVv6E9PEuovdQG1orUKvzZnWZfSpXkLpMCy9U",

  // Core System & Token Programs
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

export function isProtocolInfrastructure(address: string): boolean {
  return KNOWN_PROTOCOL_INFRASTRUCTURE.has(address);
}

/**
 * Baseline-poisoning defense: a swap-size reference built from fewer than this
 * many samples is too thin to be trusted for LARGE_SWAP (a wallet that makes
 * one or two trades then a big one would otherwise set its own "normal").
 */
export const MIN_BASELINE_SAMPLES = 3;

/**
 * COUNTERPARTY_CLUSTER soft-signal thresholds: at least this many counterparty
 * interactions in the batch, and the top counterparty accounting for at least
 * this % of them, flags concentrated/coordinated activity (wash trading).
 */
export const COUNTERPARTY_MIN_TXS = 4;
export const COUNTERPARTY_CLUSTER_PCT = 50;

/** Minimum baseline transaction count required before evaluating REGIME_SHIFT. */
export const REGIME_MIN_BASELINE_TXS = 5;

/** Minimum recent transaction count required to evaluate sustained REGIME_SHIFT. */
export const REGIME_MIN_RECENT_TXS = 3;

/** Factor threshold for sustained swap size shift in REGIME_SHIFT. */
export const REGIME_AMOUNT_FACTOR = 3;

/** Minimum ratio of recent transactions in an unseen venue/protocol for dominant shift. */
export const REGIME_DOMINANT_RATIO = 0.7;

/** Ratio threshold for inter-activity interval shift (acceleration or deceleration). */
export const REGIME_CADENCE_FACTOR = 4;

/**
 * Minimum number of historical inter-activity interval samples (i.e. this many
 * + 1 timestamps in the recent window) required before the cadence dimension
 * is evaluated on a new-style baseline. Below this, the history is too sparse
 * to define a "normal cadence", and comparing against the diluted lifetime
 * mean produced false REGIME_SHIFT alarms.
 */
export const REGIME_MIN_CADENCE_INTERVALS = 10;

/**
 * OFF_HOURS thresholds: the baseline hour profile must rest on at least this
 * many historical txs, the fresh batch must contain at least this many txs,
 * and at least this share of the batch must fall in UTC hours with ZERO
 * historical activity.
 */
export const OFF_HOURS_MIN_BASELINE_TXS = 20;
export const OFF_HOURS_MIN_BATCH_TXS = 3;
export const OFF_HOURS_MIN_RATIO = 0.5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Human formatting for a lifetime tx-per-minute rate (avoids long floats in digest text). */
function formatTps(tps: number | undefined | null): string {
  if (tps === null || tps === undefined || tps <= 0) return "unknown";
  return tps >= 1 ? tps.toFixed(1) : tps.toFixed(3);
}

function fmtUsd(n: number): string {
  return n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2);
}

function tokenUiAmount(item: {
  rawTokenAmount?: { tokenAmount?: string; decimals?: number };
}): number {
  const raw = item?.rawTokenAmount;
  if (!raw) return 0;
  const amount = Number(raw.tokenAmount ?? 0);
  const decimals = Number(raw.decimals ?? 0);
  return decimals > 0 ? amount / Math.pow(10, decimals) : amount;
}

export function extractSwap(
  tx: EnhancedTx,
  wallet?: string,
): SwapEvent | null {
  const swap = tx.swap ?? (tx as any).events?.swap;
  if (swap) {
    let inMint = "";
    let inAmount = 0;
    if (swap.tokenInputs && swap.tokenInputs.length > 0) {
      for (const leg of swap.tokenInputs) {
        if (!leg.mint) continue;
        if (!inMint) inMint = leg.mint;
        if (leg.mint === inMint) {
          inAmount += tokenUiAmount(leg);
        }
      }
    }
    if (swap.nativeInput && (!inMint || inMint === SOL_MINT)) {
      inMint = SOL_MINT;
      inAmount += (swap.nativeInput.amount ?? 0) / 1e9;
    }

    let outMint = "";
    let outAmount = 0;
    if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
      for (const leg of swap.tokenOutputs) {
        if (!leg.mint) continue;
        if (!outMint && leg.mint !== inMint) outMint = leg.mint;
        if (leg.mint === outMint) {
          outAmount += tokenUiAmount(leg);
        }
      }
    }
    if (swap.nativeOutput && (!outMint || outMint === SOL_MINT) && inMint !== SOL_MINT) {
      outMint = SOL_MINT;
      outAmount += (swap.nativeOutput.amount ?? 0) / 1e9;
    }

    if (inMint || outMint) {
      return {
        dex: tx.source ?? "unknown",
        signature: tx.signature,
        timestamp: tx.timestamp,
        tokenIn: {
          mint: inMint || (swap.nativeInput ? SOL_MINT : ""),
          amount: inAmount,
        },
        tokenOut: {
          mint: outMint || (swap.nativeOutput ? SOL_MINT : ""),
          amount: outAmount,
        },
      };
    }
  }
  // Fallback for the newer Helius response shape (no `swap` field):
  // reconstruct the legs from token/native transfers relative to the wallet
  // (or the fee payer when no wallet is supplied — relayer-sponsored txs may
  // have a feePayer that is not the user).
  if (tx.type !== "SWAP") return null;
  const me = wallet ?? tx.feePayer;
  if (!me) return null;
  let inMint = "";
  let inAmount = 0;
  let outMint = "";
  let outAmount = 0;
  for (const t of tx.tokenTransfers ?? []) {
    if (!t.mint) continue;
    if (t.fromUserAccount === me) {
      if (!inMint) {
        inMint = t.mint;
        inAmount = Number(t.tokenAmount ?? 0);
      } else if (t.mint === inMint) {
        inAmount += Number(t.tokenAmount ?? 0);
      }
    }
    if (t.toUserAccount === me) {
      if (!outMint && t.mint !== inMint) {
        outMint = t.mint;
        outAmount = Number(t.tokenAmount ?? 0);
      } else if (t.mint === outMint) {
        outAmount += Number(t.tokenAmount ?? 0);
      }
    }
  }
  for (const t of tx.nativeTransfers ?? []) {
    if (t.fromUserAccount === me) {
      if (!inMint) {
        inMint = SOL_MINT;
        inAmount = Number(t.amount ?? 0) / 1e9;
      } else if (inMint === SOL_MINT) {
        inAmount += Number(t.amount ?? 0) / 1e9;
      }
    }
    if (t.toUserAccount === me) {
      if (!outMint && SOL_MINT !== inMint) {
        outMint = SOL_MINT;
        outAmount = Number(t.amount ?? 0) / 1e9;
      } else if (outMint === SOL_MINT) {
        outAmount += Number(t.amount ?? 0) / 1e9;
      }
    }
  }
  if (!inMint && !outMint) return null;
  return {
    dex: tx.source ?? "unknown",
    signature: tx.signature,
    timestamp: tx.timestamp,
    tokenIn: { mint: inMint, amount: inAmount },
    tokenOut: { mint: outMint, amount: outAmount },
  };
}

/** Programs a tx touched: legacy `programs` field, else instruction programIds. */
export function txPrograms(tx: EnhancedTx): string[] {
  if (tx.programs) return tx.programs;
  const ids = new Set<string>();
  for (const i of tx.instructions ?? []) {
    if (i.programId) ids.add(i.programId);
  }
  return Array.from(ids);
}

/**
 * Counterparty user-accounts a tx interacted with. Prefers the explicit
 * `counterparties` field; otherwise derives the "other side" from the
 * token/native transfer lists relative to the wallet (or the fee payer when
 * no wallet is supplied; self is excluded).
 */
export function txCounterparties(tx: EnhancedTx, wallet?: string): string[] {
  const me = wallet ?? tx.feePayer;
  let raw: string[] = [];
  if (tx.counterparties && tx.counterparties.length > 0) {
    raw = me ? tx.counterparties.filter((cp) => cp !== me) : tx.counterparties;
  } else {
    // Gather any token accounts known to belong to `me` in this transaction so
    // rent-funding transfers to the wallet's own ATAs are not misclassified as counterparties.
    const myTokenAccounts = new Set<string>();
    if (me) {
      for (const t of tx.tokenTransfers ?? []) {
        if (t.fromUserAccount === me && t.fromTokenAccount) myTokenAccounts.add(t.fromTokenAccount);
        if (t.toUserAccount === me && t.toTokenAccount) myTokenAccounts.add(t.toTokenAccount);
      }
    }
    const from = (u?: string) =>
      u && u !== me && !myTokenAccounts.has(u) && !KNOWN_AMM_OWNERS.has(u)
        ? u
        : undefined;
    for (const t of tx.tokenTransfers ?? []) {
      if (wallet && t.fromUserAccount !== wallet && t.toUserAccount !== wallet) continue;
      const other = t.fromUserAccount === me ? t.toUserAccount : t.fromUserAccount;
      const o = from(other);
      if (o) raw.push(o);
    }
    for (const t of tx.nativeTransfers ?? []) {
      if (wallet && t.fromUserAccount !== wallet && t.toUserAccount !== wallet) continue;
      const other = t.fromUserAccount === me ? t.toUserAccount : t.fromUserAccount;
      const o = from(other);
      if (o) raw.push(o);
    }
  }
  return raw.filter((cp) => !isProtocolInfrastructure(cp) && !KNOWN_AMM_OWNERS.has(cp));
}

/**
 * 1-Hop Funding Source Check: inspects the earliest incoming native SOL transfer
 * to identify if the wallet was seeded from known malicious drainers or mixers.
 */
export function checkFundingSource(wallet: string, txs: EnhancedTx[]): Anomaly | null {
  if (txs.length === 0) return null;
  const sorted = [...txs].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (const tx of sorted) {
    for (const nt of tx.nativeTransfers ?? []) {
      if (
        nt.toUserAccount === wallet &&
        nt.fromUserAccount &&
        nt.fromUserAccount !== wallet &&
        (nt.amount ?? 0) > 0
      ) {
        if (KNOWN_EXPLOITERS.has(nt.fromUserAccount)) {
          return {
            type: "TAINTED_FUNDING",
            wallet,
            severity: "high",
            timestamp: tx.timestamp ?? 0,
            evidence: {
              funder: nt.fromUserAccount,
              amountSol: (nt.amount ?? 0) / 1e9,
              sig: tx.signature,
            },
            text: `Initial funding of ${((nt.amount ?? 0) / 1e9).toFixed(3)} SOL received from known malicious actor (${nt.fromUserAccount}).`,
          };
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Deterministic anomaly detection: compare a fresh batch of transactions
 * against the wallet's learned baseline. Pure function — no I/O, no LLM.
 */
export function detectAnomalies(
  wallet: string,
  txs: EnhancedTx[],
  baseline: Baseline | null,
  config: RadarConfig = loadConfig(),
  prices: UsdPriceMap | null = null,
  mintRisk: MintRiskMap | null = null,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const ts = (tx: EnhancedTx) => tx.timestamp ?? 0;
  const archetype = classifyWalletArchetype(wallet, txs, baseline, isProtocolInfrastructure);

  // 1-Hop Funding Source Check: flag wallets initialized with funds from known exploiters/drainers
  const fundingAnomaly = checkFundingSource(wallet, txs);
  if (fundingAnomaly) {
    anomalies.push(fundingAnomaly);
  }

  // DORMANT_ACTIVE: activity after N days of silence.
  // Judge the gap by the NEWEST tx only: the batch may legitimately contain
  // an already-seen tx (pagination overlap), which must not suppress the alert.
  // DAO treasuries / protocol vaults naturally have long dormancy between proposals.
  if (baseline?.lastSeenAt && txs.length > 0) {
    const newest = maxOf(txs.map(ts));
    const daysSince = (newest - baseline.lastSeenAt) / 86_400;
    const effectiveDormantDays = archetype === "protocol_vault" ? 90 : config.dormantDays;
    if (daysSince >= effectiveDormantDays) {
      anomalies.push({
        type: "DORMANT_ACTIVE",
        wallet,
        severity: daysSince >= 60 && archetype !== "protocol_vault" ? "high" : "medium",
        timestamp: newest,
        evidence: { daysSilent: Number(daysSince.toFixed(1)) },
        text: `Wallet reactivated after ~${Math.floor(daysSince)} days of inactivity.`,
      });
    }
  }

  // ACTIVITY_BURST: K+ tx within a short window.
  // NOTE: Helius timestamps are Unix SECONDS — the window must be in seconds too.
  if (txs.length > 0) {
    const newest = maxOf(txs.map(ts));
    const windowSec = config.burstWindowMin * 60;
    // Batch mode: txs contains the whole batch (watchOnce poll or test).
    // Streaming mode: txs is a single live/replay transaction, so check rapid-fire pace against rolling history.
    let inWindow = txs.filter((t) => newest - ts(t) <= windowSec).length;
    if (txs.length < config.burstThreshold && baseline?.recentTimestamps?.length) {
      const streamingWindowSec = 120; // 2 minutes rapid-fire burst window for streaming transactions
      const allTs = [...baseline.recentTimestamps, ...txs.map(ts)].filter((t) => t > 0);
      inWindow = allTs.filter((t) => newest - t <= streamingWindowSec && t <= newest).length;
    }

    // A burst indicates a sudden acceleration relative to normal behavior.
    // If the wallet has an established high-throughput baseline (>= 8 txs, medianTps > 2/min or medianIntervalSec <= 15s,
    // e.g. validator vote account, protocol infrastructure, or high-frequency DEX bot) and the current rate in the window
    // is consistent with or lower than its baseline rate, this is not an activity burst.
    // Consensus validator vote accounts operate at continuous high TPS without token swaps.
    // Guard against attackers inserting a dummy Vote instruction into token swaps/drainers to bypass burst detection.
    const hasSwapsInBatch = txs.some((t) => extractSwap(t, wallet) !== null);
    const voteTxCount = txs.filter(
      (t) => t.source === "VOTE_PROGRAM" || (txPrograms(t).length <= 2 && txPrograms(t).includes("Vote111111111111111111111111111111111111111")),
    ).length;
    const isValidator = !hasSwapsInBatch && txs.length >= 8 && (voteTxCount / txs.length >= 0.8);
    const streamingWindowSec = 120;
    const currentRateTps = inWindow / (txs.length < config.burstThreshold ? (streamingWindowSec / 60) : (config.burstWindowMin || 1));
    const isBelowBaselineRate = Boolean(
      archetype === "high_tps_infrastructure" ||
      isValidator ||
      isProtocolInfrastructure(wallet) ||
      (baseline &&
        baseline.txCount >= 8 &&
        ((baseline.medianTps > 2.0 && currentRateTps <= baseline.medianTps * 1.5) ||
         (baseline.medianIntervalSec != null && baseline.medianIntervalSec > 0 && baseline.medianIntervalSec <= 15))),
    );

    if (inWindow >= config.burstThreshold && !isBelowBaselineRate) {
      anomalies.push({
        type: "ACTIVITY_BURST",
        wallet,
        severity: inWindow >= config.burstThreshold * 2 ? "high" : "medium",
        timestamp: newest,
        evidence: {
          txInWindow: inWindow,
          windowMin: config.burstWindowMin,
          baselineTps: baseline?.medianTps ?? null,
        },
        text: `${inWindow} transactions in ${config.burstWindowMin} min (baseline ~${formatTps(baseline?.medianTps)}/min).`,
      });
    }
  }

  const swaps = txs
    .map((tx) => extractSwap(tx, wallet))
    .filter((s): s is SwapEvent => s !== null);

  // NEW_VENUE: first swap on a venue not seen in the baseline.
  // Deduplicate venues within the evaluation batch to prevent multi-swap false positives (Audit 2.1).
  const seenNewVenues = new Set<string>();
  for (const s of swaps) {
    if (
      baseline &&
      s.dex &&
      s.dex !== "unknown" &&
      !baseline.knownVenues.includes(s.dex) &&
      !seenNewVenues.has(s.dex)
    ) {
      seenNewVenues.add(s.dex);
      anomalies.push({
        type: "NEW_VENUE",
        wallet,
        severity: "medium",
        timestamp: s.timestamp,
        evidence: { venue: s.dex, sig: s.signature },
        text: `First swap on ${s.dex}.`,
      });
    }
  }

  // LARGE_SWAP: swap size > N x the wallet's median swap size.
  // The reference median is the RECENT-window median when one is available
  // (recency decay: a one-off historical outlier drops off instead of
  // permanently inflating "normal"). With a USD price map, sizes are compared
  // in USD across ALL mints; without prices, fall back to major-only raw
  // quantities. A sample floor guards against a poisoned thin baseline.
  if (baseline) {
    const usdRecent = baseline.recentSwapAmountsUsd;
    const usdMedian = usdRecent && usdRecent.length > 0 ? median(usdRecent) : baseline.medianSwapAmountUsd ?? 0;
    const rawRecent = baseline.recentSwapAmounts;
    const rawMedian = rawRecent && rawRecent.length > 0 ? median(rawRecent) : baseline.medianSwapAmount;
    const rawSamples = rawRecent && rawRecent.length > 0 ? rawRecent.length : baseline.txCount;
    const isWhaleOrVault = archetype === "whale_defi" || archetype === "protocol_vault";
    const effectiveMultiplier = isWhaleOrVault ? config.largeSwapMultiplier * 1.5 : config.largeSwapMultiplier;
    const effectiveUsdFloor = isWhaleOrVault ? 500.0 : MATERIAL_SWAP_FLOOR_USD;

    if (prices && usdMedian > 0) {
      for (const s of swaps) {
        const usd = swapUsdValue(s, prices);
        if (usd === null) continue;
        if (usd >= usdMedian * effectiveMultiplier && usd >= effectiveUsdFloor) {
          anomalies.push({
            type: "LARGE_SWAP",
            wallet,
            severity: "high",
            timestamp: s.timestamp,
            evidence: {
              usd: round2(usd),
              medianUsd: round2(usdMedian),
              mint: s.tokenIn.mint,
              sig: s.signature,
            },
            text: `Swap of ~$${fmtUsd(usd)} is ${effectiveMultiplier.toFixed(1)}x the wallet's median (~$${fmtUsd(usdMedian)}).`,
          });
        }
      }
    } else if (rawMedian > 0 && rawSamples >= MIN_BASELINE_SAMPLES) {
      for (const s of swaps) {
        if (!MAJOR_MINTS.includes(s.tokenIn.mint)) continue;
        const size = s.tokenIn.amount;
        const minFloor = s.tokenIn.mint === SOL_MINT ? MATERIAL_SWAP_FLOOR_SOL : MATERIAL_SWAP_FLOOR_MAJOR_STABLE;
        if (size >= rawMedian * effectiveMultiplier && size >= minFloor) {
          anomalies.push({
            type: "LARGE_SWAP",
            wallet,
            severity: "high",
            timestamp: s.timestamp,
            evidence: {
              size: Number(size.toFixed(4)),
              median: Number(rawMedian.toFixed(4)),
              sig: s.signature,
            },
            text: `Swap of ${size.toFixed(4)} is ${effectiveMultiplier.toFixed(1)}x the wallet's median (~${rawMedian.toFixed(4)}).`,
          });
        }
      }
    }
  }

  // CONCENTRATION: multiple swaps into the same token in a short window.
  const byToken = new Map<string, SwapEvent[]>();
  for (const s of swaps) {
    // Skip unparseable swaps (empty output mint) — otherwise several of them
    // bucket under "" and form a false CONCENTRATION group.
    if (!s.tokenOut.mint) continue;
    const list = byToken.get(s.tokenOut.mint) ?? [];
    list.push(s);
    byToken.set(s.tokenOut.mint, list);
  }
  for (const [mint, list] of byToken) {
    if (list.length < config.concentrationCount) continue;
    const newest = maxOf(list.map((s) => s.timestamp));
    // Timestamps are Unix SECONDS.
    const windowSec = config.concentrationWindowMin * 60;
    if (newest - minOf(list.map((s) => s.timestamp)) <= windowSec) {
      anomalies.push({
        type: "CONCENTRATION",
        wallet,
        severity: "medium",
        timestamp: newest,
        evidence: { token: mint, count: list.length },
        text: `${list.length} swaps into ${mint} within ${config.concentrationWindowMin} min.`,
      });
    }
  }

  // COUNTERPARTY_CLUSTER: soft signal — the wallet's counterparty interactions
  // are concentrated on a single address (wash-trading / coordinated-activity
  // indicator). Low severity: it adds context and a little risk but never
  // blocks on its own.
  {
    const freq = new Map<string, number>();
    let total = 0;
    for (const tx of txs) {
      for (const cp of txCounterparties(tx, wallet)) {
        freq.set(cp, (freq.get(cp) ?? 0) + 1);
        total += 1;
      }
    }
    if (archetype !== "high_tps_infrastructure" && total >= COUNTERPARTY_MIN_TXS) {
      let top = "";
      let topCount = 0;
      for (const [cp, c] of freq) {
        if (c > topCount) {
          topCount = c;
          top = cp;
        }
      }
      const pct = Math.round((topCount / total) * 100);
      if (pct >= COUNTERPARTY_CLUSTER_PCT) {
        anomalies.push({
          type: "COUNTERPARTY_CLUSTER",
          wallet,
          severity: "low",
          timestamp: maxOf(txs.map(ts)),
          evidence: { topCounterparty: top, topCount, total, pct, distinct: freq.size },
          text: `${pct}% of ${total} counterparty interactions go to one wallet (${top}). Possible coordinated activity.`,
        });
      }
    }
  }

  // NEW_PROTOCOL: first interaction with a program not in the baseline.
  if (baseline) {
    const seen = new Set(baseline.knownPrograms);
    const fresh = new Set<string>();
    for (const tx of txs) {
      for (const p of txPrograms(tx)) {
        if (!seen.has(p)) fresh.add(p);
      }
    }
    for (const p of fresh) {
      anomalies.push({
        type: "NEW_PROTOCOL",
        wallet,
        severity: "low",
        timestamp: maxOf(txs.map(ts)),
        evidence: { program: p },
        text: `First interaction with program ${p}.`,
      });
    }
  }

  // TOXIC_MINT: swaps involving tokens with unrenounced freeze/mint authorities, OR extreme
  // top-holder concentration (top-10 wallets control most of the supply = rug risk).
  // Verified bluechips and canonical ecosystem mints are exempt.
  if (mintRisk) {
    const flaggedMints = new Set<string>();
    for (const s of swaps) {
      const candidateMints = [s.tokenIn.mint, s.tokenOut.mint].filter(
        (m) => m && !MAJOR_MINTS.includes(m) && !KNOWN_SAFE_MINTS.has(m),
      );
      for (const m of candidateMints) {
        if (flaggedMints.has(m)) continue;
        const meta = mintRisk[m];
        if (!meta) continue; // Fetch failed or no metadata: skip rule for this mint
        const hasFreeze = Boolean(meta.freezeAuthority);
        const hasMint = Boolean(meta.mintAuthority);
        const top10 = typeof meta.top10Pct === "number" ? meta.top10Pct : null;
        const concentrated = top10 != null && top10 >= TOP10_CONCENTRATION_PCT;
        // Token-2022 extensions (B1). Fixed severities, not tuned to results:
        // permanentDelegate and a frozen defaultAccountState are `high`
        // (either lets the mint's authority move or freeze tokens out of any
        // holder's account at will); pausable and a transfer hook pointing
        // at a program other than this project's own hook are `medium`.
        const permanentDelegate = Boolean(meta.permanentDelegate);
        const defaultFrozen = Boolean(meta.defaultAccountStateFrozen);
        const pausable = Boolean(meta.pausable);
        const foreignTransferHook =
          typeof meta.transferHook === "string" && meta.transferHook !== DEFAULT_HOOK_PROGRAM_ID.toBase58();
        if (hasFreeze || hasMint || concentrated || permanentDelegate || defaultFrozen || pausable || foreignTransferHook) {
          flaggedMints.add(m);
          const veryConcentrated = top10 != null && top10 >= TOP10_HIGH_PCT;
          const isPump = Boolean(meta.isPumpFun || m.toLowerCase().endsWith("pump"));
          const severity: Severity =
            hasFreeze || veryConcentrated || (isPump && (hasMint || concentrated)) || permanentDelegate || defaultFrozen
              ? "high"
              : "medium";
          const reasons: string[] = [];
          if (hasFreeze) reasons.push(`freeze authority (${meta.freezeAuthority})`);
          if (hasMint) reasons.push(`mint authority (${meta.mintAuthority})`);
          if (concentrated) reasons.push(`top-10 holders control ${top10}% of supply`);
          if (isPump) reasons.push(`pump.fun token`);
          if (permanentDelegate) reasons.push(`permanent delegate extension`);
          if (defaultFrozen) reasons.push(`default account state: frozen`);
          if (pausable) reasons.push(`pausable extension`);
          if (foreignTransferHook) reasons.push(`transfer hook program (${meta.transferHook})`);
          anomalies.push({
            type: "TOXIC_MINT",
            wallet,
            severity,
            timestamp: s.timestamp,
            evidence: {
              mint: m,
              freezeAuthority: meta.freezeAuthority,
              mintAuthority: meta.mintAuthority,
              top10Pct: top10,
              isPumpFun: isPump,
              permanentDelegate,
              defaultAccountStateFrozen: defaultFrozen,
              pausable,
              transferHook: meta.transferHook ?? null,
              sig: s.signature,
            },
            text: `Token ${m}: ${reasons.join("; ")}.`,
          });
        }
      }
    }
  }

  // COUNTERPARTY MEMORY: cross-batch relationship signals (new counterparty,
  // dominant hub, relationship escalation). Emitted before the anti-evasion
  // meta-rules so they participate in REGIME_SHIFT's distinct-type count.
  // High-throughput infrastructure/MM bots deal with thousands of counterparties normally.
  if (archetype !== "high_tps_infrastructure") {
    anomalies.push(...detectCounterpartyAnomalies(wallet, txs, baseline?.counterparties ?? null));
  }

  // OFF_HOURS (9th rule): activity in UTC hours the wallet has never been
  // active in. Compares the fresh batch's hour distribution against the
  // baseline's 24-bucket UTC histogram; a majority of the batch landing in
  // historically-dead hours is a classic bot/takeover signature.
  if (
    baseline != null &&
    baseline.txCount >= OFF_HOURS_MIN_BASELINE_TXS &&
    txs.length >= OFF_HOURS_MIN_BATCH_TXS
  ) {
    const profile = baseline.activeHours.length === 24 ? baseline.activeHours : null;
    if (profile) {
      let offCount = 0;
      const offHours = new Set<number>();
      for (const t of txs) {
        if (typeof t.timestamp !== "number") continue;
        const h = new Date(t.timestamp * 1000).getUTCHours();
        if (profile[h] === 0) {
          offCount += 1;
          offHours.add(h);
        }
      }
      if (offCount >= 2 && offCount / txs.length >= OFF_HOURS_MIN_RATIO) {
        const hours = [...offHours].sort((a, b) => a - b);
        anomalies.push({
          type: "OFF_HOURS",
          wallet,
          severity: "medium",
          timestamp: maxOf(txs.map(ts)),
          evidence: { offHours: hours, offCount, batchTxCount: txs.length },
          text: `${offCount} of ${txs.length} recent txs at ${hours.map((h) => "UTC" + String(h).padStart(2, "0")).join(", ")} — hours with no historical activity in the baseline profile.`,
        });
      }
    }
  }

  // --- REGIME_SHIFT (8th rule): Behavioral Drift Detector ---
  // Fires when a wallet's recent behavior is a STRUCTURAL break from its own
  // established baseline (not a single spike) across one or more dimensions:
  // 1. Amount: sustained shift in typical swap size (recent median >= 3x baseline)
  // 2. Venue / Protocol diversity: new dominant venue/protocol or diversity collapse
  // 3. Cadence: sustained acceleration or deceleration of inter-activity intervals
  //
  // Guard: requires minimum baseline history (>= 5 txs) and minimum recent window (>= 3 txs)
  // so thin or newly initialized profiles never produce false positives.
  // Severity: medium (high if 2+ dimensions shift together, or multi-anomaly shift).
  const shiftReasons: string[] = [];
  const shiftedDimensions = new Set<string>();

  const hasBaselineHistory = baseline != null && baseline.txCount >= REGIME_MIN_BASELINE_TXS;
  const hasRecentWindow = txs.length >= REGIME_MIN_RECENT_TXS;

  if (hasBaselineHistory && hasRecentWindow) {
    // 1. AMOUNT DIMENSION: sustained shift in typical swap size
    const usdRecent = baseline.recentSwapAmountsUsd;
    const usdMedian = usdRecent && usdRecent.length > 0 ? median(usdRecent) : baseline.medianSwapAmountUsd ?? 0;
    const rawRecent = baseline.recentSwapAmounts;
    const rawMedian = rawRecent && rawRecent.length > 0 ? median(rawRecent) : baseline.medianSwapAmount;

    if (prices && usdMedian > 0) {
      const recentUsds = swaps
        .map((s) => swapUsdValue(s, prices))
        .filter((v): v is number => v !== null && v > 0);
      if (recentUsds.length >= 2) {
        const recentMedianUsd = median(recentUsds);
        if (recentMedianUsd >= usdMedian * REGIME_AMOUNT_FACTOR) {
          const factor = (recentMedianUsd / usdMedian).toFixed(1);
          shiftReasons.push(`amount (recent median ~$${fmtUsd(recentMedianUsd)} is ${factor}x baseline ~$${fmtUsd(usdMedian)})`);
          shiftedDimensions.add("amount");
        }
      }
    } else if (rawMedian > 0) {
      const recentMajors = swaps
        .filter((s) => MAJOR_MINTS.includes(s.tokenIn.mint))
        .map((s) => s.tokenIn.amount)
        .filter((a) => a > 0);
      if (recentMajors.length >= 2) {
        const recentMedian = median(recentMajors);
        if (recentMedian >= rawMedian * REGIME_AMOUNT_FACTOR) {
          const factor = (recentMedian / rawMedian).toFixed(1);
          shiftReasons.push(`amount (recent median ${recentMedian.toFixed(2)} is ${factor}x baseline ${rawMedian.toFixed(2)})`);
          shiftedDimensions.add("amount");
        }
      }
    }

    // 2. VENUE / PROTOCOL DIVERSITY DIMENSION
    const venueTxs = txs.filter((t) => t.source && t.source !== "unknown");
    if (venueTxs.length >= 3) {
      const venueCounts = new Map<string, number>();
      for (const t of venueTxs) {
        const v = t.source!;
        venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
      }
      let topVenue = "";
      let topVenueCount = 0;
      for (const [v, c] of venueCounts) {
        if (c > topVenueCount) {
          topVenue = v;
          topVenueCount = c;
        }
      }
      const ratio = topVenueCount / venueTxs.length;
      if (!baseline.knownVenues.includes(topVenue) && ratio >= REGIME_DOMINANT_RATIO) {
        const pct = Math.round(ratio * 100);
        shiftReasons.push(`venue (new dominant venue ${topVenue} accounts for ${pct}% of recent txs, not in baseline)`);
        shiftedDimensions.add("venue");
      } else if (baseline.knownVenues.length >= 3 && venueCounts.size === 1) {
        shiftReasons.push(`venue (diversity collapsed from ${baseline.knownVenues.length} baseline venues to single venue ${topVenue})`);
        shiftedDimensions.add("venue");
      }
    }

    // Protocol diversity
    if (txs.length >= 3) {
      const progCounts = new Map<string, number>();
      for (const t of txs) {
        for (const p of txPrograms(t)) {
          progCounts.set(p, (progCounts.get(p) ?? 0) + 1);
        }
      }
      for (const [prog, count] of progCounts) {
        if (!baseline.knownPrograms.includes(prog)) {
          const ratio = count / txs.length;
          if (ratio >= REGIME_DOMINANT_RATIO && count >= 3) {
            const pct = Math.round(ratio * 100);
            shiftReasons.push(`protocol (new dominant program ${prog} accounts for ${pct}% of recent txs, not in baseline)`);
            shiftedDimensions.add("protocol");
            break;
          }
        }
      }
    }

    // 3. CADENCE DIMENSION: inter-activity interval distribution shifted.
    // The baseline interval prefers the robust recent-window median interval
    // (`medianIntervalSec` — a true median of real inter-activity gaps, not a
    // lifetime mean diluted by dormant dead time). Legacy baselines without a
    // timestamp window fall back to the old lifetime-mean rate. New-style
    // baselines additionally need enough interval samples
    // (REGIME_MIN_CADENCE_INTERVALS): a sparse history has no meaningful
    // "normal cadence" to shift from, so comparing against it produced false
    // "accelerated 100000x" alarms (audit 3.4).
    const hasTsWindow = Array.isArray(baseline.recentTimestamps);
    const baselineIntervalSec = hasTsWindow
      ? baseline.medianIntervalSec ?? 0
      : baseline.medianTps > 0
        ? 60 / baseline.medianTps
        : 0;
    const cadenceUsable =
      baselineIntervalSec > 0 &&
      (!hasTsWindow || (baseline.recentTimestamps?.length ?? 0) >= REGIME_MIN_CADENCE_INTERVALS + 1);
    if (cadenceUsable && txs.length >= 3) {
      const sortedTs = txs.map(ts).filter((t) => t > 0).sort((a, b) => a - b);
      if (sortedTs.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < sortedTs.length; i++) {
          intervals.push(sortedTs[i] - sortedTs[i - 1]);
        }
        const recentIntervalSec = median(intervals);
        if (recentIntervalSec > 0 && baselineIntervalSec / recentIntervalSec >= REGIME_CADENCE_FACTOR) {
          const factor = (baselineIntervalSec / recentIntervalSec).toFixed(1);
          shiftReasons.push(`cadence (inter-activity interval accelerated to ${recentIntervalSec.toFixed(0)}s vs baseline ${baselineIntervalSec.toFixed(0)}s, ${factor}x faster)`);
          shiftedDimensions.add("cadence");
        } else if (baselineIntervalSec > 0 && recentIntervalSec / baselineIntervalSec >= REGIME_CADENCE_FACTOR) {
          const factor = (recentIntervalSec / baselineIntervalSec).toFixed(1);
          shiftReasons.push(`cadence (inter-activity interval decelerated to ${recentIntervalSec.toFixed(0)}s vs baseline ${baselineIntervalSec.toFixed(0)}s, ${factor}x slower)`);
          shiftedDimensions.add("cadence");
        }
      }
    }
  }

  // Multi-anomaly correlation (anti-evasion): 3+ distinct anomaly types firing in the batch.
  // Overlapping venue/protocol anomalies from the same event are grouped into a single dimension
  // so a single trade on a new DEX does not double-count and trigger a false-positive REGIME_SHIFT (Audit 5.1).
  // Counterparty signals (new counterparty, hub, cluster, escalation) are similarly grouped under
  // a single relationship dimension.
  const distinctCategories = new Set<string>();
  for (const a of anomalies) {
    if (a.type === "NEW_VENUE" || a.type === "NEW_PROTOCOL") {
      distinctCategories.add("NEW_VENUE_OR_PROTOCOL");
    } else if (
      a.type === "NEW_COUNTERPARTY" ||
      a.type === "COUNTERPARTY_HUB" ||
      a.type === "COUNTERPARTY_CLUSTER" ||
      a.type === "COUNTERPARTY_ESCALATION"
    ) {
      distinctCategories.add("COUNTERPARTY_RELATIONSHIP");
    } else {
      distinctCategories.add(a.type);
    }
  }
  const distinctTypes = new Set(anomalies.map((a) => a.type));
  const substantiveCount = anomalies.filter((a) =>
    ["LARGE_SWAP", "ACTIVITY_BURST", "TOXIC_MINT", "CONCENTRATION", "DORMANT_ACTIVE", "OFF_HOURS"].includes(a.type),
  ).length;
  const multiAnomalyShift = (distinctCategories.size >= 3 && substantiveCount >= 2) || distinctCategories.size >= 4;

  if (shiftedDimensions.size > 0 || multiAnomalyShift) {
    if (multiAnomalyShift && shiftReasons.length === 0) {
      const types = Array.from(distinctTypes).join(", ");
      shiftReasons.push(`multi-anomaly shift (${distinctTypes.size} distinct anomaly types: ${types})`);
      shiftedDimensions.add("multi_anomaly");
    }
    const reasons = [...shiftReasons];
    const dimensions = Array.from(shiftedDimensions);
    const severity: Severity = (shiftedDimensions.size >= 2 || multiAnomalyShift) ? "high" : "medium";
    const newestTs = txs.length > 0 ? maxOf(txs.map(ts)) : 0;
    anomalies.push({
      type: "REGIME_SHIFT",
      wallet,
      severity,
      timestamp: newestTs,
      evidence: {
        reasons,
        dimensions,
        triggeredRules: Array.from(distinctTypes),
        count: distinctTypes.size,
        shiftedDimensionsCount: shiftedDimensions.size,
        recentTxCount: txs.length,
        baselineTxCount: baseline?.txCount ?? 0,
      },
      text: `Regime shift: ${reasons.join("; ")}.`,
    });
  }

  // --- Anti-evasion: WARMING ---
  // Detects wallets that build a short "normal" baseline (few tx over a short
  // period) then suddenly deviate. The baseline is MANUFACTURED: a few small
  // trades to look established, then a large or unusual action.
  // Signal: baseline has very few tx (< 5) AND the current batch contains
  // at least one HIGH severity anomaly that is disproportionate to the
  // thin baseline.
  if (baseline && baseline.txCount > 0 && baseline.txCount < 5) {
    const hasHigh = anomalies.some((a) => a.severity === "high");
    if (hasHigh) {
      anomalies.push({
        type: "WARMING",
        wallet,
        severity: "medium",
        timestamp: maxOf(txs.map(ts)),
        evidence: { baselineTxCount: baseline.txCount, currentAnomalies: anomalies.filter((a) => a.severity === "high").length },
        text: `Baseline is thin (${baseline.txCount} tx) yet current activity triggers high-severity anomalies. Possible manufactured baseline ("warming").`,
      });
    }
  }

  return anomalies;
}

const SEVERITY_POINTS: Record<string, number> = {
  low: 5,
  medium: 15,
  high: 30,
};

/**
 * Aggregate anomaly list into a single 0-100 risk score for humans and agents.
 * Deterministic: high=30, medium=15, low=5 points per anomaly, capped at 100.
 */
export function computeRiskScore(anomalies: Anomaly[]): number {
  const total = anomalies.reduce((sum, a) => sum + (SEVERITY_POINTS[a.severity] ?? 0), 0);
  return Math.min(100, total);
}
