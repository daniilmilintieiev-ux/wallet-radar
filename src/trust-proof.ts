import { readScanLedger, ScanLedgerRecord, ZKOracleClient } from "./oracle/index.js";
import { Store } from "./store.js";
import { computeRiskScore } from "./analyzer.js";
import { computeVerdict } from "./htmlreport.js";

/**
 * On-chain ZK-compressed scan attestation summary.
 */
export interface TrustProofAttestation {
  signature: string | null;
  slot: number | null;
  compressedAddress: string | null;
  timestamp: number;
}

/**
 * x402 USDC payment receipt proving commercial settlement.
 */
export interface TrustProofPayment {
  payer: string;
  recipient: string;
  amountUsdc: number;
  txSignature: string;
  signature: string;
  settledAt: number;
}

/**
 * Independently verifiable trust proof bundle for any Solana wallet.
 */
export interface TrustProofBundle {
  /** Target wallet address */
  wallet: string;
  /** True if an on-chain ZK attestation exists */
  verified: boolean;
  /** On-chain ZK-compressed scan attestation details, or null if uncommitted */
  attestation: TrustProofAttestation | null;
  /** Current risk score (0-100) or null if unknown */
  riskScore: number | null;
  /** Verdict badge: "SAFE", "LOW RISK", "SUSPICIOUS", "HIGH RISK", or "UNKNOWN" */
  verdict: string;
  /** Top firing anomaly detector rule IDs */
  topRules: string[];
  /** Payment receipt if the scan was earned via x402 USDC micropayment */
  payment: TrustProofPayment | null;
  /** Evaluation timestamp (Unix seconds) */
  generatedAt: number;
}

export interface BuildTrustProofOptions {
  /** Optional custom ZK oracle client */
  oracleClient?: ZKOracleClient;
  /** Solana RPC URL */
  rpcUrl?: string;
  /** Watchlist/settlement SQLite store */
  store?: Store;
  /** Virtual clock override for deterministic tests */
  nowSec?: number;
  /** Anonymize payer address in the returned payment receipt (Audit 3.2). */
  anonymizePayer?: boolean;
}

/**
 * Builds an independently verifiable trust proof bundle:
 * 1. Reads the latest on-chain ZK-compressed scan attestation from the ledger.
 * 2. Extracts risk score, verdict, and fired anomaly rules.
 * 3. Looks up the settled x402 payment receipt (if scan was paid via USDC).
 * 4. For unknown wallets with no records, gracefully returns null/empty fields.
 */
export async function buildTrustProof(
  wallet: string,
  options: BuildTrustProofOptions = {},
): Promise<TrustProofBundle> {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);

  // 1. Read most recent on-chain ZK scan attestation
  let records: ScanLedgerRecord[] = [];
  try {
    records = await readScanLedger(wallet, {
      client: options.oracleClient,
      rpcUrl: options.rpcUrl,
      limit: 1,
    });
  } catch {
    // Graceful error isolation
    records = [];
  }

  const latest = records.length > 0 ? records[0] : null;

  let attestation: TrustProofAttestation | null = null;
  let verified = false;
  let riskScore: number | null = null;
  let verdict: string = "UNKNOWN";
  let topRules: string[] = [];

  if (latest) {
    // Audit 1.2: an attestation read through the legacy lamports path is
    // explicitly flagged `verified: false` (forgeable); only records whose
    // Ed25519 signature was verified by the oracle client count as verified.
    verified = Boolean(latest.onchainSignature || latest.compressedAddress) && latest.verified !== false;
    attestation = {
      signature: latest.onchainSignature ?? null,
      slot: latest.slot ?? null,
      compressedAddress: latest.compressedAddress ?? null,
      timestamp: latest.timestamp,
    };
    riskScore = typeof latest.riskScore === "number" ? latest.riskScore : 0;
    verdict = latest.verdict || computeVerdict(riskScore);
    topRules = Array.isArray(latest.topRules) ? latest.topRules : [];
  } else if (options.store) {
    // Fall back to store if wallet has recorded anomalies or baseline
    const recent = options.store.recentAnomalies(wallet, 10);
    if (recent.length > 0) {
      riskScore = computeRiskScore(recent);
      verdict = computeVerdict(riskScore);
      topRules = Array.from(new Set(recent.map((a) => a.type)));
    } else if (options.store.getBaseline(wallet)) {
      riskScore = 0;
      verdict = "SAFE";
      topRules = [];
    }
  }

  // 2. Look up x402 payment receipt in store (if scan was earned in USDC)
  let payment: TrustProofPayment | null = null;
  if (options.store) {
    const settled = options.store.getLatestSettledPaymentForWallet(wallet);

    if (settled) {
      const anonymize =
        options.anonymizePayer ?? (process.env.RADAR_ANONYMIZE_PAYER === "1");
      const payerDisplay =
        anonymize && settled.payer && settled.payer.length > 8
          ? `${settled.payer.slice(0, 4)}...${settled.payer.slice(-4)}`
          : settled.payer;

      payment = {
        payer: payerDisplay,
        recipient: settled.recipient,
        amountUsdc: settled.amount,
        txSignature: settled.signature,
        signature: settled.signature,
        settledAt: settled.settledAt,
      };
    }
  }

  return {
    wallet,
    verified,
    attestation,
    riskScore,
    verdict,
    topRules,
    payment,
    generatedAt: nowSec,
  };
}
