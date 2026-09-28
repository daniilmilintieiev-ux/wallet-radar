import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { readScanLedger, ScanLedgerRecord, ZKOracleClient } from "../oracle/index.js";
import { USDC_MINT } from "../types.js";
import { signPaymentProof } from "../x402server.js";
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
  targetWallet?: string;
  includeMemo?: boolean;
}

export interface PaymentProof {
  signature: string;
  payer: string;
  proofSignature?: string;
  timestamp?: number;
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
  /** When true, falls back to offline signed proof if RPC payment fails. Default is false (rethrows real RPC errors). */
  offlineFallback?: boolean;
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

export interface RadarClientTrustOptions {
  /** Maximum acceptable risk score (0-100, default 30) */
  maxRisk?: number;
  /** Minimum acceptable liquidity in USD (default 50) */
  minLiquidityUsd?: number;
  /** Behavioral risk evaluation window in days (default 7) */
  windowDays?: number;
  /** Allow verified multisigs / smart accounts without flagging PDA hold */
  allowSmartAccounts?: boolean;
}

export interface RadarClientTrustResult {
  wallet: string;
  verdict: "safe" | "hold" | "unknown";
  reasons: string[];
  riskScore: number | null;
  anomalies: unknown[];
  liquidityUsd: number;
  balances: { sol: number; usdc: number; usdt: number } | null;
  solPrice: number | null;
  medianSwapAmountUsd: number | null;
  recommendation?: string;
  [key: string]: unknown;
}

export interface RadarClientBatchResult {
  safe: RadarClientTrustResult[];
  hold: RadarClientTrustResult[];
  unknown: RadarClientTrustResult[];
  shortlist?: {
    safe: RadarClientTrustResult[];
    hold: RadarClientTrustResult[];
    unknown: RadarClientTrustResult[];
  };
  [key: string]: unknown;
}

export interface RadarClientSimulateInput {
  wallet: string;
  amountUsd: number;
  token?: "usdc" | "sol" | "usdt";
  balances?: { sol?: number; usdc?: number; usdt?: number };
  maxRisk?: number;
  minLiquidityUsd?: number;
  mint?: string;
}

export interface RadarClientSimulateResult {
  decision: {
    action: "allow" | "throttle" | "block" | "manual_review";
    maxPaymentUsd?: number;
    recommendedDelaySec?: number;
    reasons: string[];
  };
  exceedsLiquidity: boolean;
  liquidityAfterUsd: number;
  riskDelta: number;
  projectedRiskScore: number | null;
  wouldTrigger: string[];
  recommendation: string;
  safeToExecute: boolean;
  tieredLimits?: any;
  executionTier?: "instant" | "standard" | "guarded" | "blocked" | "ceiling_exceeded";
  suggestedCooldownSec?: number;
  slippageToleranceBps?: number;
  [key: string]: unknown;
}

export interface GateCopyParams {
  /** Target trader or counterparty wallet to copy or pay */
  targetWallet?: string;
  /** Leader wallet alias for targetWallet */
  leaderWallet?: string;
  /** Generic wallet alias */
  wallet?: string;
  /** Proposed trade or copy amount in USD (e.g. 50 USD) */
  copyAmountUsd?: number;
  /** Amount in USD alias for copyAmountUsd */
  amountUsd?: number;
  /** Optional mint of token being bought or traded (evaluated for honeypot/freeze authority) */
  mint?: string;
  /** Max acceptable risk score (0-100, default 30) */
  maxRisk?: number;
  /** Minimum acceptable liquidity in USD (default 50) */
  minLiquidityUsd?: number;
}

export interface GateCopyVerdict {
  /** True if the trade/copy is safe to execute */
  allow: boolean;
  /** Human-readable explanation of the verdict */
  reason: string;
  /** Recommended action */
  action: "allow" | "throttle" | "block" | "manual_review";
  /** Current behavioral risk score of the target (0-100) */
  riskScore: number | null;
  /** Max safe payment or copy size in USD */
  maxSafeAmountUsd: number;
  /** Matched execution tier: instant, standard, guarded, blocked, or ceiling_exceeded */
  executionTier?: string;
  /** Recommended slippage tolerance in basis points (e.g. 100 bps = 1%) */
  slippageToleranceBps?: number;
  /** Recommended delay or cooldown in seconds before next copy */
  cooldownSec?: number;
  /** Raw trust and simulation details */
  details: {
    trust?: RadarClientTrustResult;
    simulation?: RadarClientSimulateResult;
  };
}

export class RadarClient {
  readonly baseUrl: string;
  readonly rpcUrl?: string;
  readonly connection?: Connection;
  readonly x402Payer?: unknown;
  readonly recipient?: string;
  private fetchFn: typeof fetch;
  readonly oracleClient?: ZKOracleClient;
  readonly paymentSigner?: PaymentSignerFn;
  readonly offlineFallback: boolean;

  constructor(config: RadarClientConfig = {}) {
    this.offlineFallback = config.offlineFallback ?? false;
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

      const authProof = requirement.targetWallet
        ? signPaymentProof({ targetWallet: requirement.targetWallet }, kp)
        : undefined;

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

          // Audit 1.1: If requested, bind the transfer with an on-chain Memo instruction
          if (requirement.includeMemo && requirement.targetWallet) {
            tx.add(
              new TransactionInstruction({
                keys: [{ pubkey: payerPubkey, isSigner: true, isWritable: false }],
                programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
                data: Buffer.from(`RadarScan:${requirement.targetWallet}`),
              }),
            );
          }

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
            return {
              signature: sig,
              payer: payerAddress,
              ...(authProof ? { proofSignature: authProof.proofSignature, timestamp: authProof.timestamp } : {}),
            };
          }
        } catch (err) {
          if (!this.offlineFallback) {
            throw new Error(`On-chain payment transaction failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
          }
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
      return {
        signature: sig,
        payer: payerAddress,
        ...(authProof ? { proofSignature: authProof.proofSignature, timestamp: authProof.timestamp } : {}),
      };
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
        targetWallet: wallet,
      };

      const proof = await this.resolvePaymentProof(requirement);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Payment-Signature": proof.signature,
        "X-Payment-Payer": proof.payer,
      };
      if (proof.proofSignature) headers["X-Payment-Proof"] = proof.proofSignature;
      if (proof.timestamp !== undefined) headers["X-Payment-Timestamp"] = String(proof.timestamp);

      // Retry request with payment proof headers
      res = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers,
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
        targetWallet: wallet,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Payment-Signature": proof.signature,
        "X-Payment-Payer": proof.payer,
      };
      if (proof.proofSignature) headers["X-Payment-Proof"] = proof.proofSignature;
      if (proof.timestamp !== undefined) headers["X-Payment-Timestamp"] = String(proof.timestamp);

      res = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers,
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

  async trust(wallet: string, options: RadarClientTrustOptions = {}): Promise<RadarClientTrustResult> {
    if (!wallet || typeof wallet !== "string") {
      throw new Error("Target wallet address is required for trust check");
    }

    const endpointUrl = `${this.baseUrl}/trust`;
    const payload = JSON.stringify({ wallet, ...options });

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
        0.005;

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
        endpoint: "/trust",
        targetWallet: wallet,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Payment-Signature": proof.signature,
        "X-Payment-Payer": proof.payer,
      };
      if (proof.proofSignature) headers["X-Payment-Proof"] = proof.proofSignature;
      if (proof.timestamp !== undefined) headers["X-Payment-Timestamp"] = String(proof.timestamp);

      res = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers,
        body: payload,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Radar trust request failed (${res.status}): ${errBody || res.statusText}`);
    }

    return (await res.json()) as RadarClientTrustResult;
  }

  async batch(wallets: string[], options: RadarClientTrustOptions = {}): Promise<RadarClientBatchResult> {
    if (!Array.isArray(wallets) || wallets.length === 0) {
      throw new Error("wallets array must be non-empty for batch trust check");
    }

    const endpointUrl = `${this.baseUrl}/batch`;
    const payload = JSON.stringify({ wallets, ...options });

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
        0.01;

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
        endpoint: "/batch",
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Payment-Signature": proof.signature,
        "X-Payment-Payer": proof.payer,
      };
      if (proof.proofSignature) headers["X-Payment-Proof"] = proof.proofSignature;
      if (proof.timestamp !== undefined) headers["X-Payment-Timestamp"] = String(proof.timestamp);

      res = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers,
        body: payload,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Radar batch trust request failed (${res.status}): ${errBody || res.statusText}`);
    }

    return (await res.json()) as RadarClientBatchResult;
  }

  async simulate(input: RadarClientSimulateInput): Promise<RadarClientSimulateResult> {
    if (!input || !input.wallet || typeof input.wallet !== "string") {
      throw new Error("Target wallet address is required for simulation");
    }
    if (typeof input.amountUsd !== "number" || !Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
      throw new Error("amountUsd must be a positive number for simulation");
    }

    const endpointUrl = `${this.baseUrl}/simulate`;
    const payload = JSON.stringify({
      wallet: input.wallet,
      amountUsd: input.amountUsd,
      token: input.token ?? "usdc",
      balances: input.balances ?? { sol: 0, usdc: 0, usdt: 0 },
      maxRisk: input.maxRisk,
      minLiquidityUsd: input.minLiquidityUsd,
    });

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
        0.005;

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
        endpoint: "/simulate",
        targetWallet: input.wallet,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Payment-Signature": proof.signature,
        "X-Payment-Payer": proof.payer,
      };
      if (proof.proofSignature) headers["X-Payment-Proof"] = proof.proofSignature;
      if (proof.timestamp !== undefined) headers["X-Payment-Timestamp"] = String(proof.timestamp);

      res = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers,
        body: payload,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Radar simulate request failed (${res.status}): ${errBody || res.statusText}`);
    }

    return (await res.json()) as RadarClientSimulateResult;
  }

  async gateCopy(params: GateCopyParams): Promise<GateCopyVerdict> {
    const targetWallet = params.targetWallet || params.leaderWallet || params.wallet;
    const copyAmountUsd = params.copyAmountUsd ?? params.amountUsd;
    const { mint, maxRisk = 30, minLiquidityUsd = 50 } = params;
    if (!targetWallet) {
      return {
        allow: false,
        reason: "Target wallet address is required",
        action: "block",
        riskScore: null,
        maxSafeAmountUsd: 0,
        details: {},
      };
    }

    // 1. Run behavioral trust check
    const trustRes = await this.trust(targetWallet, { maxRisk, minLiquidityUsd });

    // If behavioral trust failed (e.g. rug pull, high risk score, PDA)
    if (trustRes.verdict === "hold") {
      const reasonsStr = trustRes.reasons?.length > 0 ? trustRes.reasons.join("; ") : "Risk or liquidity thresholds exceeded";
      return {
        allow: false,
        reason: `BLOCKED by pre-trade firewall: ${reasonsStr}`,
        action: "block",
        riskScore: trustRes.riskScore,
        maxSafeAmountUsd: 0,
        executionTier: "blocked",
        details: { trust: trustRes },
      };
    }

    if (trustRes.verdict === "unknown") {
      return {
        allow: false,
        reason: "HOLD: insufficient historical data or unverified balance to establish trust baseline",
        action: "manual_review",
        riskScore: trustRes.riskScore,
        maxSafeAmountUsd: 0,
        details: { trust: trustRes },
      };
    }

    // 2. If copyAmountUsd specified, run pre-trade What-If simulation
    let simRes: RadarClientSimulateResult | undefined;
    if (copyAmountUsd !== undefined && copyAmountUsd > 0) {
      simRes = await this.simulate({
        wallet: targetWallet,
        amountUsd: copyAmountUsd,
        balances: trustRes.balances ?? undefined,
        maxRisk,
        minLiquidityUsd,
        mint,
      });

      const simAction = (simRes.decision as any)?.action ?? (simRes.decision as any)?.verdict;
      const isBlocked = simAction === "block" || simRes.executionTier === "blocked" || (simRes.wouldTrigger && simRes.wouldTrigger.includes("TOXIC_MINT"));
      const isThrottled = !isBlocked && (simAction === "throttle" || simRes.executionTier === "guarded");

      if (isBlocked) {
        return {
          allow: false,
          reason: simRes.recommendation || `BLOCKED: simulated payment exceeds risk capacity (${(simRes.decision as any)?.reasons?.join("; ") || "unacceptable risk"})`,
          action: "block",
          riskScore: simRes.projectedRiskScore ?? trustRes.riskScore,
          maxSafeAmountUsd: 0,
          executionTier: "blocked",
          slippageToleranceBps: 0,
          cooldownSec: simRes.suggestedCooldownSec ?? (simRes.decision?.recommendedDelaySec ?? 300),
          details: { trust: trustRes, simulation: simRes },
        };
      }

      if (isThrottled) {
        const maxSafe = (simRes.decision as any)?.suggestedLimitUsd ?? (simRes.decision as any)?.maxPaymentUsd ?? simRes.tieredLimits?.guarded?.maxAmountUsd ?? simRes.tieredLimits?.standard?.maxAmountUsd ?? copyAmountUsd;
        return {
          allow: true,
          reason: `THROTTLED: ${simRes.recommendation || "payment permitted up to tiered limit"}`,
          action: "throttle",
          riskScore: simRes.projectedRiskScore ?? trustRes.riskScore,
          maxSafeAmountUsd: maxSafe,
          executionTier: simRes.executionTier ?? "guarded",
          slippageToleranceBps: simRes.slippageToleranceBps ?? 50,
          cooldownSec: simRes.suggestedCooldownSec ?? ((simRes.decision as any)?.recommendedDelaySec ?? 60),
          details: { trust: trustRes, simulation: simRes },
        };
      }

      if (!simRes.safeToExecute) {
        return {
          allow: false,
          reason: simRes.recommendation || `HOLD: simulated payment cannot be safely executed as requested`,
          action: "manual_review",
          riskScore: simRes.projectedRiskScore ?? trustRes.riskScore,
          maxSafeAmountUsd: (simRes.decision as any)?.suggestedLimitUsd ?? (simRes.decision as any)?.maxPaymentUsd ?? 0,
          executionTier: simRes.executionTier ?? "standard",
          slippageToleranceBps: simRes.slippageToleranceBps ?? 50,
          cooldownSec: simRes.suggestedCooldownSec ?? 60,
          details: { trust: trustRes, simulation: simRes },
        };
      }
    }

    // Safe to execute!
    const safeMax = copyAmountUsd ?? (simRes?.tieredLimits?.standard?.maxAmountUsd ?? (trustRes.liquidityUsd > 0 ? Math.round(trustRes.liquidityUsd * 0.2 * 100) / 100 : 100));
    return {
      allow: true,
      reason: `VERIFIED_SAFE: risk ${trustRes.riskScore ?? 0} <= ${maxRisk}, liquidity $${trustRes.liquidityUsd} >= $${minLiquidityUsd}${simRes?.executionTier ? ` (Tier: ${simRes.executionTier.toUpperCase()})` : ""}`,
      action: "allow",
      riskScore: trustRes.riskScore,
      maxSafeAmountUsd: safeMax,
      executionTier: simRes?.executionTier ?? "instant",
      slippageToleranceBps: simRes?.slippageToleranceBps ?? 100,
      cooldownSec: simRes?.suggestedCooldownSec ?? 0,
      details: { trust: trustRes, simulation: simRes },
    };
  }
}

/**
 * Creates an agent-ready Wallet Radar API client with automated x402 micropayments
 * and on-chain ZK ledger verification.
 */
export function createRadarClient(config: RadarClientConfig = {}): RadarClient {
  return new RadarClient(config);
}

export { RadarClient as RadarClientImpl };
