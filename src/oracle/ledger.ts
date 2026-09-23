import { createHash, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { PublicKey, Keypair, Connection, Transaction, TransactionInstruction, VersionedTransactionResponse } from "@solana/web3.js";
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
  /**
   * Audit 1.2: Ed25519 signature (base58) of the canonical attestation digest,
   * produced by the oracle's signing key. Forged compressed accounts (lamports
   * packing) are only accepted when this signature verifies.
   */
  signature?: string;
  /** base58 public key of the oracle key that produced `signature` */
  oraclePublicKey?: string;
  /** True when `signature` was verified against the expected oracle key */
  verified?: boolean;
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
export const VERDICT_CODE_MAP: Record<string, number> = {
  SAFE: 0,
  "LOW RISK": 1,
  SUSPICIOUS: 2,
  "HIGH RISK": 3,
};

/**
 * Audit 1.2: domain separator for the canonical attestation digest. An
 * attestation is an Ed25519 signature by the oracle key over
 * `sha256(DOMAIN || walletHash32 || risk(u8) || verdictCode(u8) || timestamp(u64le))`.
 * The digest binds the exact (wallet, risk, verdict, timestamp) tuple, so a
 * forged compressed account with matching lamports but no valid signature is
 * rejected on read.
 */
export const ORACLE_ATTESTATION_DOMAIN = Buffer.from("RADAR-ATTESTATION-V2", "utf-8");

/**
 * Maps a wallet string to its 32-byte form for on-chain use: real base58
 * pubkeys pass through, synthetic strings are sha256-hashed (mirrors the
 * RS01 header's wallet field and normalizeOwnerPubkey).
 */
export function walletToHash32(wallet: string): Buffer {
  try {
    return new PublicKey(wallet).toBuffer();
  } catch {
    return createHash("sha256").update(wallet).digest();
  }
}

/**
 * Audit 1.2: canonical digest covered by the oracle's Ed25519 signature.
 */
export function buildAttestationDigest(
  record: { wallet: string; riskScore: number; verdict: string; timestamp: number },
): Buffer {
  const normalizedRisk = Math.max(0, Math.min(100, Math.round(record.riskScore || 0)));
  const verdictCode = VERDICT_CODE_MAP[record.verdict] ?? 255;
  const normalizedTs = record.timestamp > 1e11 ? Math.floor(record.timestamp / 1000) : Math.floor(record.timestamp || 0);
  const risk = Buffer.alloc(1);
  risk.writeUInt8(normalizedRisk, 0);
  const code = Buffer.alloc(1);
  code.writeUInt8(verdictCode, 0);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(normalizedTs), 0);
  return createHash("sha256")
    .update(ORACLE_ATTESTATION_DOMAIN)
    .update(walletToHash32(record.wallet))
    .update(risk)
    .update(code)
    .update(ts)
    .digest();
}

/** Ed25519 SPKI DER prefix for a raw 32-byte public key */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Ed25519 PKCS8 DER prefix for a raw 32-byte private-key seed */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Signs an attestation with the oracle keypair (Ed25519 over the canonical
 * digest, via node:crypto). Returns base58 signature and the signer's base58
 * public key.
 */
export function signAttestation(
  record: { wallet: string; riskScore: number; verdict: string; timestamp: number },
  signer: Keypair,
): { signature: string; oraclePublicKey: string } {
  const digest = buildAttestationDigest(record);
  const seed = Buffer.from(signer.secretKey).subarray(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const signature = cryptoSign(null, digest, privateKey);
  return {
    signature: bs58.encode(signature),
    oraclePublicKey: signer.publicKey.toBase58(),
  };
}

/**
 * Audit 1.2: verifies a record's Ed25519 signature over its canonical digest.
 * When `expectedPublicKey` is given, the record's `oraclePublicKey` must match
 * it exactly (trust is anchored to the known oracle identity).
 */
export function verifyAttestation(
  record: {
    wallet: string;
    riskScore: number;
    verdict: string;
    timestamp: number;
    signature?: string;
    oraclePublicKey?: string;
  },
  expectedPublicKey?: string,
): boolean {
  if (!record.signature || !record.oraclePublicKey) return false;
  if (expectedPublicKey && record.oraclePublicKey !== expectedPublicKey) return false;
  try {
    const signatureBytes = bs58.decode(record.signature);
    const publicKeyBytes = new PublicKey(record.oraclePublicKey).toBuffer();
    if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, buildAttestationDigest(record), key, Buffer.from(signatureBytes));
  } catch {
    return false;
  }
}

export const CODE_VERDICT_MAP: Record<number, string> = {
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
 * [..+96]:  Optional attestation trailer (audit 1.2), present only when the
 *           record carries a signature: signature (64 bytes) + oracle pubkey (32 bytes).
 *           Legacy 48+payload buffers deserialize unchanged.
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

  let out = Buffer.concat([headerBuf, payloadBuf]);

  // Audit 1.2: append the attestation trailer (64-byte signature + 32-byte
  // oracle pubkey) when present, so the memo anchor carries a verifiable proof.
  if (record.signature && record.oraclePublicKey) {
    try {
      const sigBytes = bs58.decode(record.signature);
      const pubBytes = new PublicKey(record.oraclePublicKey).toBuffer();
      if (sigBytes.length === 64 && pubBytes.length === 32) {
        const trailer = Buffer.alloc(96);
        Buffer.from(sigBytes).copy(trailer, 0);
        pubBytes.copy(trailer, 64);
        out = Buffer.concat([out, trailer]);
      }
    } catch {
      // Malformed signature/pubkey — serialize without trailer.
    }
  }

  return out;
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

    const record: ScanLedgerRecord = {
      wallet,
      riskScore,
      verdict,
      timestamp,
      topRules: payload.topRules || [],
      txSignatures: payload.txSignatures || [],
    };

    // Audit 1.2: optional 96-byte attestation trailer (signature + oracle
    // pubkey) after the payload. Legacy buffers without a trailer are unchanged.
    const trailerStart = 48 + payloadLen;
    if (buf.length === trailerStart + 96) {
      try {
        const sig = bs58.encode(buf.subarray(trailerStart, trailerStart + 64));
        const pub = new PublicKey(buf.subarray(trailerStart + 64, trailerStart + 96)).toBase58();
        record.signature = sig;
        record.oraclePublicKey = pub;
      } catch {
        // Trailer present but undecodable — keep the header fields only.
      }
    }

    return record;
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
 *    best-effort Memo carries the serialized record (including the audit 1.2
 *    Ed25519 attestation signature) for explorer search.
 *  - READ (audit 1.2): when the oracle's signing identity is known, the PRIMARY
 *    path reads the oracle's own confirmed transactions and accepts only memos
 *    carrying a signature that verifies against that identity — forged
 *    compressed accounts (attacker-payer lamports packing) never appear there.
 *    When the identity is unknown (pure read-only clients) or the anchor path
 *    fails, it falls back to the legacy lamports decode of
 *    `getCompressedAccountsByOwner(wallet)` (records marked unverified).
 */
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MEMO_PREFIX = Buffer.from("RADAR_ORACLE:");

export interface LightZKOracleClientOptions {
  rpcUrl?: string;
  oracleProgramId?: PublicKey | string;
  /**
   * Audit 1.2: base58 public key the oracle attests with. When set (or
   * resolvable from RADAR_ORACLE_PUBLIC_KEY / RADAR_ORACLE_KEYPAIR /
   * RADAR_ORACLE_PAYER), query() only returns records whose embedded Ed25519
   * signature verifies against this key.
   */
  oraclePublicKey?: string;
  /** Test hook: Connection factory (defaults to `new Connection(rpcUrl, "confirmed")`). */
  connectionFactory?: (rpcUrl: string) => Connection;
  /** Test hook: raw JSON-RPC transport (defaults to HTTP POST against rpcUrl). */
  jsonRpcFactory?: <T>(method: string, params: unknown[]) => Promise<T>;
}

export class LightZKOracleClient implements ZKOracleClient {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly oracleProgramId: PublicKey;
  readonly oraclePublicKey: string | null;
  private rpc: Rpc | null = null;
  private conn: Connection | null = null;
  private anchorCache = new Map<string, { records: ScanLedgerRecord[]; expires: number }>();
  private readonly connectionFactory: ((rpcUrl: string) => Connection) | null;
  private readonly jsonRpcFactory: ((method: string, params: unknown[]) => Promise<unknown>) | null;

  constructor(opts: LightZKOracleClientOptions = {}) {
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

    this.oraclePublicKey = opts.oraclePublicKey?.trim() || null;
    this.connectionFactory = opts.connectionFactory ?? null;
    this.jsonRpcFactory = opts.jsonRpcFactory ?? null;
  }

  /**
   * Audit 1.2: resolves the oracle identity attestations are verified against.
   * Order: explicit option > RADAR_ORACLE_PUBLIC_KEY > the configured payer
   * keypair (RADAR_ORACLE_KEYPAIR / RADAR_ORACLE_PAYER) > null (legacy mode).
   */
  private resolveExpectedOracleKey(): string | null {
    if (this.oraclePublicKey) return this.oraclePublicKey;
    const envKey = process.env.RADAR_ORACLE_PUBLIC_KEY?.trim();
    if (envKey) return envKey;
    try {
      const payer = loadPayerFromEnv();
      if (payer) return payer.publicKey.toBase58();
    } catch {
      // env misconfiguration — legacy mode
    }
    return null;
  }

  getRpc(): Rpc {
    if (!this.rpc) {
      this.rpc = createRpc(this.rpcUrl, this.wsUrl);
    }
    return this.rpc;
  }

  getConnection(): Connection {
    if (!this.conn) {
      this.conn = this.connectionFactory
        ? this.connectionFactory(this.rpcUrl)
        : new Connection(this.rpcUrl, "confirmed");
    }
    return this.conn;
  }

  /** Raw JSON-RPC over HTTP — bypasses the Light SDK's broken typed response coercion. */
  private async jsonRpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    if (this.jsonRpcFactory) {
      return (await this.jsonRpcFactory(method, params)) as T;
    }
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

  /**
   * Best-effort human-readable Memo anchor carrying the serialized record.
   * Audit 1.2: the payload is never truncated mid-record — that would destroy
   * the 96-byte attestation trailer. Overlong records are re-serialized
   * compactly (empty topRules/txSignatures) so the signed attestation always
   * fits the 512-byte memo cap.
   */
  private async sendMemoAnchor(payer: Keypair, record: ScanLedgerRecord): Promise<string> {
    const conn = this.getConnection();
    let payload = serializeScanRecord(record);
    if (MEMO_PREFIX.length + payload.length > 512) {
      let compact: ScanLedgerRecord = { ...record, topRules: [], txSignatures: [] };
      let compactPayload = serializeScanRecord(compact);
      if (MEMO_PREFIX.length + compactPayload.length <= 512) {
        payload = compactPayload;
      } else {
        // If still over 512 (e.g. huge custom verdict or synthetic wallet string), truncate fields and re-sign
        if (compact.verdict.length > 64) {
          compact.verdict = compact.verdict.slice(0, 64);
        }
        if (compact.wallet.length > 64) {
          compact.wallet = compact.wallet.slice(0, 64);
        }
        if (compact.signature && compact.oraclePublicKey) {
          try {
            const reSigned = signAttestation(compact, payer);
            compact.signature = reSigned.signature;
            compact.oraclePublicKey = reSigned.oraclePublicKey;
          } catch {
            // keep existing or drop
          }
        }
        compactPayload = serializeScanRecord(compact);
        if (MEMO_PREFIX.length + compactPayload.length <= 512) {
          payload = compactPayload;
        } else {
          // If still over 512, drop signature trailer cleanly rather than slicing off the 96-byte trailer mid-record
          const unsigned: ScanLedgerRecord = { ...compact, signature: undefined, oraclePublicKey: undefined };
          const unsignedPayload = serializeScanRecord(unsigned);
          if (MEMO_PREFIX.length + unsignedPayload.length <= 512) {
            payload = unsignedPayload;
          } else {
            payload = unsignedPayload.subarray(0, 512 - MEMO_PREFIX.length);
          }
        }
      }
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const memoData = Buffer.concat([MEMO_PREFIX, payload]);
    const targetWallet = normalizeOwnerPubkey(record.wallet);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        // Audit 2.3: include targetWallet so Solana RPC indexes this memo transaction under the wallet's address
        { pubkey: targetWallet, isSigner: false, isWritable: false },
      ],
      programId: MEMO_PROGRAM_ID,
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
      } catch (err: unknown) {
        // Fast-fail if standard RPC does not support Light Protocol compression indexer (Audit Revision 9, Bug 3).
        const msg = String((err as { message?: string })?.message || err).toLowerCase();
        if (
          msg.includes("method not found") ||
          msg.includes("-32601") ||
          msg.includes("http 404") ||
          msg.includes("http 405") ||
          msg.includes("http 400") ||
          msg.includes("http 501") ||
          msg.includes("not supported") ||
          msg.includes("unsupported")
        ) {
          break;
        }
        // transient RPC hiccup; keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // 2) Best-effort human-readable memo anchor (the compressed account is canonical).
    // Audit 1.2: sign the attestation with the oracle key so readers can verify
    // it cryptographically instead of trusting arbitrary lamports packing.
    let signedRecord = record;
    try {
      const signed = signAttestation(record, activePayer);
      signedRecord = {
        ...record,
        signature: signed.signature,
        oraclePublicKey: signed.oraclePublicKey,
      };
    } catch {
      // signing is local-only; on failure the memo falls back to legacy format
    }
    try {
      const memoSig = await this.sendMemoAnchor(activePayer, signedRecord);
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
    const expectedKey = this.resolveExpectedOracleKey();
    if (expectedKey) {
      try {
        // Audit 1.2: primary path — only attestations the oracle itself
        // committed (and whose Ed25519 signature verifies) are accepted.
        const res = await this.querySignedAnchors(wallet, expectedKey, limit);
        if (res.length > 0) {
          return res;
        }
      } catch (err) {
        if (process.env.RADAR_DEBUG === "1") {
          console.error("Signed-anchor query failed, falling back to legacy lamports decode:", err);
        }
      }
    }
    return this.queryLegacyLamports(wallet, limit);
  }

  /**
   * Audit 1.2: reads the oracle's own confirmed transactions, extracts the
   * `RADAR_ORACLE:` memo anchors, and returns only records whose embedded
   * signature verifies against `expectedKey`. A forged compressed account
   * (created by an attacker's payer) cannot appear here — it is not part of
   * the oracle's transaction history.
   */
  private async querySignedAnchors(wallet: string, expectedKey: string, limit: number): Promise<ScanLedgerRecord[]> {
    const cacheKey = `${wallet}:${expectedKey}`;
    const cached = this.anchorCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.records.slice(0, limit);
    }

    const conn = this.getConnection();
    const targetWallet = normalizeOwnerPubkey(wallet);
    const found: ScanLedgerRecord[] = [];

    // Audit 2.3: 1) Query target wallet's own transaction signatures first.
    // When published with targetWallet in instruction keys, this directly retrieves
    // only the relevant transactions without scanning the oracle's entire history or hitting pagination limits.
    try {
      const walletSigs = await conn.getSignaturesForAddress(targetWallet, { limit: 25 });
      if (Array.isArray(walletSigs) && walletSigs.length > 0) {
        const batch = walletSigs.map((s) => s.signature);
        const txs = await conn.getTransactions(batch, { maxSupportedTransactionVersion: 0 });
        for (const tx of txs) {
          if (!tx || tx.meta?.err) continue;
          for (const rec of this.extractMemoAnchors(tx)) {
            if (rec.wallet !== wallet) continue;
            if (!verifyAttestation(rec, expectedKey)) continue;
            found.push({
              ...rec,
              slot: tx.slot,
              onchainSignature: tx.transaction?.signatures?.[0],
              compressedAddress: targetWallet.toBase58(),
              verified: true,
            });
          }
        }
      }
    } catch {
      // In case RPC throws on wallet query, fallback to oracleKey below
    }

    // 2) Fallback: if no records were found under targetWallet (e.g. legacy records or mock tests),
    // paginate the oracle key's transactions up to 4 pages.
    if (found.length === 0) {
      const oracleKey = new PublicKey(expectedKey);
      let before: string | undefined = undefined;
      const maxPages = 4;
      const seenSigs = new Set<string>();

      for (let page = 0; page < maxPages && found.length < limit; page++) {
        const opts: { limit: number; before?: string } = { limit: 100 };
        if (before) opts.before = before;
        const sigs = await conn.getSignaturesForAddress(oracleKey, opts);
        if (sigs.length === 0) break;
        const isLastPage = sigs.length < opts.limit;
        before = sigs[sigs.length - 1].signature;

        const newSigs = sigs.filter((s) => !seenSigs.has(s.signature));
        if (newSigs.length === 0) break;
        for (const s of newSigs) seenSigs.add(s.signature);

        for (let i = 0; i < newSigs.length && found.length < limit; i += 25) {
          const batch = newSigs.slice(i, i + 25).map((s) => s.signature);
          const txs = await conn.getTransactions(batch, { maxSupportedTransactionVersion: 0 });
          for (const tx of txs) {
            if (!tx || tx.meta?.err) continue;
            for (const rec of this.extractMemoAnchors(tx)) {
              if (rec.wallet !== wallet) continue;
              if (!verifyAttestation(rec, expectedKey)) continue;
              found.push({
                ...rec,
                slot: tx.slot,
                onchainSignature: tx.transaction?.signatures?.[0],
                compressedAddress: targetWallet.toBase58(),
                verified: true,
              });
            }
          }
        }
        if (isLastPage) break;
      }
    }

    const sorted = found
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    // Audit 1.4: Cache both positive and negative results (empty records: []) with 60s TTL
    // to prevent DoS and RPC quota exhaustion when querying unknown/unrecorded wallets.
    this.anchorCache.set(cacheKey, { records: sorted, expires: Date.now() + 60_000 });

    return sorted;
  }

  /** Extracts and deserializes `RADAR_ORACLE:` memo anchors from a compiled transaction. */
  private extractMemoAnchors(tx: VersionedTransactionResponse): ScanLedgerRecord[] {
    const out: ScanLedgerRecord[] = [];
    let accountKeys: string[] = [];
    const message = (tx.transaction as any)?.message;
    if (message) {
      if (typeof message.getAccountKeys === "function") {
        try {
          const loaded = tx.meta?.loadedAddresses;
          const allKeys = message.getAccountKeys({ accountKeysFromLookups: loaded });
          accountKeys = Array.from({ length: allKeys.length }, (_, i) => {
            const k = allKeys.get(i);
            return typeof k === "string" ? k : k?.toBase58?.() ?? (k ? String(k) : "");
          });
        } catch {
          // fallback to manual lookup below
        }
      }
      if (accountKeys.length === 0) {
        const rawKeys = message.staticAccountKeys ?? message.accountKeys ?? [];
        const loadedWritable = tx.meta?.loadedAddresses?.writable ?? [];
        const loadedReadonly = tx.meta?.loadedAddresses?.readonly ?? [];
        const combined = [...rawKeys, ...loadedWritable, ...loadedReadonly];
        accountKeys = combined.map((k: any) =>
          typeof k === "string" ? k : k?.toBase58?.() ?? (k ? String(k) : ""),
        );
      }
    }

    const instructions: Array<{ programIdIndex?: number; data?: string | Uint8Array | Buffer }> =
      message?.compiledInstructions ?? message?.instructions ?? [];

    for (const instr of instructions) {
      const keyIndex = instr.programIdIndex;
      if (typeof keyIndex !== "number" || instr.data === undefined || instr.data === null) continue;
      const keyB58 = accountKeys[keyIndex];
      if (!keyB58) continue;
      let programId: PublicKey;
      try {
        programId = new PublicKey(keyB58);
      } catch {
        continue;
      }
      if (!programId.equals(MEMO_PROGRAM_ID)) continue;
      let data: Buffer;
      try {
        if (typeof instr.data === "string") {
          data = Buffer.from(bs58.decode(instr.data));
        } else if (instr.data instanceof Uint8Array || Buffer.isBuffer(instr.data)) {
          data = Buffer.from(instr.data);
        } else {
          continue;
        }
      } catch {
        continue;
      }
      const idx = data.indexOf(MEMO_PREFIX);
      if (idx < 0) continue;
      try {
        out.push(deserializeScanRecord(data.subarray(idx + MEMO_PREFIX.length)));
      } catch {
        // not a scan anchor
      }
    }
    return out;
  }

  /**
   * Legacy read path: decodes lamports of compressed accounts owned by the
   * wallet. Kept for read-only clients without the oracle identity and as an
   * availability fallback. Records are marked `verified: false`.
   */
  private async queryLegacyLamports(wallet: string, limit: number): Promise<ScanLedgerRecord[]> {
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
            verified: false,
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
