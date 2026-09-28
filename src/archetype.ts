import { EnhancedTx, Baseline, SOL_MINT } from "./types.js";

/**
 * Wallet archetypes for adaptive anomaly detection and false-positive reduction.
 */
export type WalletArchetype =
  | "clean_retail"
  | "high_tps_infrastructure"
  | "protocol_vault"
  | "whale_defi"
  | "scam_drainer";

/**
 * Known DAO multisig and smart wallet programs (Squads v3/v4, etc.)
 */
export const MULTISIG_PROGRAM_IDS = new Set<string>([
  "SMPLecH534NA9acpos4G6x7uf3LWbHzwGFgn43Ca7Yz", // Squads v3
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pcf", // Squads v4
  "msigmtwzgXhgGaYuACRYmHmNi5gyTmPJJPGYPPr2My6", // Legacy Multisig
]);

/**
 * Known Liquid Staking and DeFi Pool Programs
 */
export const STAKING_POOL_PROGRAMS = new Set<string>([
  "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChZeLURfutqE", // Marinade Finance
  "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuBp", // SPL Stake Pool
  "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P81AFKqRx", // Jito Staking
]);

export const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";

/**
 * Classify a wallet into a behavioral archetype based on its address, transaction
 * history, and baseline metrics. Pure, deterministic, zero I/O.
 */
export function classifyWalletArchetype(
  wallet: string,
  txs: EnhancedTx[],
  baseline?: Baseline | null,
  isInfraFn?: (addr: string) => boolean,
): WalletArchetype {
  // 1. Direct protocol infrastructure match (known DEX routers, AMM vaults, system programs)
  if (isInfraFn && isInfraFn(wallet)) {
    return "high_tps_infrastructure";
  }

  // 2. High-frequency consensus validator or automated vote account
  const voteTxCount = txs.filter(
    (t) =>
      t.source === "VOTE_PROGRAM" ||
      (t.instructions?.some((ix) => ix.programId === VOTE_PROGRAM_ID) ?? false),
  ).length;

  if (txs.length >= 5 && voteTxCount / txs.length >= 0.7) {
    return "high_tps_infrastructure";
  }

  // 3. Automated high-TPS infrastructure or Market Maker bot
  // Sustained high cadence (> 2 TPS or median interval <= 15s) with high transaction volume
  if (
    baseline &&
    baseline.txCount >= 8 &&
    ((baseline.medianTps > 2.0 && (baseline.medianIntervalSec == null || baseline.medianIntervalSec <= 30)) ||
      (baseline.medianIntervalSec != null && baseline.medianIntervalSec > 0 && baseline.medianIntervalSec <= 15))
  ) {
    return "high_tps_infrastructure";
  }

  // 4. Multisig / DAO Treasury / Institutional Vault
  const interactsWithMultisig = txs.some((t) =>
    t.instructions?.some((ix) => ix.programId && MULTISIG_PROGRAM_IDS.has(ix.programId)),
  );
  if (interactsWithMultisig) {
    return "protocol_vault";
  }

  // 5. Whale DeFi / High Net Worth Liquidity Provider
  // Median swap size >= $10,000 USD or frequent staking pool transactions
  const hasStakingInteraction = txs.some((t) =>
    t.instructions?.some((ix) => ix.programId && STAKING_POOL_PROGRAMS.has(ix.programId)),
  );
  const isLargeSwapMedian =
    (baseline?.medianSwapAmountUsd ?? 0) >= 10_000 ||
    (baseline?.medianSwapAmount ?? 0) >= 100; // >= 100 SOL / major units

  if (hasStakingInteraction || isLargeSwapMedian) {
    return "whale_defi";
  }

  return "clean_retail";
}
