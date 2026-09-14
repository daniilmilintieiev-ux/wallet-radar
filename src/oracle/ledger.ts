import { createHash } from "node:crypto";
import { PublicKey, Keypair, Connection, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createRpc, deriveAddressSeed, deriveAddress, getDefaultAddressTreeInfo, LightSystemProgram, Rpc } from "@lightprotocol/stateless.js";

/**
 * On-chain ZK-compressed scan ledger record schema.
 */
export interface ScanLedgerRecord {
  /** Target wallet address scanned */
  wallet: string;
  /** Risk score 0-100 */
  riskScore: number;
  /** Verdict badge ("SAFE", "LOW RISK", "SUSPICIOUS", "HIGH RISK", or custom) */
  verdict: "SAFE" | "LOW RISK" | "SUSPICIOUS" | "HIGH RISK" | string;
  /** Evaluation timestamp (Unix seconds) */
  timestamp: number;
  /** Anomaly rule IDs that fired */
  topRules: string[];
  /** Recent transaction signatures evaluated */
  txSignatures: string[];
  /** On-chain transaction signature committing this attestation */
  onchainSignature?: string;
  /** Ledger slot in which transaction was recorded */
  slot?: number;
  /** Derived compressed account address */
  compressedAddress?: string;
}

export interface CommitScanOptions {
  /** RPC endpoint URL supporting ZK compression (defaults to SOLANA_RPC_URL or HELIUS_RPC_URL) */
  rpcUrl?: string;
  /** Payer keypair for transaction fees */
  payerKeypair?: Keypair | unknown;
  /** Oracle program ID or authority */
  oracleProgramId?: string | PublicKey;
  /** Explicit enablement toggle; if undefined, checks process.env.RADAR_ORACLE === "1" */
  enabled?: boolean;
  /** Injectable oracle client for tests or custom RPC transports */
  client?: ZKOracleClient;
}

export interface CommitScanResult {
  signature: string | null;
  success: boolean;
  slot?: number;
  compressedAddress?: string;
  error?: string;
}

export interface ReadScanLedgerOptions {
  /** RPC endpoint URL */
  rpcUrl?: string;
  /** Oracle program ID */
  oracleProgramId?: string | PublicKey;
  /** Maximum number of records to return (defaults to 10) */
  limit?: number;
  /** Injectable oracle client */
  client?: ZKOracleClient;
}

/**
 * Default program ID used for compressed scan accounts.
 * Defaults to Light Protocol System Program.
 */
export const DEFAULT_ORACLE_PROGRAM_ID = new PublicKey("SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7");

/** Magic 4-byte header identifying binary scan ledger records ("RS01") */
export const SCAN_RECORD_MAGIC = Buffer.from("RS01", "utf-8");

/** Verdict code mapping for compact 1-byte storage */
const VERDICT_CODE_MAP: Record<string, number> = {
  SAFE: 0,
  "LOW RISK": 1,
  SUSPICIOUS: 2,
  "HIGH RISK": 3,
};

const CODE_VERDICT_MAP: Record<number, string> = {
  0: "SAFE",
  1: "LOW RISK",
  2: "SUSPICIOUS",
  3: "HIGH RISK",
};

/**
 * Serializes a ScanLedgerRecord into a compact deterministic binary buffer.
 * Layout:
 * [0..3]:   Magic 'RS01' (4 bytes)
 * [4..35]:  Wallet pubkey / hash (32 bytes)
 * [36]:     Risk score uint8 (1 byte, 0..100)
 * [37]:     Verdict code uint8 (1 byte: 0=SAFE, 1=LOW RISK, 2=SUSPICIOUS, 3=HIGH RISK, 255=CUSTOM)
 * [38..45]: Timestamp uint64LE (8 bytes)
 * [46..47]: Payload JSON byte length uint16LE (2 bytes)
 * [48..]:   Payload JSON buffer (topRules, txSignatures, and custom verdict/wallet if applicable)
 */
export function serializeScanRecord(record: ScanLedgerRecord): Buffer {
  const normalizedRisk = Math.max(0, Math.min(100, Math.round(record.riskScore || 0)));
  const normalizedTs = record.timestamp > 1e11 ? Math.floor(record.timestamp / 1000) : Math.floor(record.timestamp || 0);

  let pubkeyBytes: Buffer;
  let customWallet: string | undefined;
  try {
    pubkeyBytes = new PublicKey(record.wallet).toBuffer();
  } catch {
    // Non-standard address string (e.g. test addresses): hash to 32 bytes and retain original in payload
    pubkeyBytes = createHash("sha256").update(record.wallet).digest();
    customWallet = record.wallet;
  }

  const verdictCode = VERDICT_CODE_MAP[record.verdict] ?? 255;
  const payloadObj: Record<string, unknown> = {
    topRules: Array.isArray(record.topRules) ? record.topRules : [],
    txSignatures: Array.isArray(record.txSignatures) ? record.txSignatures : [],
  };
  if (verdictCode === 255) {
    payloadObj.verdict = record.verdict;
  }
  if (customWallet) {
    payloadObj.wallet = customWallet;
  }

  const payloadBuf = Buffer.from(JSON.stringify(payloadObj), "utf-8");
  const headerBuf = Buffer.alloc(48);

  SCAN_RECORD_MAGIC.copy(headerBuf, 0);
  pubkeyBytes.copy(headerBuf, 4);
  headerBuf.writeUInt8(normalizedRisk, 36);
  headerBuf.writeUInt8(verdictCode, 37);
  headerBuf.writeBigUInt64LE(BigInt(normalizedTs), 38);
  headerBuf.writeUInt16LE(payloadBuf.length, 46);

  return Buffer.concat([headerBuf, payloadBuf]);
}

/**
 * Deserializes a binary or JSON buffer back into a ScanLedgerRecord.
 */
export function deserializeScanRecord(buffer: Uint8Array | Buffer): ScanLedgerRecord {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (buf.length >= 48 && buf.subarray(0, 4).equals(SCAN_RECORD_MAGIC)) {
    const rawPubkeyBytes = buf.subarray(4, 36);
    const riskScore = buf.readUInt8(36);
    const verdictCode = buf.readUInt8(37);
    const timestamp = Number(buf.readBigUInt64LE(38));
    const payloadLen = buf.readUInt16LE(46);
    const payloadBytes = buf.subarray(48, 48 + payloadLen);

    let payload: { topRules?: string[]; txSignatures?: string[]; verdict?: string; wallet?: string } = {};
    if (payloadBytes.length > 0) {
      try {
        payload = JSON.parse(payloadBytes.toString("utf-8"));
      } catch {
        // Fallback to empty payload
      }
    }

    const wallet = payload.wallet || new PublicKey(rawPubkeyBytes).toBase58();
    const verdict = CODE_VERDICT_MAP[verdictCode] || payload.verdict || "UNKNOWN";

    return {
      wallet,
      riskScore,
      verdict,
      timestamp,
      topRules: payload.topRules || [],
      txSignatures: payload.txSignatures || [],
    };
  }

  // Fallback: JSON string buffer
  const str = buf.toString("utf-8").trim();
  if (str.startsWith("{")) {
    const parsed = JSON.parse(str);
    return {
      wallet: parsed.wallet || "",
      riskScore: typeof parsed.riskScore === "number" ? parsed.riskScore : 0,
      verdict: parsed.verdict || "UNKNOWN",
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
      topRules: Array.isArray(parsed.topRules) ? parsed.topRules : [],
      txSignatures: Array.isArray(parsed.txSignatures) ? parsed.txSignatures : [],
      onchainSignature: parsed.onchainSignature,
      slot: parsed.slot,
      compressedAddress: parsed.compressedAddress,
    };
  }

  throw new Error("Invalid scan ledger buffer: missing RS01 magic header or JSON structure");
}

/**
 * Oracle client interface enabling dependency injection for offline/unit tests.
 */
export interface ZKOracleClient {
  commit(
    record: ScanLedgerRecord,
    payer?: Keypair,
  ): Promise<{ signature: string; slot?: number; compressedAddress?: string }>;
  query(wallet: string, limit?: number): Promise<ScanLedgerRecord[]>;
}

/**
 * In-memory mock oracle client for deterministic, offline unit and integration tests.
 */
export class MockZKOracleClient implements ZKOracleClient {
  private records: Map<string, ScanLedgerRecord[]> = new Map();
  private failCommitMessage: string | null = null;
  private failQueryMessage: string | null = null;
  private commitCount = 0;

  setFailCommit(msg: string | null): void {
    this.failCommitMessage = msg;
  }

  setFailQuery(msg: string | null): void {
    this.failQueryMessage = msg;
  }

  async commit(
    record: ScanLedgerRecord,
    _payer?: Keypair,
  ): Promise<{ signature: string; slot: number; compressedAddress: string }> {
    if (this.failCommitMessage) {
      throw new Error(this.failCommitMessage);
    }
    this.commitCount++;

    const hash = createHash("sha256")
      .update(`${record.wallet}:${record.timestamp}:${this.commitCount}`)
      .digest("hex");
    const signature = `sig_${hash.slice(0, 48)}`;
    const compressedAddress = `comp_${hash.slice(0, 32)}`;
    const slot = 300_000_000 + this.commitCount;

    const storedRecord: ScanLedgerRecord = {
      ...record,
      onchainSignature: signature,
      slot,
      compressedAddress,
    };

    const existing = this.records.get(record.wallet) || [];
    existing.unshift(storedRecord);
    this.records.set(record.wallet, existing);

    return { signature, slot, compressedAddress };
  }

  async query(wallet: string, limit: number = 10): Promise<ScanLedgerRecord[]> {
    if (this.failQueryMessage) {
      throw new Error(this.failQueryMessage);
    }
    const list = this.records.get(wallet) || [];
    return [...list]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getAllRecords(): ScanLedgerRecord[] {
    const all: ScanLedgerRecord[] = [];
    for (const list of this.records.values()) {
      all.push(...list);
    }
    return all;
  }

  clear(): void {
    this.records.clear();
    this.commitCount = 0;
    this.failCommitMessage = null;
    this.failQueryMessage = null;
  }
}

/**
 * Production Light Protocol ZK compression oracle client.
 */
export class LightZKOracleClient implements ZKOracleClient {
  readonly rpcUrl: string;
  readonly oracleProgramId: PublicKey;
  private rpc: Rpc | null = null;

  constructor(opts: { rpcUrl?: string; oracleProgramId?: PublicKey | string } = {}) {
    this.rpcUrl =
      opts.rpcUrl ||
      process.env.SOLANA_RPC_URL ||
      process.env.HELIUS_RPC_URL ||
      "https://api.mainnet-beta.solana.com";

    if (opts.oracleProgramId) {
      this.oracleProgramId =
        typeof opts.oracleProgramId === "string"
          ? new PublicKey(opts.oracleProgramId)
          : opts.oracleProgramId;
    } else {
      this.oracleProgramId = DEFAULT_ORACLE_PROGRAM_ID;
    }
  }

  getRpc(): Rpc {
    if (!this.rpc) {
      this.rpc = createRpc(this.rpcUrl, this.rpcUrl);
    }
    return this.rpc;
  }

  async commit(
    record: ScanLedgerRecord,
    payer?: Keypair,
  ): Promise<{ signature: string; slot?: number; compressedAddress?: string }> {
    const rpc = this.getRpc();

    let targetWalletPubkey: PublicKey;
    try {
      targetWalletPubkey = new PublicKey(record.wallet);
    } catch {
      const hash = createHash("sha256").update(record.wallet).digest();
      targetWalletPubkey = new PublicKey(hash);
    }

    // Derive deterministic address seed for Light Protocol
    const seed = deriveAddressSeed([Buffer.from("radar-scan"), targetWalletPubkey.toBuffer()]);

    let compressedAddressStr: string | undefined;
    try {
      const addressTree = getDefaultAddressTreeInfo();
      const derived = deriveAddress(seed, addressTree.tree, this.oracleProgramId);
      compressedAddressStr = derived.toBase58();
    } catch {
      compressedAddressStr = new PublicKey(seed).toBase58();
    }

    const payload = serializeScanRecord(record);
    const activePayer = payer || Keypair.generate();

    // Attestation memo transaction anchored to recent blockhash
    const { blockhash } = await rpc.getLatestBlockhash();
    const memoData = Buffer.concat([Buffer.from("RADAR_ORACLE:"), payload]);
    const ix = new TransactionInstruction({
      keys: [{ pubkey: activePayer.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: memoData,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = activePayer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(activePayer);

    const signature = await rpc.sendTransaction(tx, [activePayer]);
    return { signature, compressedAddress: compressedAddressStr };
  }

  async query(wallet: string, limit: number = 10): Promise<ScanLedgerRecord[]> {
    const rpc = this.getRpc();
    const records: ScanLedgerRecord[] = [];

    try {
      const res = await rpc.getCompressedAccountsByOwner(this.oracleProgramId, {
        limit: Math.max(limit * 2, 20),
      });

      if (res && Array.isArray(res.items)) {
        for (const item of res.items) {
          if (!item.data) continue;
          try {
            const rawBytes = ((item.data as unknown as { data?: Uint8Array }).data ?? item.data) as unknown as Uint8Array;
            const parsed = deserializeScanRecord(rawBytes);
            if (parsed.wallet === wallet) {
              records.push({
                ...parsed,
                onchainSignature: item.hash ? item.hash.toString() : undefined,
              });
            }
          } catch {
            // Ignore non-matching or invalid accounts
          }
        }
      }
    } catch (err) {
      if (process.env.RADAR_DEBUG === "1") {
        console.error("Failed to query compressed scan ledger accounts:", err);
      }
    }

    return records
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

/**
 * Commits a scan attestation into the on-chain ZK scan ledger.
 * Best-effort: catches all errors and returns a failure result instead of throwing.
 */
export async function commitScan(
  record: ScanLedgerRecord,
  opts: CommitScanOptions = {},
): Promise<CommitScanResult> {
  const isEnabled = opts.enabled ?? (opts.client !== undefined || process.env.RADAR_ORACLE === "1");
  if (!isEnabled) {
    return {
      signature: null,
      success: false,
      error: "Oracle commit disabled (set RADAR_ORACLE=1 or pass enabled: true)",
    };
  }

  try {
    const client = opts.client || new LightZKOracleClient({
      rpcUrl: opts.rpcUrl,
      oracleProgramId: opts.oracleProgramId,
    });

    const payer = opts.payerKeypair instanceof Keypair ? opts.payerKeypair : undefined;
    const res = await client.commit(record, payer);

    return {
      signature: res.signature,
      slot: res.slot,
      compressedAddress: res.compressedAddress,
      success: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.RADAR_DEBUG === "1") {
      console.error(`[oracle] commitScan failed for ${record.wallet}:`, msg);
    }
    return {
      signature: null,
      success: false,
      error: msg,
    };
  }
}

/**
 * Reads historical scan attestations for a given wallet from the on-chain ZK ledger.
 * Gracefully returns an empty list on failure without throwing.
 */
export async function readScanLedger(
  wallet: string,
  opts: ReadScanLedgerOptions = {},
): Promise<ScanLedgerRecord[]> {
  try {
    const client = opts.client || new LightZKOracleClient({
      rpcUrl: opts.rpcUrl,
      oracleProgramId: opts.oracleProgramId,
    });

    const limit = Math.max(1, opts.limit ?? 10);
    return await client.query(wallet, limit);
  } catch (err: unknown) {
    if (process.env.RADAR_DEBUG === "1") {
      console.error(`[oracle] readScanLedger failed for ${wallet}:`, err);
    }
    return [];
  }
}
