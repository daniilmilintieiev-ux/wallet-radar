import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { PublicKey, Keypair, Connection, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createRpc, compress, Rpc } from "@lightprotocol/stateless.js";

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
 * Load the oracle payer keypair.
 *
 * Primary: `RADAR_ORACLE_KEYPAIR` — path to a keypair file (JSON array of 64
 * byte values, the format produced by `solana-keygen`). File-based storage is
 * the recommended default: the secret never appears in the process
 * environment. See SECURITY.md for the env/file/KMS trade-off.
 *
 * Fallback: `RADAR_ORACLE_PAYER` — base58-encoded 64-byte secret key stored
 * directly in the environment (prototype convenience).
 */
export function loadPayerFromEnv(): Keypair | null {
  const keypairPath = process.env.RADAR_ORACLE_KEYPAIR?.trim();
  if (keypairPath) {
    try {
      const raw: unknown = JSON.parse(readFileSync(keypairPath, "utf8"));
      if (
        Array.isArray(raw) &&
        raw.length === 64 &&
        raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
      ) {
        return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
      }
      console.warn("[oracle] RADAR_ORACLE_KEYPAIR is not a 64-byte JSON array — trying RADAR_ORACLE_PAYER");
    } catch (err) {
      console.warn(
        `[oracle] failed to read RADAR_ORACLE_KEYPAIR: ${err instanceof Error ? err.message : String(err)} — trying RADAR_ORACLE_PAYER`,
      );
    }
  }
  const raw = process.env.RADAR_ORACLE_PAYER;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
  } catch {
    return null;
  }
}

/**
 * Map a wallet string to the on-chain owner pubkey. Real base58 pubkeys pass
 * through unchanged; synthetic strings (tests) are deterministically hashed so
 * commit() and query() always agree on the compressed-account owner.
 */
function normalizeOwnerPubkey(wallet: string): PublicKey {
  try {
    return new PublicKey(wallet);
  } catch {
    return new PublicKey(createHash("sha256").update(wallet).digest());
  }
}

/**
 * Production Light Protocol ZK compression oracle client.
 *
 * Design (validated on Solana mainnet):
 *  - WRITE: `compress(rpc, payer, lamports, toAddress = wallet)` creates a real
 *    ZK-compressed account OWNED BY THE SCANNED WALLET, where `lamports` packs
 *    the attestation as `risk(0..100) * 1000 + verdictCode(0..3) + 1`. The
 *    account's `slotCreated` is the attestation timestamp. A companion
 *    best-effort Memo carries the full serialized record for explorer search.
 *  - READ: raw JSON-RPC `getCompressedAccountsByOwner(wallet)` (owner = wallet,
 *    NO config object — the Light SDK's typed path is broken on plain-JSON
 *    responses). Each account's lamports is inverted to recover risk + verdict;
 *    `slotCreated` -> `getBlockTime` yields the timestamp.
 */
export class LightZKOracleClient implements ZKOracleClient {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly oracleProgramId: PublicKey;
  private rpc: Rpc | null = null;
  private conn: Connection | null = null;

  constructor(opts: { rpcUrl?: string; oracleProgramId?: PublicKey | string } = {}) {
    const base =
      opts.rpcUrl ||
      process.env.SOLANA_RPC_URL ||
      process.env.HELIUS_RPC_URL ||
      (process.env.HELIUS_API_KEY
        ? "https://mainnet.helius-rpc.com/?api-key=" + process.env.HELIUS_API_KEY
        : undefined) ||
      "https://api.mainnet-beta.solana.com";
    this.rpcUrl = base;
    this.wsUrl = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

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
      this.rpc = createRpc(this.rpcUrl, this.wsUrl);
    }
    return this.rpc;
  }

  getConnection(): Connection {
    if (!this.conn) {
      this.conn = new Connection(this.rpcUrl, "confirmed");
    }
    return this.conn;
  }

  /** Raw JSON-RPC over HTTP — bypasses the Light SDK's broken typed response coercion. */
  private async jsonRpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) {
      throw new Error(`jsonRpc ${method}: HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      result?: T;
      error?: { code?: number; message?: string };
    };
    if (json.error) {
      throw new Error(`jsonRpc ${method}: ${json.error.message || json.error.code}`);
    }
    return json.result as T;
  }

  /** Invert a packed lamports value back into (risk, verdictCode). */
  private static unpackLamports(lamports: number): { risk: number; verdictCode: number } {
    const x = Math.trunc(Number(lamports)) - 1;
    if (x < 0) return { risk: 0, verdictCode: 0 };
    return { risk: Math.floor(x / 1000), verdictCode: x % 1000 };
  }

  /** Best-effort: unix seconds for a slot, or 0 if unknown. */
  private async blockTime(slot: number): Promise<number> {
    try {
      const t = await this.getConnection().getBlockTime(slot);
      if (t !== null && t > 0) return t;
    } catch {
      // fall through
    }
    return 0;
  }

  /** Best-effort human-readable Memo anchor carrying the full serialized record. */
  private async sendMemoAnchor(payer: Keypair, record: ScanLedgerRecord): Promise<string> {
    const conn = this.getConnection();
    const payload = serializeScanRecord(record);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const memoPrefix = Buffer.from("RADAR_ORACLE:");
    const payloadForMemo =
      memoPrefix.length + payload.length > 512
        ? payload.subarray(0, 512 - memoPrefix.length)
        : payload;
    const memoData = Buffer.concat([memoPrefix, payloadForMemo]);
    const ix = new TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: memoData,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(payer);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }

  async commit(
    record: ScanLedgerRecord,
    payer?: Keypair,
  ): Promise<{ signature: string; slot?: number; compressedAddress?: string }> {
    const activePayer = payer ?? loadPayerFromEnv();
    if (!activePayer) {
      throw new Error(
        "oracle.commit: no payer keypair provided (configure RADAR_ORACLE_KEYPAIR or RADAR_ORACLE_PAYER) — a random throwaway payer has no funds to pay the tx fee",
      );
    }
    const conn = this.getConnection();

    // The scanned wallet becomes the OWNER of the on-chain compressed attestation.
    const targetWallet = normalizeOwnerPubkey(record.wallet);

    // Pack the attestation into lamports (cleanly invertible on read).
    const normalizedRisk = Math.max(0, Math.min(100, Math.round(record.riskScore || 0)));
    const verdictCode = VERDICT_CODE_MAP[record.verdict] ?? 3;
    const lamports = normalizedRisk * 1000 + verdictCode + 1;

    // Record the payer's latest slot so we can locate the new tx after the fact.
    const beforeSigs = await conn.getSignaturesForAddress(activePayer.publicKey, { limit: 1 });
    const beforeSlot = beforeSigs.length > 0 ? beforeSigs[0].slot : 0;

    // 1) Real ZK-compressed attestation account owned by the scanned wallet.
    let signature: string | null = null;
    let slot: number | undefined;
    try {
      signature = await compress(this.getRpc(), activePayer, lamports, targetWallet);
    } catch {
      // The SDK's WS confirmation can throw "fetch failed" even though the tx is
      // already committed on-chain; we recover the signature + slot over HTTP below.
    }

    // Verify on-chain + recover the signature/slot (poll briefly for the new account).
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await this.jsonRpc<{ value?: { items?: Array<Record<string, unknown>> } }>(
          "getCompressedAccountsByOwner",
          [targetWallet.toBase58()],
        );
        const items = res?.value?.items ?? [];
        const match = items
          .map((it) => ({
            lamports: Number((it as { lamports?: string | number }).lamports),
            slot: Number((it as { slotCreated?: string | number }).slotCreated),
          }))
          .filter((it) => it.lamports === lamports && it.slot > beforeSlot);
        if (match.length > 0) {
          slot = match[0].slot;
          const sigs = await conn.getSignaturesForAddress(activePayer.publicKey, { limit: 10 });
          const hit = sigs.find((s) => s.slot === slot && !s.err);
          signature = hit?.signature ?? sigs[0]?.signature ?? signature;
          break;
        }
      } catch {
        // transient RPC hiccup; keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // 2) Best-effort human-readable memo anchor (the compressed account is canonical).
    try {
      const memoSig = await this.sendMemoAnchor(activePayer, record);
      if (!signature) signature = memoSig;
    } catch {
      // best-effort
    }

    if (!signature) {
      throw new Error("oracle.commit: attestation transaction did not confirm on-chain");
    }

    return { signature, slot, compressedAddress: targetWallet.toBase58() };
  }

  async query(wallet: string, limit: number = 10): Promise<ScanLedgerRecord[]> {
    const records: ScanLedgerRecord[] = [];
    try {
      // Raw JSON-RPC: owner = the scanned wallet, NO config object (the Light
      // SDK's typed path is broken on plain-JSON responses).
      const res = await this.jsonRpc<{ value?: { items?: Array<Record<string, unknown>> } }>(
        "getCompressedAccountsByOwner",
        [normalizeOwnerPubkey(wallet).toBase58()],
      );
      const items = res?.value?.items ?? [];
      for (const item of items) {
        try {
          const lamports = Number((item as { lamports?: string | number }).lamports);
          const slotCreated = Number((item as { slotCreated?: string | number }).slotCreated);
          if (!Number.isFinite(lamports) || !Number.isFinite(slotCreated) || slotCreated <= 0) {
            continue;
          }
          const { risk, verdictCode } = LightZKOracleClient.unpackLamports(lamports);
          if (risk > 100 || verdictCode > 3) continue; // not a radar attestation
          const timestamp = await this.blockTime(slotCreated);
          records.push({
            wallet,
            riskScore: risk,
            verdict: CODE_VERDICT_MAP[verdictCode] || "UNKNOWN",
            timestamp,
            topRules: [],
            txSignatures: [],
            slot: slotCreated,
            compressedAddress: normalizeOwnerPubkey(wallet).toBase58(),
          });
        } catch {
          // ignore malformed items
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
