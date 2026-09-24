import { readFileSync } from "node:fs";
import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  Transaction,
  Keypair,
  Connection,
} from "@solana/web3.js";
import {
  SCAN_RECORD_MAGIC,
  ScanLedgerRecord,
  deserializeScanRecord,
  VERDICT_CODE_MAP,
} from "../oracle/index.js";

/**
 * SPL Token-2022 Program ID.
 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/**
 * Default Radar Transfer Hook Program ID.
 *
 * The identity of the deployed radar-transfer-hook program (declare_id! in
 * programs/radar-transfer-hook/src/lib.rs; the program keypair is the same
 * across clusters). This is NOT the SPL dispatcher `Hook111...` — the
 * dispatcher is invoked internally by the Token-2022 program, while clients
 * target the hook implementation directly, and all hook PDAs (config,
 * meta-list, records) are derived under THIS program ID. Verified against
 * devnet: the on-chain record PDA `3FDmzLG6...` for cp wallet
 * `4UAH3q1p...` only reproduces with this program ID.
 */
export const DEFAULT_HOOK_PROGRAM_ID = new PublicKey(
  "wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV",
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
 * spl-transfer-hook-interface:initialize-extra-account-metas discriminator (8 bytes)
 * sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[0..8]
 */
export const INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR = Buffer.from([
  0x2b, 0x22, 0x0d, 0x31, 0xa7, 0x58, 0xeb, 0xeb,
]);

/**
 * spl-transfer-hook-interface:update-extra-account-metas discriminator (8 bytes)
 * sha256("spl-transfer-hook-interface:update-extra-account-metas")[0..8]
 */
export const UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR = Buffer.from([
  0x9d, 0x69, 0x2a, 0x92, 0x66, 0x55, 0xf1, 0xae,
]);

/**
 * Anchor program `initialize` (config) instruction discriminator (8 bytes).
 * Plain Anchor instruction (no `#[interface]`), so the sighash preimage is
 * "global:initialize" (no program name): sha256("global:initialize")[0..8]
 */
export const RADAR_INITIALIZE_DISCRIMINATOR = Buffer.from([
  0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed,
]);

/**
 * Anchor program `write_scan_record` instruction discriminator (8 bytes).
 * Plain Anchor instruction (no `#[interface]`), so the sighash preimage is
 * "global:write_scan_record" (no program name): sha256("global:write_scan_record")[0..8]
 */
export const WRITE_SCAN_RECORD_DISCRIMINATOR = Buffer.from([
  0x94, 0x99, 0xba, 0x91, 0x9b, 0xd6, 0x14, 0xdf,
]);

/**
 * Anchor program `update_config` instruction discriminator (8 bytes):
 * sha256("global:update_config")[0..8]
 */
export const RADAR_UPDATE_CONFIG_DISCRIMINATOR = Buffer.from([
  0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63,
]);

/**
 * Anchor program `set_authority` instruction discriminator (8 bytes):
 * sha256("global:set_authority")[0..8]
 */
export const RADAR_SET_AUTHORITY_DISCRIMINATOR = Buffer.from([
  0x85, 0xfa, 0x25, 0x15, 0x6e, 0xa3, 0x1a, 0x79,
]);

/**
 * Anchor program `close_scan_record` instruction discriminator (8 bytes):
 * sha256("global:close_scan_record")[0..8]
 */
export const RADAR_CLOSE_RECORD_DISCRIMINATOR = Buffer.from([
  0xfd, 0xee, 0x66, 0x33, 0x5f, 0x42, 0x5b, 0xcc,
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
  InvalidExtraMeta = 6008,
  RecordPdaMismatch = 6009,
  InvalidDestination = 6010,
  InvalidAccountOwner = 6011,
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
 * Derives the Radar Oracle Record PDA for a given wallet address and mint.
 * Scoped to both mint and wallet to prevent cross-mint PDA spoofing (Audit 1.1-NEW).
 */
export function deriveRadarRecordPda(
  wallet: PublicKey,
  mint: PublicKey,
  oracleProgramId: PublicKey = DEFAULT_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [RADAR_RECORD_SEED, mint.toBuffer(), wallet.toBuffer()],
    oracleProgramId,
  );
}

const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/**
 * A single seed descriptor for a seed-based `ExtraAccountMeta` entry
 * (spl-tlv-account-resolution `Seed` TLV wire format).
 *
 * The seed is resolved by the Token-22 program against the hook CPI account
 * list: [0] source, [1] mint, [2] destination, [3] authority,
 * [4] validate_state, [5..] extra metas.
 */
export type HookSeedSpec =
  | { type: "literal"; value: Buffer | string }
  | { type: "instructionData"; index: number; length: number }
  | { type: "accountKey"; index: number }
  | { type: "accountData"; accountIndex: number; dataIndex: number; length: number };

/**
 * Packs a single seed descriptor into its TLV wire bytes.
 * Discriminators: 1=literal, 2=instructionData, 3=accountKey, 4=accountData.
 */
export function packHookSeed(seed: HookSeedSpec): Buffer {
  switch (seed.type) {
    case "literal": {
      const value =
        typeof seed.value === "string" ? Buffer.from(seed.value, "utf-8") : seed.value;
      if (value.length > 30) {
        throw new Error(`literal seed too long (${value.length} > 30 bytes)`);
      }
      const out = Buffer.alloc(2 + value.length);
      out.writeUInt8(1, 0);
      out.writeUInt8(value.length, 1);
      value.copy(out, 2);
      return out;
    }
    case "instructionData": {
      const out = Buffer.alloc(3);
      out.writeUInt8(2, 0);
      out.writeUInt8(seed.index, 1);
      out.writeUInt8(seed.length, 2);
      return out;
    }
    case "accountKey": {
      const out = Buffer.alloc(2);
      out.writeUInt8(3, 0);
      out.writeUInt8(seed.index, 1);
      return out;
    }
    case "accountData": {
      const out = Buffer.alloc(4);
      out.writeUInt8(4, 0);
      out.writeUInt8(seed.accountIndex, 1);
      out.writeUInt8(seed.dataIndex, 2);
      out.writeUInt8(seed.length, 3);
      return out;
    }
  }
}

/**
 * An `ExtraAccountMeta` entry for the ExtraAccountMetaList (35 bytes on the
 * wire): either a static account or a seed-resolved PDA.
 */
export type HookMetaSpec =
  | { kind: "pubkey"; pubkey: PublicKey; isSigner?: boolean; isWritable?: boolean }
  | { kind: "seeds"; seeds: HookSeedSpec[]; isSigner?: boolean; isWritable?: boolean };

/**
 * Serializes a single `ExtraAccountMeta` entry (35 bytes):
 * discriminator(1) + address_config(32) + is_signer(1) + is_writable(1).
 *
 * discriminator 0 = static account (address_config = 32-byte pubkey);
 * discriminator 1 = seed-based PDA (address_config = packed seed TLV).
 */
export function serializeExtraAccountMeta(meta: HookMetaSpec): Buffer {
  const buf = Buffer.alloc(35);
  if (meta.kind === "pubkey") {
    buf.writeUInt8(0, 0); // discriminator: 0 = static AccountMeta (pubkey)
    meta.pubkey.toBuffer().copy(buf, 1);
  } else {
    const packed = Buffer.concat(meta.seeds.map(packHookSeed));
    if (packed.length > 32) {
      throw new Error(`seeds do not fit into 32-byte address_config (${packed.length} bytes)`);
    }
    buf.writeUInt8(1, 0); // discriminator: 1 = seed-based PDA
    packed.copy(buf, 1);
  }
  buf.writeUInt8(meta.isSigner ? 1 : 0, 33);
  buf.writeUInt8(meta.isWritable ? 1 : 0, 34);
  return buf;
}

/**
 * Seed configuration for the dynamic scan-record entry in the
 * ExtraAccountMetaList: `Literal("radar_record")` +
 * `AccountData{accountIndex: 2 (destination token account), dataIndex: 32,
 * length: 32}` — the owner field of the destination token account — so the
 * hook resolves PDA(["radar_record", destination_owner]) on every transfer.
 *
 * The mint is therefore NOT locked to a single destination wallet.
 */
export function buildRecordPdaMetaSeeds(): HookSeedSpec[] {
  return [
    { type: "literal", value: "radar_record" },
    { type: "accountKey", index: 1 }, // mint is account 1 in execute CPI
    { type: "accountData", accountIndex: 2, dataIndex: 32, length: 32 }, // destination owner
  ];
}

/**
 * Seed configuration for the source scan-record entry in ExtraAccountMetaList (Audit 1.1).
 * Account 0 in execute CPI is the source token account; bytes 32..64 is its owner.
 * Resolves PDA(["radar_record", mint, source_owner]) on every transfer.
 */
export function buildSourceRecordPdaMetaSeeds(): HookSeedSpec[] {
  return [
    { type: "literal", value: "radar_record" },
    { type: "accountKey", index: 1 }, // mint is account 1 in execute CPI
    { type: "accountData", accountIndex: 0, dataIndex: 32, length: 32 }, // source owner
  ];
}

/**
 * Builds the anchor `initialize` (config) instruction: creates the
 * RadarHookConfig PDA for a mint.
 *
 * Keys: [0] config PDA (w), [1] mint (r), [2] authority (s, w), [3] system (r)
 */
export function buildInitializeInstruction(params: {
  mint: PublicKey;
  authority: PublicKey;
  maxRiskScore?: number;
  allowUnverified?: boolean;
  maxAttestationAgeSec?: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const maxRisk = Math.max(0, Math.min(100, params.maxRiskScore ?? 80));
  const allowUnverified = params.allowUnverified ?? false;
  const maxAge = BigInt(Math.max(0, params.maxAttestationAgeSec ?? 0));

  // Data: 8 disc + 1 maxRisk + 1 allowUnverified + 8 maxAge
  const data = Buffer.alloc(18);
  RADAR_INITIALIZE_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(maxRisk, 8);
  data.writeUInt8(allowUnverified ? 1 : 0, 9);
  data.writeBigUInt64LE(maxAge, 10);

  const keys: AccountMeta[] = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Builds the transfer-hook `initialize_extra_account_meta_list` instruction:
 * creates the ExtraAccountMetaList PDA registering the additional accounts the
 * hook receives on every transfer.
 *
 * Data: 8 disc + u32 count (LE) + count * 35-byte ExtraAccountMeta entries.
 * Keys: [0] meta-list PDA (w), [1] mint (r), [2] authority (s, w), [3] system (r)
 */
export function buildInitializeExtraAccountMetaListInstruction(params: {
  mint: PublicKey;
  authority: PublicKey;
  metas: HookMetaSpec[];
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [extraAccountMetas] = deriveExtraAccountMetaListPda(params.mint, programId);

  const count = params.metas.length;
  const data = Buffer.alloc(8 + 4 + count * 35);
  INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(count, 8);
  params.metas.forEach((meta, i) => {
    serializeExtraAccountMeta(meta).copy(data, 12 + i * 35);
  });

  const keys: AccountMeta[] = [
    { pubkey: extraAccountMetas, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Builds the transfer-hook `update_extra_account_meta_list` instruction (Audit Revision 11 WR-HIGH-02):
 * updates an existing ExtraAccountMetaList PDA registering the additional accounts the
 * hook receives on every transfer.
 *
 * Data: 8 disc + u32 count (LE) + count * 35-byte ExtraAccountMeta entries.
 * Keys: [0] meta-list PDA (w), [1] mint (r), [2] authority (s, w), [3] system (r)
 */
export function buildUpdateExtraAccountMetaListInstruction(params: {
  mint: PublicKey;
  authority: PublicKey;
  metas: HookMetaSpec[];
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [extraAccountMetas] = deriveExtraAccountMetaListPda(params.mint, programId);

  const count = params.metas.length;
  const data = Buffer.alloc(8 + 4 + count * 35);
  UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(count, 8);
  params.metas.forEach((meta, i) => {
    serializeExtraAccountMeta(meta).copy(data, 12 + i * 35);
  });

  const keys: AccountMeta[] = [
    { pubkey: extraAccountMetas, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Builds the anchor `write_scan_record` instruction: writes a 48-byte scan
 * record header for a wallet (the PDA is derived from the wallet).
 *
 * Data: 8 disc + 1 riskScore + 1 verdictCode + 8 timestamp + 2 payloadLen.
 * Keys: [0] wallet (r), [1] record PDA (w), [2] config PDA (r),
 *       [3] mint (r), [4] authority (s, w), [5] system (r).
 *
 * The program enforces `authority == config.authority` — only the mint's
 * configured authority can write scan records.
 */
export function buildWriteScanRecordInstruction(params: {
  wallet: PublicKey;
  mint: PublicKey;
  riskScore: number;
  verdictCode: number;
  timestamp: bigint | number;
  payloadLen?: number;
  authority: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [recordPda] = deriveRadarRecordPda(params.wallet, params.mint, programId);
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const data = Buffer.alloc(8 + 1 + 1 + 8 + 2);
  WRITE_SCAN_RECORD_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(Math.max(0, Math.min(255, params.riskScore)), 8);
  data.writeUInt8(params.verdictCode & 0xff, 9);
  data.writeBigUInt64LE(BigInt(params.timestamp), 10);
  data.writeUInt16LE(params.payloadLen ?? 0, 18);

  const keys: AccountMeta[] = [
    { pubkey: params.wallet, isSigner: false, isWritable: false },
    { pubkey: recordPda, isSigner: false, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Audit 2.3: builds an oracle→hook bridge from the environment. Reads
 * RADAR_HOOK_MINT (Token-22 mint with the radar hook configured) and
 * RADAR_HOOK_KEYPAIR (path to the mint's hook-authority keypair, 64-byte JSON
 * array). Returns `null` when either is missing/unreadable, so callers can
 * enable the bridge purely via env without code changes.
 */
export function buildEnvHookBridge():
  | ((record: { wallet: string; riskScore: number; verdict: string; timestamp: number }) => Promise<Record<string, unknown>>)
  | null {
  const hookMint = process.env.RADAR_HOOK_MINT?.trim();
  const hookKeypairPath = process.env.RADAR_HOOK_KEYPAIR?.trim();
  if (!hookMint || !hookKeypairPath) return null;
  const raw: unknown = JSON.parse(readFileSync(hookKeypairPath, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) return null;
  const authority = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
  return async (record) => {
    const res = await publishScanRecordToHook({
      wallet: record.wallet,
      mint: hookMint,
      riskScore: record.riskScore,
      verdict: record.verdict,
      timestamp: record.timestamp,
      authority,
      rpcUrl: process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL,
    });
    return { success: true, signature: res.signature, recordPda: res.recordPda.toBase58() };
  };
}

/**
 * Audit 2.3: end-to-end oracle→hook bridge. Publishes a scan result to the
 * destination wallet's on-chain scan-record PDA via the hook program's
 * `write_scan_record` instruction, so the transfer hook gates the wallet on
 * the LATEST scan verdict (closing the oracle↔hook architecture split).
 *
 * The transaction is signed by the mint's configured hook authority and
 * confirmed before the signature is returned (audit 2.6 semantics).
 */
export async function publishScanRecordToHook(params: {
  /** Counterparty wallet the scan result applies to */
  wallet: string | PublicKey;
  /** Token-22 mint with the radar hook configured */
  mint: string | PublicKey;
  /** Scan risk score 0-100 */
  riskScore: number;
  /** Scan verdict ("SAFE" | "LOW RISK" | "SUSPICIOUS" | "HIGH RISK" | custom) */
  verdict: string;
  /** Evaluation timestamp (unix seconds) */
  timestamp: number;
  /** Byte length of the evaluated payload (informational; the record account stores the 48-byte header) */
  payloadLen?: number;
  /** The mint's configured hook authority (signer + fee payer) */
  authority: Keypair;
  programId?: PublicKey;
  /** Injectable connection (defaults to `new Connection(rpcUrl, "confirmed")`) */
  connection?: Connection;
  rpcUrl?: string;
}): Promise<{ signature: string; recordPda: PublicKey }> {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const wallet =
    typeof params.wallet === "string" ? new PublicKey(params.wallet) : params.wallet;
  const mint = typeof params.mint === "string" ? new PublicKey(params.mint) : params.mint;
  const [recordPda] = deriveRadarRecordPda(wallet, mint, programId);

  const ix = buildWriteScanRecordInstruction({
    wallet,
    mint,
    riskScore: params.riskScore,
    verdictCode: VERDICT_CODE_MAP[params.verdict] ?? 2,
    timestamp: params.timestamp,
    payloadLen: params.payloadLen,
    authority: params.authority.publicKey,
    programId,
  });

  const conn =
    params.connection ??
    new Connection(
      params.rpcUrl ||
        process.env.SOLANA_RPC_URL ||
        process.env.HELIUS_RPC_URL ||
        "https://api.mainnet-beta.solana.com",
      "confirmed",
    );

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(ix);
  tx.feePayer = params.authority.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(params.authority);
  const sig = await conn.sendRawTransaction(tx.serialize());
  // Audit 2.6: wait for confirmation before reporting the record as published.
  if (typeof conn.confirmTransaction === "function") {
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  }
  return { signature: sig, recordPda };
}

/**
 * Builds the anchor `close_scan_record` instruction: closes a wallet's scan-record PDA
 * and refunds rent lamports back to the mint's authority (Audit 3.5).
 *
 * Keys: [0] wallet (r), [1] record PDA (w), [2] config PDA (r), [3] mint (r), [4] authority (s, w).
 */
export function buildCloseScanRecordInstruction(params: {
  mint: PublicKey;
  wallet: PublicKey;
  authority: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [recordPda] = deriveRadarRecordPda(params.wallet, params.mint, programId);
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const keys: AccountMeta[] = [
    { pubkey: params.wallet, isSigner: false, isWritable: false },
    { pubkey: recordPda, isSigner: false, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.authority, isSigner: true, isWritable: true },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(RADAR_CLOSE_RECORD_DISCRIMINATOR),
  });
}

/**
 * Builds the anchor `update_config` instruction: updates the risk-gating
 * parameters for a mint.
 *
 * Data: 8 disc + 1 newMaxRiskScore + 1 allowUnverified + 8 maxAttestationAgeSec.
 * Keys: [0] config PDA (w), [1] authority (s, w).
 */
export function buildUpdateConfigInstruction(params: {
  mint: PublicKey;
  authority: PublicKey;
  newMaxRiskScore: number;
  allowUnverified: boolean;
  maxAttestationAgeSec?: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const data = Buffer.alloc(8 + 1 + 1 + 8);
  RADAR_UPDATE_CONFIG_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(Math.max(0, Math.min(100, params.newMaxRiskScore)), 8);
  data.writeUInt8(params.allowUnverified ? 1 : 0, 9);
  data.writeBigUInt64LE(BigInt(Math.max(0, params.maxAttestationAgeSec ?? 0)), 10);

  const keys: AccountMeta[] = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: params.authority, isSigner: true, isWritable: true },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Builds the anchor `set_authority` instruction: updates the authority
 * governing the RadarHookConfig PDA for a mint (Audit 1.4).
 *
 * Keys: [0] config PDA (w), [1] current authority (s)
 * Data: 8 disc + 32-byte newAuthority pubkey
 */
export function buildSetAuthorityInstruction(params: {
  mint: PublicKey;
  currentAuthority: PublicKey;
  newAuthority: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const data = Buffer.alloc(8 + 32);
  RADAR_SET_AUTHORITY_DISCRIMINATOR.copy(data, 0);
  params.newAuthority.toBuffer().copy(data, 8);

  const keys: AccountMeta[] = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: params.currentAuthority, isSigner: true, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
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
  record: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId || DEFAULT_HOOK_PROGRAM_ID;
  const [extraAccountMetas] = deriveExtraAccountMetaListPda(params.mint, programId);
  const [configPda] = deriveRadarConfigPda(params.mint, programId);

  const data = Buffer.alloc(16);
  TRANSFER_HOOK_EXECUTE_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(params.amount), 8);

  // Account order matches the transfer-hook `execute` interface:
  // [0] source, [1] mint, [2] destination, [3] authority, [4] validate_state,
  // [5] config PDA, [6] scan-record PDA.
  const keys: AccountMeta[] = [
    { pubkey: params.source, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.destination, isSigner: false, isWritable: false },
    { pubkey: params.owner, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetas, isSigner: false, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: params.record, isSigner: false, isWritable: false },
  ];

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
  /** Destination wallet (owner of `destination`) — its scan-record PDA is
   *  registered in the meta list and must be provided here. */
  destinationWallet: PublicKey;
  /** Optional source wallet (owner of `source`) — if provided, its scan-record
   *  PDA is included in remaining accounts for two-sided risk evaluation (Audit 2.2). */
  sourceWallet?: PublicKey;
  hookProgramId?: PublicKey;
}): TransactionInstruction {
  const hookProgramId = params.hookProgramId || DEFAULT_HOOK_PROGRAM_ID;
  const [extraAccountMetas] = deriveExtraAccountMetaListPda(params.mint, hookProgramId);
  const [configPda] = deriveRadarConfigPda(params.mint, hookProgramId);
  const [oracleRecord] = deriveRadarRecordPda(params.destinationWallet, params.mint, hookProgramId);

  // Token-22 TransferChecked layout:
  // [0]: Instruction index (12 = TransferChecked)
  // [1..8]: Amount (u64 LE)
  // [9]: Decimals (u8)
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(params.amount), 1);
  data.writeUInt8(params.decimals, 9);

  // Account layout: [0] source, [1] mint, [2] destination, [3] owner, then
  // the additional accounts the hook resolves by key: extra_account_metas PDA,
  // hook program id, and the meta-list accounts (config PDA, scan-record PDA).
  const keys: AccountMeta[] = [
    { pubkey: params.source, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.destination, isSigner: false, isWritable: true },
    { pubkey: params.owner, isSigner: true, isWritable: false },
    { pubkey: extraAccountMetas, isSigner: false, isWritable: false },
    { pubkey: hookProgramId, isSigner: false, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: oracleRecord, isSigner: false, isWritable: false },
  ];

  // Audit Revision 11 (WR-HIGH-01): Always provide the 9th account (sourceRecord)
  // to strictly match the 3-meta ExtraAccountMetaList schema and prevent Token-22
  // NotEnoughAccountKeys reverts. If sourceWallet is omitted, the owner of the source
  // token account is params.owner.
  const effectiveSourceWallet = params.sourceWallet || params.owner;
  const [sourceRecord] = deriveRadarRecordPda(effectiveSourceWallet, params.mint, hookProgramId);
  keys.push({ pubkey: sourceRecord, isSigner: false, isWritable: false });

  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Evaluates transfer risk matching the on-chain Rust hook logic (Audit 1.5: two-sided counterparty check).
 */
export function evaluateTransferRisk(
  recordInput: ScanLedgerRecord | Buffer | Uint8Array | null | undefined,
  config?: Partial<TransferHookConfig>,
  nowSec: number = Math.floor(Date.now() / 1000),
  sourceRecordInput?: ScanLedgerRecord | Buffer | Uint8Array | null,
): TransferRiskEvaluation {
  // Audit 1.5 & Audit 2.4: If sourceRecordInput is provided (including null for missing record), check source risk
  if (sourceRecordInput !== undefined) {
    const srcEval = evaluateTransferRisk(sourceRecordInput, config, nowSec);
    if (!srcEval.allowed) {
      return {
        ...srcEval,
        reason: srcEval.reason?.replace("Destination wallet", "Source wallet") || "Source wallet risk check failed",
      };
    }
  }

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
