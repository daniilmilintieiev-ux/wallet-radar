import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";
import { buildEnvHookBridge } from "./hook/index.js";
import { detectAnomalies, computeRiskScore } from "./analyzer.js";
import { updateBaseline, resolveScoringBaseline } from "./baseline.js";
import { digestAnomalies } from "./digest.js";
import { fetchWalletTransactions } from "./collector.js";
import { fetchSwapPrices } from "./pricing.js";
import { fetchSwapMintRisk } from "./mint.js";
import { Store } from "./store.js";
import { getVersion, loadEnv } from "./mcp-server.js";
import { Baseline, EnhancedTx, SettledPayment, USDC_MINT } from "./types.js";
import { commitScan, ZKOracleClient, ScanLedgerRecord } from "./oracle/index.js";
import { computeVerdict } from "./htmlreport.js";
import { handleBlinkHttpRequest } from "./blink/index.js";
import { handleDashboardHttpRequest } from "./dashboard.js";
import { isValidBase58, validateConfig } from "./config.js";
import { recordHeliusCost, recordOracleCommitCost } from "./economics.js";
import { buildTrustProof } from "./trust-proof.js";
import { clientIp, createRateLimiter, applyDefense } from "./http-server.js";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Pricing in USDC per endpoint matching AgenticTrade manifest. */
export const X402_PRICING: Record<string, number> = {
  "/scan": Number(process.env.RADAR_SCAN_PRICE_USDC || 0.005),
  "/analyze": 0.001,
  "/selftest": 0.0,
};

export interface PaymentProof {
  signature: string;
  payer: string;
  proofSignature?: string;
  timestamp?: number;
}

export interface PaymentRequirement {
  endpoint: string;
  recipient: string;
  minAmount: number;
  maxAgeSec?: number;
  mint?: string;
  targetWallet?: string;
}

/** Ed25519 SPKI DER prefix for a raw 32-byte public key */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Ed25519 PKCS8 DER prefix for a raw 32-byte private-key seed */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function buildPaymentMessage(targetWallet: string, timestamp?: number): Buffer {
  const msg = timestamp ? `RadarScan:${targetWallet}:${timestamp}` : `RadarScan:${targetWallet}`;
  return Buffer.from(msg, "utf-8");
}

/**
 * Signs a payment authorization proof with the payer's Keypair (Audit 1.1).
 * Binds the on-chain transfer to the specific target wallet and freshness timestamp,
 * preventing mempool front-running or payment hijacking.
 */
export function signPaymentProof(
  params: { targetWallet: string; timestamp?: number },
  signer: Keypair,
): { proofSignature: string; timestamp: number } {
  const ts = params.timestamp ?? Math.floor(Date.now() / 1000);
  const msg = buildPaymentMessage(params.targetWallet, ts);
  const seed = Buffer.from(signer.secretKey).subarray(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const sig = cryptoSign(null, msg, privateKey);
  return {
    proofSignature: bs58.encode(sig),
    timestamp: ts,
  };
}

/**
 * Verifies that the payment proof was cryptographically authorized by `payer` for `targetWallet`.
 */
export function verifyPaymentProof(
  proof: { payer: string; proofSignature: string; timestamp?: number },
  targetWallet: string,
  maxAgeSec: number = 300,
): boolean {
  if (!proof.proofSignature || !proof.payer || !targetWallet) return false;
  if (proof.timestamp) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - proof.timestamp) > maxAgeSec) return false;
  }
  try {
    const signatureBytes = bs58.decode(proof.proofSignature);
    const publicKeyBytes = new PublicKey(proof.payer).toBuffer();
    if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    if (proof.timestamp) {
      const msgWithTs = buildPaymentMessage(targetWallet, proof.timestamp);
      if (cryptoVerify(null, msgWithTs, key, Buffer.from(signatureBytes))) return true;
    }
    const msgPlain = buildPaymentMessage(targetWallet);
    return cryptoVerify(null, msgPlain, key, Buffer.from(signatureBytes));
  } catch {
    return false;
  }
}

export interface PaymentVerificationResult {
  valid: boolean;
  error?: string;
  amount?: number;
  payer?: string;
  recipient?: string;
}

export type PaymentVerifier = (
  proof: PaymentProof,
  requirement: PaymentRequirement,
) => Promise<PaymentVerificationResult>;

export interface X402ServerOptions {
  port?: number;
  host?: string;
  store?: Store;
  dbPath?: string;
  recipient?: string;
  rpcUrl?: string;
  maxAgeSec?: number;
  paymentVerifier?: PaymentVerifier;
  scanHandler?: (wallet: string) => Promise<unknown>;
  analyzeHandler?: (wallet: string, txs: EnhancedTx[] | string) => Promise<unknown>;
  selftestHandler?: () => Promise<unknown>;
  oracleClient?: ZKOracleClient;
  commitScanFn?: typeof commitScan;
  enableOracle?: boolean;
  rateLimitPerMin?: number;
  /**
   * Audit 2.3: oracle→hook bridge — after an oracle commit on /scan, publish
   * the fresh verdict to the destination wallet's on-chain hook scan-record
   * PDA. Best-effort; a failure never fails the scan.
   */
  hookBridge?: (record: {
    wallet: string;
    riskScore: number;
    verdict: string;
    timestamp: number;
  }) => Promise<Record<string, unknown>>;
  connection?: Connection;
  recentBlockhash?: string;
  /**
   * When true, ZK oracle commits and transfer hook bridge updates execute
   * in the background, preventing slow upstream RPC confirmations from
   * blocking the HTTP response (Audit 3.1).
   */
  asyncCommit?: boolean;
  /**
   * When true, allows test/mock payments when no RPC endpoint is configured.
   */
  allowMockPayments?: boolean;
}

function getRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return "https://api.mainnet-beta.solana.com";
}

const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;

export async function verifySolanaPaymentRpc(
  proof: PaymentProof,
  requirement: PaymentRequirement,
  rpcUrl: string = getRpcUrl(),
): Promise<PaymentVerificationResult> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "x402-verify",
        method: "getTransaction",
        params: [
          proof.signature,
          {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
      signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { valid: false, error: `RPC HTTP error ${res.status}: ${res.statusText}` };
    }
    const json = (await res.json()) as any;
    if (json.error) {
      return { valid: false, error: `RPC error: ${json.error.message || JSON.stringify(json.error)}` };
    }
    const tx = json.result;
    if (!tx) {
      return { valid: false, error: "Transaction not found on-chain" };
    }
    if (tx.meta?.err) {
      return { valid: false, error: "Transaction failed on-chain" };
    }

    // Enforce a freshness window even when the caller does not pass
    // maxAgeSec (audit 1.3: production startup left it undefined, so the
    // check was never executed).
    const maxAgeSec = requirement.maxAgeSec ?? 300;

    // Audit 1.1 & 1.3: Front-running and hijacking protection via cryptographic proof or on-chain memo binding
    if (requirement.targetWallet) {
      let boundToTarget = false;

      if (proof.proofSignature) {
        const proofValid = verifyPaymentProof(
          { payer: proof.payer, proofSignature: proof.proofSignature, timestamp: proof.timestamp },
          requirement.targetWallet,
          maxAgeSec,
        );
        if (!proofValid) {
          return {
            valid: false,
            error: `Invalid X-Payment-Proof: signature does not verify for payer ${proof.payer} and targetWallet ${requirement.targetWallet}`,
          };
        }
        boundToTarget = true;
      }

      // Audit 1.1 & 1.3: If transaction carries an SPL memo, verify whether it matches targetWallet
      const inspectMemos = (insts: any[]) => {
        let matching = false;
        let mismatched: string | null = null;
        for (const inst of insts) {
          if (
            (inst.program === "spl-memo" || inst.programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") &&
            typeof inst.parsed === "string"
          ) {
            const memoStr = inst.parsed;
            if (memoStr.startsWith("RadarScan:")) {
              const parts = memoStr.split(":");
              const memoTarget = parts[1];
              if (memoTarget) {
                if (memoTarget === requirement.targetWallet) {
                  matching = true;
                } else if (!mismatched) {
                  mismatched = memoTarget;
                }
              }
            }
          }
        }
        return { matching, mismatched };
      };

      let memoRes = { matching: false, mismatched: null as string | null };
      if (Array.isArray(tx.transaction?.message?.instructions)) {
        memoRes = inspectMemos(tx.transaction.message.instructions);
      }
      if (!memoRes.matching && !memoRes.mismatched && Array.isArray(tx.meta?.innerInstructions)) {
        for (const inner of tx.meta.innerInstructions) {
          if (Array.isArray(inner.instructions)) {
            const innerRes = inspectMemos(inner.instructions);
            if (innerRes.matching) memoRes.matching = true;
            if (innerRes.mismatched && !memoRes.mismatched) memoRes.mismatched = innerRes.mismatched;
            if (memoRes.matching || memoRes.mismatched) break;
          }
        }
      }

      if (memoRes.mismatched) {
        return {
          valid: false,
          error: `Payment memo mismatch: on-chain memo bound to ${memoRes.mismatched}, but scan requested for ${requirement.targetWallet}`,
        };
      }
      if (memoRes.matching) {
        boundToTarget = true;
      }

      // Audit 1.3: If neither X-Payment-Proof nor matching on-chain memo binds the payment to targetWallet,
      // reject to prevent front-running/hijacking by an eavesdropping attacker in mempool/blocks.
      if (!boundToTarget) {
        return {
          valid: false,
          error: `Payment unbound: scan for targetWallet ${requirement.targetWallet} requires a valid X-Payment-Proof or matching on-chain RadarScan:${requirement.targetWallet} memo`,
        };
      }
    }

    // Payer must be an actual on-chain signer of the payment transaction,
    // otherwise any third-party transfer to the recipient could be replayed
    // as a valid x402 payment (audit 1.3).
    const accountKeys = tx.transaction?.message?.accountKeys;
    if (Array.isArray(accountKeys) && accountKeys.length > 0) {
      const payerIsSigner = accountKeys.some((k: any) => {
        if (typeof k === "string") return k === proof.payer;
        const pk =
          typeof k?.pubkey === "string"
            ? k.pubkey
            : typeof k?.pubkey?.toBase58 === "function"
              ? k.pubkey.toBase58()
              : typeof k?.toBase58 === "function"
                ? k.toBase58()
                : null;
        return pk === proof.payer && (k.signer === true || k.isSigner === true);
      });
      if (!payerIsSigner) {
        return {
          valid: false,
          error: `X-Payment-Payer ${proof.payer} is not a signer of the payment transaction`,
        };
      }
    }

    if (tx.blockTime) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - tx.blockTime > maxAgeSec) {
        return {
          valid: false,
          error: `Transaction too old (${nowSec - tx.blockTime}s ago, max allowed ${maxAgeSec}s)`,
        };
      }
    }

    let transferred = 0;
    const targetMint = requirement.mint ?? USDC_MINT;
    const preTokenBalances = (tx.meta?.preTokenBalances || []) as any[];
    const postTokenBalances = (tx.meta?.postTokenBalances || []) as any[];

    // 1. Balance delta inspection for recipient
    for (const post of postTokenBalances) {
      if (post.owner === requirement.recipient && (post.mint ? post.mint === targetMint : false)) {
        const pre = preTokenBalances.find((b: any) => b.accountIndex === post.accountIndex);
        const preAmount = Number(pre?.uiTokenAmount?.uiAmount || 0);
        const postAmount = Number(post?.uiTokenAmount?.uiAmount || 0);
        const delta = postAmount - preAmount;
        if (delta > 0) transferred += delta;
      }
    }

    // 2. Parsed instructions fallback (Audit 3.3: resolve recipient's ATA accounts)
    if (transferred === 0) {
      const recipientAccounts = new Set<string>();
      if (requirement.recipient) recipientAccounts.add(requirement.recipient);

      try {
        const recipientPk = new PublicKey(requirement.recipient);
        const mintPk = new PublicKey(targetMint);
        const [splAta] = PublicKey.findProgramAddressSync(
          [recipientPk.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        recipientAccounts.add(splAta.toBase58());
        const [t22Ata] = PublicKey.findProgramAddressSync(
          [recipientPk.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        recipientAccounts.add(t22Ata.toBase58());
      } catch {
        // Non-standard address or stub in tests: fallback to direct match
      }

      const accountKeysList = tx.transaction?.message?.accountKeys;
      const getAccountKeyStr = (idx: number): string | null => {
        if (!Array.isArray(accountKeysList) || idx < 0 || idx >= accountKeysList.length) return null;
        const k = accountKeysList[idx];
        if (typeof k === "string") return k;
        if (typeof k?.pubkey === "string") return k.pubkey;
        if (typeof k?.pubkey?.toBase58 === "function") return k.pubkey.toBase58();
        if (typeof k?.toBase58 === "function") return k.toBase58();
        return null;
      };

      // Also map accountKeys from postTokenBalances where owner === requirement.recipient
      if (Array.isArray(accountKeysList)) {
        for (const bal of postTokenBalances) {
          if (bal.owner === requirement.recipient && typeof bal.accountIndex === "number" && bal.accountIndex < accountKeysList.length) {
            const keyStr = getAccountKeyStr(bal.accountIndex);
            if (keyStr) recipientAccounts.add(keyStr);
          }
        }
      }

      const inspectInstructions = (insts: any[]) => {
        for (const inst of insts) {
          const parsed = inst.parsed;
          if (parsed && (parsed.type === "transfer" || parsed.type === "transferChecked")) {
            const info = parsed.info;
            if (info) {
              // Audit 1.2: reject transfers with non-target mint
              if (info.mint && info.mint !== targetMint) {
                continue;
              }
              // Audit 1.4: If token balances are recorded for destination, verify its mint matching destination specifically
              let destBalance: any = undefined;
              if (postTokenBalances.length > 0 && info.destination) {
                destBalance = postTokenBalances.find((b: any) => {
                  const accKey = typeof b.accountIndex === "number" ? getAccountKeyStr(b.accountIndex) : null;
                  if (accKey && accKey === info.destination) return true;
                  if (b.owner && recipientAccounts.has(b.owner) && accKey === info.destination) return true;
                  return false;
                });
                if (destBalance && destBalance.mint && destBalance.mint !== targetMint) {
                  continue;
                }
              }
              // Bug 5: Resolve decimals dynamically instead of hardcoded 1e6
              const decimals =
                typeof info.tokenAmount?.decimals === "number"
                  ? info.tokenAmount.decimals
                  : (destBalance && typeof destBalance.uiTokenAmount?.decimals === "number")
                    ? destBalance.uiTokenAmount.decimals
                    : (targetMint === "So11111111111111111111111111111111111111112" ? 9 : 6);
              const amount = Number(
                info.tokenAmount?.uiAmount ??
                  (info.amount ? Number(info.amount) / Math.pow(10, decimals) : 0),
              );
              if (info.destination && recipientAccounts.has(info.destination)) {
                transferred += amount;
              }
            }
          }
        }
      };

      if (Array.isArray(tx.transaction?.message?.instructions)) {
        inspectInstructions(tx.transaction.message.instructions);
      }
      if (Array.isArray(tx.meta?.innerInstructions)) {
        for (const inner of tx.meta.innerInstructions) {
          if (Array.isArray(inner.instructions)) inspectInstructions(inner.instructions);
        }
      }
    }

    // Round to 6 decimal places (micro-USDC precision) to prevent floating point representation artifacts
    transferred = Math.round(transferred * 1e6) / 1e6;

    if (transferred < requirement.minAmount) {
      return {
        valid: false,
        error: `Insufficient payment: found ${transferred} USDC, required ${requirement.minAmount} USDC`,
        amount: transferred,
      };
    }

    return {
      valid: true,
      amount: transferred,
      payer: proof.payer,
      recipient: requirement.recipient,
    };
  } catch (err) {
    return { valid: false, error: `Verification exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function extractPaymentProof(req: http.IncomingMessage, body?: any): PaymentProof | null {
  const sigHeader = req.headers["x-payment-signature"];
  const payerHeader = req.headers["x-payment-payer"];
  const proofHeader = req.headers["x-payment-proof"];
  const tsHeader = req.headers["x-payment-timestamp"];

  const proofSig = typeof proofHeader === "string" && proofHeader.trim() ? proofHeader.trim() : undefined;
  const ts = typeof tsHeader === "string" && !isNaN(Number(tsHeader)) ? Number(tsHeader) : undefined;

  if (typeof sigHeader === "string" && typeof payerHeader === "string" && sigHeader.trim() && payerHeader.trim()) {
    return {
      signature: sigHeader.trim(),
      payer: payerHeader.trim(),
      ...(proofSig ? { proofSignature: proofSig } : {}),
      ...(ts !== undefined ? { timestamp: ts } : {}),
    };
  }

  const xPayHeader = req.headers["x-payment"];
  if (typeof xPayHeader === "string" && xPayHeader.trim()) {
    const trimmed = xPayHeader.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.signature && parsed.payer) {
          return {
            signature: String(parsed.signature).trim(),
            payer: String(parsed.payer).trim(),
            ...(parsed.proofSignature || parsed.proof ? { proofSignature: String(parsed.proofSignature || parsed.proof).trim() } : {}),
            ...(parsed.timestamp !== undefined ? { timestamp: Number(parsed.timestamp) } : {}),
          };
        }
      } catch {}
    } else if (trimmed.includes(":")) {
      const parts = trimmed.split(":");
      const [s, p] = parts;
      if (s && p) {
        return {
          signature: s.trim(),
          payer: p.trim(),
          ...(parts[2] ? { proofSignature: parts[2].trim() } : {}),
          ...(parts[3] && !isNaN(Number(parts[3])) ? { timestamp: Number(parts[3]) } : {}),
        };
      }
    }
  }

  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("x402 ")) {
    const token = authHeader.slice(5).trim();
    if (token.includes(":")) {
      const parts = token.split(":");
      const [s, p] = parts;
      if (s && p) {
        return {
          signature: s.trim(),
          payer: p.trim(),
          ...(parts[2] ? { proofSignature: parts[2].trim() } : {}),
          ...(parts[3] && !isNaN(Number(parts[3])) ? { timestamp: Number(parts[3]) } : {}),
        };
      }
    }
  }

  if (body && typeof body === "object" && body.payment) {
    const { signature, payer, proofSignature, proof, timestamp } = body.payment;
    if (signature && payer) {
      return {
        signature: String(signature).trim(),
        payer: String(payer).trim(),
        ...(proofSignature || proof ? { proofSignature: String(proofSignature || proof).trim() } : {}),
        ...(timestamp !== undefined ? { timestamp: Number(timestamp) } : {}),
      };
    }
  }

  return null;
}

export function send402(
  res: http.ServerResponse,
  endpoint: string,
  requiredAmount: number,
  recipient: string,
  detail?: string,
): void {
  res.writeHead(402, {
    "Content-Type": "application/json",
    "X-Payment-Required": "true",
    "X-Payment-Amount": String(requiredAmount),
    "X-Payment-Currency": "USDC",
    "X-Payment-Recipient": recipient,
  });
  res.end(
    JSON.stringify(
      {
        error: "Payment Required",
        ...(detail ? { detail } : {}),
        message: detail
          ? `Payment error for ${endpoint}: ${detail}`
          : `Payment of ${requiredAmount} USDC required for ${endpoint}. Recipient: ${recipient}`,
        x402: {
          version: "1.0",
          network: "solana",
          token: "USDC",
          mint: USDC_MINT,
          recipient,
          amount: requiredAmount,
          units: "USDC",
          proofFormat: {
            headers: {
              "X-Payment-Signature": "<tx_signature>",
              "X-Payment-Payer": "<payer_wallet_address>",
            },
            authHeader: "Authorization: x402 <signature>:<payer>",
            jsonHeader: "X-Payment: {\"signature\":\"...\",\"payer\":\"...\"}",
          },
        },
      },
      null,
      2,
    ),
  );
}

class PayloadTooLargeError extends Error {
  status = 413;
  constructor() {
    super("Payload Too Large");
  }
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new PayloadTooLargeError());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

export function createX402Server(options: X402ServerOptions = {}): http.Server {
  const recipient =
    options.recipient ??
    process.env.RADAR_X402_RECIPIENT ??
    (() => {
      const payer = process.env.RADAR_ORACLE_PAYER;
      if (payer) {
        try {
          return Keypair.fromSecretKey(bs58.decode(payer)).publicKey.toBase58();
        } catch {
          return undefined;
        }
      }
      return undefined;
    })();

  const inFlightPayments = new Set<string>();

  const store =
    options.store ??
    (() => {
      const dbPath = options.dbPath ?? process.env.RADAR_DB ?? path.join(homedir(), ".wallet-radar", "radar.db");
      mkdirSync(path.dirname(dbPath), { recursive: true });
      return new Store(dbPath);
    })();

  const verifier: PaymentVerifier =
    options.paymentVerifier ??
    ((proof, req) => verifySolanaPaymentRpc(proof, req, options.rpcUrl));

  const defaultSelftestHandler = async () => {
    const wallet = "DemoWallet11111111111111111111111111111111";
    const txs: EnhancedTx[] = [
      { signature: "sigA", timestamp: 1_700_000_000, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
      { signature: "sigB", timestamp: 1_700_000_120, source: "JUPITER", programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    ];
    const anomalies = detectAnomalies(wallet, txs, null);
    return { ok: true, riskScore: computeRiskScore(anomalies), anomalies, digest: digestAnomalies(anomalies) };
  };

  const defaultScanHandler = async (wallet: string) => {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      throw new Error("HELIUS_API_KEY is not configured on server");
    }
    const txs = await fetchWalletTransactions(apiKey, wallet);
    const prices = await fetchSwapPrices(txs, { wallet });
    const mintRisk = await fetchSwapMintRisk(txs, { apiKey, wallet });
    const storedBaseline = store.getBaseline(wallet);
    const baseline: Baseline = updateBaseline(wallet, storedBaseline, txs, Date.now() / 1000, prices);
    store.saveBaseline(baseline);
    const scoringBaseline = resolveScoringBaseline(wallet, storedBaseline, txs, prices);
    const anomalies = detectAnomalies(wallet, txs, scoringBaseline, undefined, prices, mintRisk);
    const riskScore = computeRiskScore(anomalies);
    const verdict = computeVerdict(riskScore);
    const txSignatures = txs.map((t) => t.signature).filter(Boolean).slice(0, 10);
    const resultObj: Record<string, unknown> = {
      wallet,
      txCount: txs.length,
      lastSeenAt: baseline.lastSeenAt,
      pnl: baseline.pnl ?? null,
      pricesAvailable: prices !== null,
      priceCount: prices ? Object.keys(prices).length : 0,
      prices,
      riskScore,
      verdict,
      anomalies,
      digest: digestAnomalies(anomalies),
      txSignatures,
    };
    applyDefense(store, { wallet }, resultObj);
    return resultObj;
  };

  const defaultAnalyzeHandler = async (wallet: string, txs: EnhancedTx[] | string) => {
    let parsed: EnhancedTx[];
    if (typeof txs === "string") {
      parsed = JSON.parse(txs);
    } else if (Array.isArray(txs)) {
      parsed = txs;
    } else {
      throw new Error("Invalid txs: expected a JSON array of transaction objects");
    }
    const storedBaseline = isValidBase58(wallet) ? store.getBaseline(wallet) : null;
    const baseline = updateBaseline(wallet, storedBaseline, parsed);
    const scoringBaseline = resolveScoringBaseline(wallet, storedBaseline, parsed);
    const anomalies = detectAnomalies(wallet, parsed, scoringBaseline);
    return {
      wallet,
      txCount: parsed.length,
      riskScore: computeRiskScore(anomalies),
      anomalies,
      digest: digestAnomalies(anomalies),
    };
  };

  const scanHandler = options.scanHandler ?? defaultScanHandler;
  const analyzeHandler = options.analyzeHandler ?? defaultAnalyzeHandler;
  const selftestHandler = options.selftestHandler ?? defaultSelftestHandler;

  const rateLimitPerMin = options.rateLimitPerMin ?? 120;
  const limiter = rateLimitPerMin > 0 ? createRateLimiter(rateLimitPerMin) : null;

  const server = http.createServer(async (req, res) => {
    try {
      const ip = clientIp(req);
      if (limiter) {
        const limit = limiter.check(ip);
        if (!limit.ok) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": String(limit.retryAfterSec ?? 60),
          });
          res.end(JSON.stringify({ error: "Too Many Requests", retryAfterSec: limit.retryAfterSec ?? 60 }));
          return;
        }
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;
      const method = req.method?.toUpperCase() ?? "GET";

      // 0. Solana Actions / Blinks routes (/actions.json, /api/actions/...)
      if (pathname === "/actions.json" || pathname.startsWith("/api/actions")) {
        const handled = await handleBlinkHttpRequest(req, res, {
          baseUrl: `http://${req.headers.host || "localhost"}`,
          recipient,
          rpcUrl: options.rpcUrl,
          connection: options.connection,
          recentBlockhash: options.recentBlockhash,
          scanHandler,
          verifyPayment: async (signature: string, payer: string, targetWallet: string) => {
            if (store.hasSettledPayment(signature)) {
              return { ok: false, reason: "Payment signature already settled (replay rejected)" };
            }
            const activeRecipient = recipient || options.recipient || process.env.RADAR_X402_RECIPIENT;
            if (!activeRecipient) {
              return { ok: false, reason: "Service recipient unconfigured" };
            }
            if (options.paymentVerifier) {
              const verRes = await options.paymentVerifier(
                { signature, payer },
                { endpoint: "/api/actions/radar-scan/complete", recipient: activeRecipient, minAmount: 0.005, targetWallet },
              );
              if (!verRes.valid) {
                return { ok: false, reason: verRes.error || "Payment verification failed" };
              }
              store.recordSettledPayment({
                signature,
                payer: verRes.payer || payer,
                recipient: activeRecipient,
                amount: verRes.amount ?? 0.005,
                endpoint: "/api/actions/radar-scan/complete",
                wallet: targetWallet,
              });
              return { ok: true };
            }
            const rpcTarget =
              options.rpcUrl ||
              options.connection?.rpcEndpoint ||
              process.env.SOLANA_RPC_URL ||
              process.env.HELIUS_RPC_URL ||
              (process.env.HELIUS_API_KEY
                ? "https://mainnet.helius-rpc.com/?api-key=" + process.env.HELIUS_API_KEY
                : undefined);
            if (rpcTarget) {
              const verRes = await verifySolanaPaymentRpc(
                { signature, payer },
                { endpoint: "/api/actions/radar-scan/complete", recipient: activeRecipient, minAmount: 0.005, targetWallet },
                rpcTarget,
              );
              if (!verRes.valid) {
                return { ok: false, reason: verRes.error || "Payment verification failed" };
              }
              store.recordSettledPayment({
                signature,
                payer: verRes.payer || payer,
                recipient: activeRecipient,
                amount: verRes.amount ?? 0.005,
                endpoint: "/api/actions/radar-scan/complete",
                wallet: targetWallet,
              });
              return { ok: true };
            }
            // Audit 1.3: Prevent free scan exploit in production. Reject payment if no RPC verification target is configured.
            // Allow mock fallback only when explicitly enabled or running in test runner without an RPC
            const isMockEnv =
              Boolean(options.allowMockPayments) ||
              process.env.NODE_ENV === "test" ||
              Boolean(process.env.NODE_TEST_CONTEXT);
            if (isMockEnv) {
              store.recordSettledPayment({
                signature,
                payer,
                recipient: activeRecipient,
                amount: 0.005,
                endpoint: "/api/actions/radar-scan/complete",
                wallet: targetWallet,
              });
              return { ok: true };
            }
            return { ok: false, reason: "Payment RPC verification unavailable (no RPC endpoint configured)" };
          },
        });
        if (handled) return;
      }

      // 0.5 Web dashboard and ZK scan ledger (/dashboard, /api/ledger)
      if (pathname === "/dashboard" || pathname === "/api/ledger") {
        const handled = await handleDashboardHttpRequest(req, res, {
          store,
          rpcUrl: options.rpcUrl,
          oracleClient: options.oracleClient,
        });
        if (handled) return;
      }

      if (pathname === "/" || pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            {
              ok: true,
              status: "ok",
              service: "wallet-radar-x402",
              version: getVersion(),
              recipient,
              pricing: X402_PRICING,
              endpoints: {
                "/selftest": { method: "GET", priceUsdc: 0.0, description: "Free smoke test / health check" },
                "/scan": { method: "POST", priceUsdc: 0.005, description: "Live wallet scan with Helius & Jupiter" },
                "/analyze": { method: "POST", priceUsdc: 0.001, description: "Offline anomaly analysis over tx fixture" },
                "/dashboard": { method: "GET", priceUsdc: 0.0, description: "Web dashboard for ZK scan ledger" },
                "/api/ledger": { method: "GET", priceUsdc: 0.0, description: "JSON API for on-chain scan attestations" },
                "/trust-proof": { method: "GET", priceUsdc: 0.0, description: "Independently verifiable attestation bundle" },
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      if (pathname === "/trust-proof") {
        if (method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }
        const wallet = url.searchParams.get("wallet");
        if (!wallet) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "wallet query parameter is required (Solana base58 address)." }));
          return;
        }
        if (!isValidBase58(wallet)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "wallet query parameter must be a Solana base58 address." }));
          return;
        }
        const proof = await buildTrustProof(wallet, {
          oracleClient: options.oracleClient,
          rpcUrl: options.rpcUrl,
          store,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(proof, null, 2));
        return;
      }

      if (pathname === "/selftest") {
        if (method !== "GET" && method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }
        const result = await selftestHandler();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
        return;
      }

      if (pathname === "/scan" || pathname === "/analyze") {
        if (method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }

        const requiredPrice = X402_PRICING[pathname];

        let body: Record<string, unknown> | null = null;
        try {
          const raw = await readBody(req);
          if (raw.trim()) {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "body must be a JSON object" }));
              return;
            }
            body = parsed;
          }
        } catch (err: unknown) {
          if (err instanceof PayloadTooLargeError || (err as { status?: number }).status === 413) {
            res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
            res.end(JSON.stringify({ error: "Payload Too Large" }));
            return;
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        if (requiredPrice > 0 && !recipient) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Configuration Error",
              message: "RADAR_X402_RECIPIENT must be configured for paid endpoints",
            }),
          );
          return;
        }
        const activeRecipient = recipient ?? "";

        // 1. Extract payment proof
        const proof = extractPaymentProof(req, body);
        if (!proof) {
          send402(res, pathname, requiredPrice, activeRecipient);
          return;
        }

        // Reject dry-run / mock payment bypass on paid routes
        if (req.headers["x-payment-dry-run"] === "true") {
          send402(res, pathname, requiredPrice, activeRecipient, "Dry-run payments not allowed on paid routes");
          return;
        }

        // 2. Check replay in settled ledger and in-flight payments
        if (inFlightPayments.has(proof.signature) || store.hasSettledPayment(proof.signature)) {
          send402(res, pathname, requiredPrice, activeRecipient, "Payment signature already settled (replay rejected)");
          return;
        }

        inFlightPayments.add(proof.signature);
        try {
          // 3. Verify payment
          const verResult = await verifier(proof, {
            endpoint: pathname,
            recipient: activeRecipient,
            minAmount: requiredPrice,
            maxAgeSec: options.maxAgeSec,
            mint: USDC_MINT,
            targetWallet: typeof body?.wallet === "string" ? body.wallet : undefined,
          });

          if (!verResult.valid) {
            send402(res, pathname, requiredPrice, activeRecipient, verResult.error || "Payment verification failed");
            return;
          }

          // 3.5. Validate endpoint params BEFORE settling, so a validly-paid
          // request that is missing its parameters 400s without marking the
          // signature settled
          if (pathname === "/scan") {
            if (typeof body?.wallet !== "string" || !isValidBase58(body.wallet)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "body.wallet must be a Solana base58 address" }));
              return;
            }
          } else if (pathname === "/analyze") {
            const wallet = body?.wallet;
            if (!wallet || typeof wallet !== "string" || wallet.length > 64) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required parameters: wallet and txs" }));
              return;
            }
            if (!body?.txs || (!Array.isArray(body.txs) && typeof body.txs !== "string")) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required parameters: wallet and txs" }));
              return;
            }
            if (Array.isArray(body.txs) && body.txs.length > 1000) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "body.txs: at most 1000 transactions allowed" }));
              return;
            }
          }
          if (!body) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing JSON body" }));
            return;
          }

          // 4. Execute endpoint handler FIRST. The payment signature is only
          // marked settled after successful delivery, so a failed request
          // (e.g. upstream RPC outage -> 500) can be retried with the same
          // on-chain payment instead of burning the user's funds (audit 1.4).
          if (pathname === "/scan") {
            const rawScanRes = (await scanHandler(body.wallet as string)) as Record<string, any>;
            recordHeliusCost(store, "/scan");
            const scanRes = typeof rawScanRes === "object" && rawScanRes !== null ? { ...rawScanRes } : rawScanRes;

            if (scanRes && typeof scanRes === "object") {
              const riskScore = typeof scanRes.riskScore === "number" ? scanRes.riskScore : 0;
              const verdict =
                typeof scanRes.verdict === "string" ? scanRes.verdict : computeVerdict(riskScore);
              scanRes.verdict = verdict;

              const isOracleEnabled =
                options.enableOracle ??
                (process.env.RADAR_ORACLE === "1" || options.oracleClient !== undefined);

              if (isOracleEnabled) {
                const executeCommitAndBridge = async () => {
                  try {
                    const anomalies = Array.isArray(scanRes.anomalies) ? scanRes.anomalies : [];
                    const topRules = Array.from(
                      new Set(anomalies.map((a: any) => a.type || a.rule).filter(Boolean)),
                    );
                    const txSignatures = Array.isArray(scanRes.txSignatures)
                      ? scanRes.txSignatures
                      : Array.isArray(scanRes.txs)
                      ? scanRes.txs.map((t: any) => t.signature).filter(Boolean).slice(0, 10)
                      : [];

                    const commitFn = options.commitScanFn ?? commitScan;
                    const commitRes = await commitFn(
                      {
                        wallet: body.wallet as string,
                        riskScore,
                        verdict,
                        timestamp: Math.floor(Date.now() / 1000),
                        topRules,
                        txSignatures,
                      },
                      { client: options.oracleClient, rpcUrl: options.rpcUrl },
                    );

                    if (commitRes.signature) {
                      scanRes.onchainLedgerSig = commitRes.signature;
                      recordOracleCommitCost(store, "/scan");
                    }
                    scanRes.oracle = commitRes;
                  } catch (err) {
                    if (process.env.RADAR_DEBUG === "1") {
                      console.error("[x402] oracle commitScan failed:", err);
                    }
                  }

                  // Audit 2.3: best-effort oracle→hook bridge — publish the fresh
                  // verdict to the destination wallet's on-chain hook scan-record
                  // PDA so the transfer hook gates on the latest scan.
                  if (options.hookBridge) {
                    try {
                      scanRes.hookBridge = await options.hookBridge({
                        wallet: body.wallet as string,
                        riskScore,
                        verdict,
                        timestamp: Math.floor(Date.now() / 1000),
                      });
                    } catch (err) {
                      scanRes.hookBridge = {
                        success: false,
                        error: err instanceof Error ? err.message : String(err),
                      };
                      if (process.env.RADAR_DEBUG === "1") {
                        console.error("[x402] hook bridge failed:", err);
                      }
                    }
                  }
                };

                const preferHeader = req.headers["prefer"];
                const isAsync =
                  options.asyncCommit ??
                  (preferHeader === "respond-async" || process.env.RADAR_ASYNC_COMMIT === "1");

                if (isAsync) {
                  scanRes.asyncCommit = true;
                  scanRes.onchainLedgerStatus = "pending";
                  scanRes.oracle = { status: "pending", async: true };
                  void executeCommitAndBridge().catch((err) => {
                    if (process.env.RADAR_DEBUG === "1") console.error("[x402] background commit failed:", err);
                  });
                } else {
                  await executeCommitAndBridge();
                }
              }
            }

            // 5. Settle signature after successful delivery (audit 1.4)
            const settled = store.recordSettledPayment({
              signature: proof.signature,
              payer: proof.payer,
              recipient: activeRecipient,
              amount: verResult.amount ?? requiredPrice,
              endpoint: pathname,
              wallet: typeof body.wallet === "string" ? body.wallet : undefined,
            });
            if (!settled && process.env.RADAR_DEBUG === "1") {
              console.warn("[x402] payment signature settled concurrently; scan still delivered");
            }
            const resHeaders: Record<string, string> = { "Content-Type": "application/json" };
            if (req.headers["prefer"] === "respond-async") {
              resHeaders["Preference-Applied"] = "respond-async";
            }
            res.writeHead(200, resHeaders);
            res.end(JSON.stringify(scanRes, null, 2));
            return;
          }

          if (pathname === "/analyze") {
            const analyzeRes = await analyzeHandler(body.wallet as string, body.txs as EnhancedTx[] | string);
            const settled = store.recordSettledPayment({
              signature: proof.signature,
              payer: proof.payer,
              recipient: activeRecipient,
              amount: verResult.amount ?? requiredPrice,
              endpoint: pathname,
              wallet: typeof body.wallet === "string" ? body.wallet : undefined,
            });
            if (!settled && process.env.RADAR_DEBUG === "1") {
              console.warn("[x402] payment signature settled concurrently; analyze still delivered");
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(analyzeRes, null, 2));
            return;
          }
        } finally {
          inFlightPayments.delete(proof.signature);
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (err: unknown) {
      if (err instanceof PayloadTooLargeError || (err as { status?: number }).status === 413) {
        res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ error: "Payload Too Large" }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  return server;
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  loadEnv();

  if (args.includes("--version") || args.includes("-v")) {
    console.log(getVersion());
    process.exit(0);
  }

  if (args.includes("--health")) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: "ok",
          name: "wallet-radar-x402",
          version: getVersion(),
          pricing: X402_PRICING,
          recipient: process.env.RADAR_X402_RECIPIENT ?? null,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  validateConfig(process.env, {
    paywall: Boolean(process.env.RADAR_PAYWALL === "1" || process.env.RADAR_X402_PAYWALL === "1"),
  });

  let port = Number(process.env.RADAR_X402_PORT || process.env.PORT || 4020);
  let host = process.env.HOST || "0.0.0.0";
  let recipient = process.env.RADAR_X402_RECIPIENT;

  const portIdx = args.indexOf("--port");
  if (portIdx >= 0 && portIdx + 1 < args.length) {
    port = Number(args[portIdx + 1]);
  }

  const hostIdx = args.indexOf("--host");
  if (hostIdx >= 0 && hostIdx + 1 < args.length) {
    host = args[hostIdx + 1];
  }

  const recipientIdx = args.indexOf("--recipient");
  if (recipientIdx >= 0 && recipientIdx + 1 < args.length) {
    recipient = args[recipientIdx + 1];
  }

  // Audit 2.3: oracle→hook bridge from env (RADAR_HOOK_MINT + RADAR_HOOK_KEYPAIR).
  let hookBridge: X402ServerOptions["hookBridge"] | null = null;
  try {
    hookBridge = buildEnvHookBridge();
    if (hookBridge) {
      console.log(`wallet-radar x402 oracle→hook bridge enabled (mint ${process.env.RADAR_HOOK_MINT}).`);
    } else if (process.env.RADAR_HOOK_MINT || process.env.RADAR_HOOK_KEYPAIR) {
      console.warn(`wallet-radar x402 partial hook-bridge config (need BOTH RADAR_HOOK_MINT and RADAR_HOOK_KEYPAIR) — hook bridge disabled.`);
    }
  } catch (err) {
    console.warn(`wallet-radar x402 failed to build hook bridge: ${err instanceof Error ? err.message : String(err)} — hook bridge disabled.`);
  }

  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    process.env.HELIUS_RPC_URL ||
    (process.env.HELIUS_API_KEY ? "https://mainnet.helius-rpc.com/?api-key=" + process.env.HELIUS_API_KEY : undefined);
  const server = createX402Server({ recipient, hookBridge: hookBridge ?? undefined, rpcUrl });
  server.listen(port, host, () => {
    console.log(`wallet-radar x402 server running at http://${host}:${port}`);
    console.log(`Recipient wallet: ${recipient ?? "unconfigured (set RADAR_X402_RECIPIENT)"}`);
    console.log(`Endpoints: POST /scan (0.005 USDC), POST /analyze (0.001 USDC), GET /selftest (Free)`);
  });
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectRun) {
  runCli().catch((err) => {
    console.error("x402 server error:", err);
    process.exit(1);
  });
}
