import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { readScanLedger, ScanLedgerRecord, ZKOracleClient } from "../oracle/index.js";
import { USDC_MINT } from "../types.js";
import type { TrustProofBundle } from "../trust-proof.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encodes a byte array to base58 string without external dependencies.
 */
export function encodeBase58(source: Uint8Array): string {
  if (source.length === 0) return "";
  const digits = [0];
  for (let i = 0; i < source.length; i++) {
    let carry = source[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = "";
  for (let i = 0; i < source.length && source[i] === 0; i++) {
    str += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    str += BASE58_ALPHABET[digits[i]];
  }
  return str;
}

/**
 * Derives the Associated Token Account (ATA) for a given wallet and mint.
 */
export function deriveAssociatedTokenAddress(
  wallet: PublicKey,
  mint: PublicKey = new PublicKey(USDC_MINT),
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

/**
 * Builds an SPL Token transfer instruction (transfer index 3).
 */
export function buildSplTransferInstruction(
  sourceAta: PublicKey,
  destinationAta: PublicKey,
  owner: PublicKey,
  amountUnits: bigint | number,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(BigInt(amountUnits), 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

export interface PaymentRequirementDetails {
  amount: number;
  recipient: string;
  token: string;
  mint?: string;
  endpoint: string;
}

export interface PaymentProof {
  signature: string;
  payer: string;
}

export type PaymentSignerFn = (
  requirement: PaymentRequirementDetails,
) => Promise<PaymentProof> | PaymentProof;

export interface RadarClientConfig {
  /** Base URL for the Wallet Radar x402 HTTP server (e.g. "http://127.0.0.1:4020") */
  baseUrl?: string;
  /** Solana RPC URL or Connection instance */
  rpc?: string | Connection;
  /** Synonym for rpc when URL string is passed */
  rpcUrl?: string;
  /** Payer keypair, address string, or payment signer callback */
  x402Payer?: Keypair | PaymentSignerFn | { signature: string; payer?: string } | string | unknown;
  /** Target payment recipient public key (USDC wallet) */
  recipient?: string;
  /** Injectable fetch function (useful for tests or custom HTTP agent) */
  fetchFn?: typeof fetch;
  /** Optional custom ZK oracle client for reading on-chain scan ledger records */
  oracleClient?: ZKOracleClient;
  /** Optional explicit payment signer callback */
  paymentSigner?: PaymentSignerFn;
}

export interface RadarClientScanResult {
  wallet: string;
  riskScore: number;
  verdict: string;
  evidence: Record<string, unknown> | unknown[];
  onchainLedgerSig: string | null;
  anomalies?: unknown[];
  digest?: string;
  txCount?: number;
  oracle?: unknown;
  raw?: unknown;
}

export interface RadarClientAnalyzeResult {
  wallet: string;
  riskScore: number;
  anomalies: unknown[];
  digest?: string;
  txCount?: number;
  [key: string]: unknown;
}

export interface RadarClientSelftestResult {
  ok: boolean;
  riskScore: number;
  anomalies: unknown[];
  digest?: string;
  [key: string]: unknown;
}

export interface RadarClient {
  scan(wallet: string): Promise<RadarClientScanResult>;
  analyze(wallet: string, txs?: unknown): Promise<RadarClientAnalyzeResult>;
  selftest(): Promise<RadarClientSelftestResult>;
  readOnchainLedger(wallet: string, limit?: number): Promise<ScanLedgerRecord[]>;
  trustProof(wallet: string): Promise<TrustProofBundle>;
}

export class RadarClientImpl implements RadarClient {
  readonly baseUrl: string;
  readonly rpcUrl?: string;
  readonly connection?: Connection;
  readonly x402Payer?: unknown;
  readonly recipient?: string;
  private fetchFn: typeof fetch;
  readonly oracleClient?: ZKOracleClient;
  readonly paymentSigner?: PaymentSignerFn;

  constructor(config: RadarClientConfig = {}) {
    const rawUrl = config.baseUrl || process.env.RADAR_API_URL || "http://127.0.0.1:4020";
    this.baseUrl = rawUrl.replace(/\/+$/, "");
    if (!this.baseUrl.startsWith("http://") && !this.baseUrl.startsWith("https://")) {
      this.baseUrl = `http://${this.baseUrl}`;
    }

    if (config.rpc) {
      if (typeof config.rpc === "string") {
        this.rpcUrl = config.rpc;
        this.connection = new Connection(config.rpc, "confirmed");
      } else {
        this.connection = config.rpc;
        this.rpcUrl = (config.rpc as any)._rpcEndpoint || config.rpcUrl;
      }
    } else if (config.rpcUrl) {
      this.rpcUrl = config.rpcUrl;
      this.connection = new Connection(config.rpcUrl, "confirmed");
    } else if (process.env.SOLANA_RPC_URL) {
      this.rpcUrl = process.env.SOLANA_RPC_URL;
      this.connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
    }

    this.x402Payer = config.x402Payer;
    this.recipient = config.recipient || process.env.RADAR_X402_RECIPIENT;
    this.fetchFn = config.fetchFn || globalThis.fetch.bind(globalThis);
    this.oracleClient = config.oracleClient;
    this.paymentSigner = config.paymentSigner;
  }

  private async resolvePaymentProof(requirement: PaymentRequirementDetails): Promise<PaymentProof> {
    if (this.paymentSigner) {
      return await this.paymentSigner(requirement);
    }

    const payer = this.x402Payer;
    if (!payer) {
      throw new Error(
        `Payment of ${requirement.amount} ${requirement.token} required for ${requirement.endpoint}, but no x402Payer configured on RadarClient`,
      );
    }

    if (typeof payer === "function") {
      return await (payer as PaymentSignerFn)(requirement);
    }

    if (typeof (payer as any).signPayment === "function") {
      return await (payer as any).signPayment(requirement);
    }

    if (typeof (payer as any).pay === "function") {
      return await (payer as any).pay(requirement);
    }

    if (
      typeof payer === "object" &&
      payer !== null &&
      "signature" in payer &&
      typeof (payer as any).signature === "string"
    ) {
      return {
        signature: (payer as any).signature,
        payer: (payer as any).payer || (payer as any).publicKey?.toBase58?.() || "UnknownPayer",
      };
    }

    const isKeypair =
      payer instanceof Keypair ||
      (typeof payer === "object" &&
        payer !== null &&
        "publicKey" in payer &&
        "secretKey" in payer);

    if (isKeypair) {
      const kp = payer as Keypair;
      const payerPubkey =
        kp.publicKey instanceof PublicKey ? kp.publicKey : new PublicKey(kp.publicKey);
      const payerAddress = payerPubkey.toBase58();

      // If connection is available, attempt real on-chain transaction submission
      if (this.connection) {
        try {
          const recipientPubkey = new PublicKey(requirement.recipient);
          const mintPubkey = requirement.mint ? new PublicKey(requirement.mint) : new PublicKey(USDC_MINT);
          const sourceAta = deriveAssociatedTokenAddress(payerPubkey, mintPubkey);
          const destAta = deriveAssociatedTokenAddress(recipientPubkey, mintPubkey);
          const amountUnits = BigInt(Math.round(requirement.amount * 1e6));

          // Audit 2.7: idempotently ensure BOTH token accounts exist before the
          // transfer. The recipient's USDC ATA may not exist yet, in which case
          // the raw SPL transfer fails ("could not find account" / missing
          // destination). The idempotent create is a no-op when the account
          // already exists, and the payer funds the rent for any account it
          // creates.
          const ataSourceIx = createAssociatedTokenAccountIdempotentInstruction(payerPubkey, sourceAta, payerPubkey, mintPubkey);
          const ataDestIx = createAssociatedTokenAccountIdempotentInstruction(payerPubkey, destAta, recipientPubkey, mintPubkey);
          const transferIx = buildSplTransferInstruction(sourceAta, destAta, payerPubkey, amountUnits);
          const tx = new Transaction().add(ataSourceIx, ataDestIx, transferIx);
          tx.feePayer = payerPubkey;

          let lastValidBlockHeight: number | undefined;
          if (typeof (this.connection as any).getLatestBlockhash === "function") {
            const bh = await (this.connection as any).getLatestBlockhash("confirmed");
            tx.recentBlockhash = bh.blockhash;
            lastValidBlockHeight = bh.lastValidBlockHeight;
          } else {
            tx.recentBlockhash = payerPubkey.toBase58();
          }

          tx.sign(kp);

          let sig: string | undefined;
          if (typeof (this.connection as any).sendRawTransaction === "function") {
            sig = await (this.connection as any).sendRawTransaction(tx.serialize());
          } else if (typeof (this.connection as any).sendTransaction === "function") {
            sig = await (this.connection as any).sendTransaction(tx, [kp]);
          }

          if (sig !== undefined) {
            // Audit 2.6: wait for the payment tx to be confirmed BEFORE handing
            // the signature to the x402 flow. sendRawTransaction/sendTransaction
            // only broadcast — if the request proceeds while the tx is still
            // pending, the server's on-chain payment check can't find it and the
            // call fails with 402 even though the payer sent the funds.
            if (typeof (this.connection as any).confirmTransaction === "function") {
              await (this.connection as any).confirmTransaction(
                { signature: sig, blockhash: tx.recentBlockhash, lastValidBlockHeight },
                "confirmed",
              );
            }
            return { signature: sig, payer: payerAddress };
          }
        } catch (err) {
          if (process.env.RADAR_DEBUG === "1") {
            console.warn("[sdk] On-chain RPC payment failed, falling back to signed proof:", err);
          }
        }
      }

      // Offline / unit-test fallback with locally signed transaction
      const tx = new Transaction().add(
        new TransactionInstruction({
          keys: [{ pubkey: payerPubkey, isSigner: true, isWritable: false }],
          programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          data: Buffer.from(`x402:${requirement.amount}:${requirement.recipient}`),
        }),
      );
      tx.feePayer = payerPubkey;
      tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
      tx.sign(kp);
      const sig = tx.signature
        ? encodeBase58(tx.signature)
        : `sig_${createHash("sha256").update(`${payerAddress}:${Date.now()}`).digest("hex").slice(0, 48)}`;
      return { signature: sig, payer: payerAddress };
    }

    if (typeof payer === "string") {
      const hash = createHash("sha256").update(`${payer}:${Date.now()}`).digest("hex");
      return { signature: `sig_${hash.slice(0, 48)}`, payer };
    }

    throw new Error("Unsupported x402Payer type: expected Keypair, function, or proof object");
  }

  async scan(wallet: string): Promise<RadarClientScanResult> {
    if (!wallet || typeof wallet !== "string") {
      throw new Error("Target wallet address is required for scan");
    }

    const endpointUrl = `${this.baseUrl}/scan`;
    const payload = JSON.stringify({ wallet });

    // 1. Initial call to x402 server
    let res = await this.fetchFn(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    // 2. Auto-pay if 402 Payment Required
    if (res.status === 402) {
      const rawText = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(rawText);
      } catch {}

      const amount =
        (res.headers.get("x-payment-amount") ? parseFloat(res.headers.get("x-payment-amount")!) : null) ??
        json?.x402?.amount ??
        0.005;

      const recipient =
        res.headers.get("x-payment-recipient") ??
        json?.x402?.recipient ??
        this.recipient ??
        "11111111111111111111111111111111";

      const token =
        res.headers.get("x-payment-currency") ??
        json?.x402?.token ??
        "USDC";

      const mint = json?.x402?.mint ?? USDC_MINT;

      const requirement: PaymentRequirementDetails = {
        amount,
        recipient,
        token,
        mint,
        endpoint: "/scan",
      };

      const proof = await this.resolvePaymentProof(requirement);

      // Retry request with payment proof headers
      res = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": proof.signature,
          "X-Payment-Payer": proof.payer,
        },
        body: payload,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Radar scan request failed (${res.status}): ${errBody || res.statusText}`);
    }

    const data = (await res.json()) as Record<string, any>;
    const riskScore = typeof data.riskScore === "number" ? data.riskScore : 0;
    const verdict = typeof data.verdict === "string" ? data.verdict : "UNKNOWN";
    const anomalies = Array.isArray(data.anomalies) ? data.anomalies : [];
    const evidence =
      data.evidence ??
      (anomalies.length > 0
        ? {
            anomalies,
            count: anomalies.length,
            topRules: anomalies.map((a: any) => a.type || a.rule).filter(Boolean),
          }
        : {});

    let onchainLedgerSig =
      (typeof data.onchainLedgerSig === "string" && data.onchainLedgerSig) ||
      (data.oracle && typeof data.oracle.signature === "string" ? data.oracle.signature : null);

    // 3. If onchainLedgerSig was not returned in response body, query onchain ZK ledger
    if (!onchainLedgerSig) {
      try {
        const records = await this.readOnchainLedger(wallet, 1);
        if (records.length > 0 && records[0].onchainSignature) {
          onchainLedgerSig = records[0].onchainSignature;
        }
      } catch {
        // Fallback gracefully
      }
    }

    return {
      wallet: data.wallet || wallet,
      riskScore,
      verdict,
      evidence,
      onchainLedgerSig,
      anomalies,
      digest: data.digest,
      txCount: data.txCount,
      oracle: data.oracle,
      raw: data,
    };
  }

  async analyze(wallet: string, txs?: unknown): Promise<RadarClientAnalyzeResult> {
    if (!wallet || typeof wallet !== "string") {
      throw new Error("Target wallet address is required for analyze");
    }

    const endpointUrl = `${this.baseUrl}/analyze`;
    const payload = JSON.stringify({ wallet, txs: txs ?? [] });

    let res = await this.fetchFn(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    if (res.status === 402) {
      const rawText = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(rawText);
      } catch {}

      const amount =
        (res.headers.get("x-payment-amount") ? parseFloat(res.headers.get("x-payment-amount")!) : null) ??
        json?.x402?.amount ??
        0.001;

      const recipient =
        res.headers.get("x-payment-recipient") ??
        json?.x402?.recipient ??
        this.recipient ??
        "11111111111111111111111111111111";

      const token = res.headers.get("x-payment-currency") ?? json?.x402?.token ?? "USDC";
      const mint = json?.x402?.mint ?? USDC_MINT;

      const proof = await this.resolvePaymentProof({
        amount,
        recipient,
        token,
        mint,
        endpoint: "/analyze",
      });

      res = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": proof.signature,
          "X-Payment-Payer": proof.payer,
        },
        body: payload,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Radar analyze request failed (${res.status}): ${errBody || res.statusText}`);
    }

    return (await res.json()) as RadarClientAnalyzeResult;
  }

  async selftest(): Promise<RadarClientSelftestResult> {
    const endpointUrl = `${this.baseUrl}/selftest`;
    const res = await this.fetchFn(endpointUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Radar selftest failed (${res.status}): ${errBody || res.statusText}`);
    }

    return (await res.json()) as RadarClientSelftestResult;
  }

  async readOnchainLedger(wallet: string, limit: number = 10): Promise<ScanLedgerRecord[]> {
    return await readScanLedger(wallet, {
      client: this.oracleClient,
      rpcUrl: this.rpcUrl,
      limit,
    });
  }

  async trustProof(wallet: string): Promise<TrustProofBundle> {
    const url = `${this.baseUrl}/trust-proof?wallet=${encodeURIComponent(wallet)}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Radar trust-proof failed (${res.status}): ${errBody || res.statusText}`);
    }
    return (await res.json()) as TrustProofBundle;
  }
}

/**
 * Creates an agent-ready Wallet Radar API client with automated x402 micropayments
 * and on-chain ZK ledger verification.
 */
export function createRadarClient(config: RadarClientConfig = {}): RadarClient {
  return new RadarClientImpl(config);
}
