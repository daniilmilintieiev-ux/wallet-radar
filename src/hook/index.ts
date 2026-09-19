import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import {
  SCAN_RECORD_MAGIC,
  ScanLedgerRecord,
  deserializeScanRecord,
} from "../oracle/index.js";

/**
 * SPL Token-2022 Program ID.
 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/**
 * Default Radar Transfer Hook Program ID.
 */
export const DEFAULT_HOOK_PROGRAM_ID = new PublicKey(
  "Hook111111111111111111111111111111111111111",
);

/** PDA seed for ExtraAccountMetaList */
export const EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas", "utf-8");

/** PDA seed for RadarHookConfig */
export const RADAR_CONFIG_SEED = Buffer.from("radar_config", "utf-8");

/** PDA seed for on-chain Radar Record accounts */
export const RADAR_RECORD_SEED = Buffer.from("radar_record", "utf-8");

/**
 * spl-transfer-hook-interface:execute instruction discriminator (8 bytes)
 * sha256("spl-transfer-hook-interface:execute")[0..8]
 */
export const TRANSFER_HOOK_EXECUTE_DISCRIMINATOR = Buffer.from([
  0x69, 0x25, 0x65, 0xc5, 0x4b, 0xfb, 0x66, 0x1a,
]);

/**
  * Anchor program `initialize` instruction discriminator (8 bytes)
  * sha256("global:initialize")[0..8]
  */
 export const INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR = Buffer.from([
   0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed,
 ]);

/**
 * Radar Transfer Hook custom error codes matching the on-chain Rust program.
 */
export enum RadarHookErrorCode {
  RiskScoreTooHigh = 6000,
  CounterpartyFlagged = 6001,
  StaleOracleAttestation = 6002,
  UnverifiedCounterparty = 6003,
  InvalidScanRecordMagic = 6004,
  Unauthorized = 6005,
  InvalidTransferAmount = 6006,
  MissingOracleAccount = 6007,
}

export interface TransferHookConfig {
  authority: PublicKey;
  mint: PublicKey;
  /** Maximum allowed risk score (0..100). Default: 80 */
  maxRiskScore: number;
  /** Allow transfers to wallets with no on-chain scan record. Default: false (secure by default; set true for permissive mode) */
  allowUnverified: boolean;
  /** Maximum attestation age in seconds (0 = disabled). Default: 0 */
  maxAttestationAgeSec: number;
}

export interface TransferRiskEvaluation {
  allowed: boolean;
  reason?: string;
  errorCode?: RadarHookErrorCode;
  riskScore?: number;
  verdict?: string;
  attestationTimestamp?: number;
}

/**
 * Derives the ExtraAccountMetaList PDA for a given Token-22 mint.
 */
export function deriveExtraAccountMetaListPda(
  mint: PublicKey,
  programId: PublicKey = DEFAULT_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [EXTRA_ACCOUNT_METAS_SEED, mint.toBuffer()],
    programId,
  );
}

/**
 * Derives the RadarHookConfig PDA for a given Token-22 mint.
 */
export function deriveRadarConfigPda(
  mint: PublicKey,
  programId: PublicKey = DEFAULT_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [RADAR_CONFIG_SEED, mint.toBuffer()],
    programId,
  );
}

/**
 * Derives the Radar Oracle Record PDA for a given wallet address.
 */
export function deriveRadarRecordPda(
  wallet: PublicKey,
  oracleProgramId: PublicKey = DEFAULT_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [RADAR_RECORD_SEED, wallet.toBuffer()],
    oracleProgramId,
  );
}

/**
 * Builds an InitializeExtraAccountMetaList instruction for the transfer hook.
 */
export function buildInitializeExtraAccountMetaListInstruction(params: {
  mint: PublicKey;
  authority: PublicKey;
  maxRiskScore?: number;
  allowUnverified?: boolean;
  maxAttestationAgeSec?: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [extraAccountMetas] = deriveExtraAccountMetaListPda(params.mint, programId);
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const maxRisk = Math.max(0, Math.min(100, params.maxRiskScore ?? 80));
  const allowUnverified = params.allowUnverified ?? false;
  const maxAge = BigInt(Math.max(0, params.maxAttestationAgeSec ?? 0));

  // Instruction data: 8 bytes discriminator + 1 byte maxRisk + 1 byte allowUnverified + 8 bytes maxAge
  const data = Buffer.alloc(18);
  INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(maxRisk, 8);
  data.writeUInt8(allowUnverified ? 1 : 0, 9);
  data.writeBigUInt64LE(maxAge, 10);

  const keys: AccountMeta[] = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false }, // System program
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * Builds an Execute instruction for the transfer hook program.
 */
export function buildTransferHookExecuteInstruction(params: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint | number;
  oracleRecord?: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [extraAccountMetas] = deriveExtraAccountMetaListPda(params.mint, programId);
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const data = Buffer.alloc(16);
  TRANSFER_HOOK_EXECUTE_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(params.amount), 8);

  const keys: AccountMeta[] = [
    { pubkey: params.source, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.destination, isSigner: false, isWritable: false },
    { pubkey: params.owner, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetas, isSigner: false, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: false },
  ];

  if (params.oracleRecord) {
    keys.push({ pubkey: params.oracleRecord, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * Builds an SPL Token-2022 TransferChecked instruction with transfer hook extra accounts.
 */
export function createRiskGatedTransferCheckedInstruction(params: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint | number;
  decimals: number;
  destinationWallet?: PublicKey;
  hookProgramId?: PublicKey;
}): TransactionInstruction {
  const hookProgramId = params.hookProgramId || DEFAULT_HOOK_PROGRAM_ID;
  const [extraAccountMetas] = deriveExtraAccountMetaListPda(params.mint, hookProgramId);
  const [configPda] = deriveRadarConfigPda(params.mint, hookProgramId);

  // Token-22 TransferChecked layout:
  // [0]: Instruction index (12 = TransferChecked)
  // [1..8]: Amount (u64 LE)
  // [9]: Decimals (u8)
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(params.amount), 1);
  data.writeUInt8(params.decimals, 9);

  const keys: AccountMeta[] = [
    { pubkey: params.source, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.destination, isSigner: false, isWritable: true },
    { pubkey: params.owner, isSigner: true, isWritable: false },
    // Transfer hook program + extra accounts
    { pubkey: extraAccountMetas, isSigner: false, isWritable: false },
    { pubkey: hookProgramId, isSigner: false, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: false },
  ];

  if (params.destinationWallet) {
    const [oracleRecord] = deriveRadarRecordPda(params.destinationWallet, hookProgramId);
    keys.push({ pubkey: oracleRecord, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Evaluates transfer risk matching the on-chain Rust hook logic.
 */
export function evaluateTransferRisk(
  recordInput: ScanLedgerRecord | Buffer | Uint8Array | null | undefined,
  config?: Partial<TransferHookConfig>,
  nowSec: number = Math.floor(Date.now() / 1000),
): TransferRiskEvaluation {
  const maxRisk = config?.maxRiskScore ?? 80;
  const allowUnverified = config?.allowUnverified ?? false;
  const maxAge = config?.maxAttestationAgeSec ?? 0;

  // 1. Missing or unverified record
  if (!recordInput) {
    if (allowUnverified) {
      return {
        allowed: true,
        reason: "No on-chain scan attestation; allowed by unverified policy",
      };
    }
    return {
      allowed: false,
      reason: "Destination wallet has no verified on-chain scan record",
      errorCode: RadarHookErrorCode.UnverifiedCounterparty,
    };
  }

  let record: ScanLedgerRecord;
  if (Buffer.isBuffer(recordInput) || recordInput instanceof Uint8Array) {
    const buf = Buffer.isBuffer(recordInput) ? recordInput : Buffer.from(recordInput);
    if (buf.length < 48 || !buf.subarray(0, 4).equals(SCAN_RECORD_MAGIC)) {
      return {
        allowed: false,
        reason: "Invalid oracle record header magic",
        errorCode: RadarHookErrorCode.InvalidScanRecordMagic,
      };
    }
    record = deserializeScanRecord(buf);
  } else {
    record = recordInput;
  }

  const score = record.riskScore;
  const verdict = record.verdict.toUpperCase();
  const timestamp = record.timestamp;

  // 2. Score threshold check
  if (score > maxRisk) {
    return {
      allowed: false,
      reason: `Destination wallet risk score ${score} exceeds maximum allowed ${maxRisk}`,
      errorCode: RadarHookErrorCode.RiskScoreTooHigh,
      riskScore: score,
      verdict,
      attestationTimestamp: timestamp,
    };
  }

  // 3. Flagged verdict check
  if (verdict.includes("HIGH RISK") || verdict === "HIGH") {
    return {
      allowed: false,
      reason: "Destination wallet is flagged with HIGH RISK verdict on-chain",
      errorCode: RadarHookErrorCode.CounterpartyFlagged,
      riskScore: score,
      verdict,
      attestationTimestamp: timestamp,
    };
  }

  // 4. Freshness check
  if (maxAge > 0 && timestamp > 0) {
    const age = nowSec - timestamp;
    if (age > maxAge) {
      return {
        allowed: false,
        reason: `Destination wallet oracle attestation is stale (age ${age}s > ${maxAge}s)`,
        errorCode: RadarHookErrorCode.StaleOracleAttestation,
        riskScore: score,
        verdict,
        attestationTimestamp: timestamp,
      };
    }
  }

  return {
    allowed: true,
    riskScore: score,
    verdict,
    attestationTimestamp: timestamp,
  };
}
