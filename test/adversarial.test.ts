import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Store } from "../src/store.js";
import { USDC_MINT } from "../src/types.js";
import {
  createX402Server,
  verifySolanaPaymentRpc,
  signPaymentProof,
  verifyPaymentProof,
  PaymentProof,
  PaymentRequirement,
} from "../src/x402server.js";
import {
  RadarHookErrorCode,
  evaluateTransferRisk,
  deriveRadarRecordPda,
  deriveRadarConfigPda,
  DEFAULT_HOOK_PROGRAM_ID,
  createRiskGatedTransferCheckedInstruction,
} from "../src/hook/index.js";
import {
  ScanLedgerRecord,
  serializeScanRecord,
  deserializeScanRecord,
  SCAN_RECORD_MAGIC,
} from "../src/oracle/index.js";

function tmpDb(): { store: Store; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-adv-test-"));
  const dbPath = path.join(dir, "adv-test.db");
  const store = new Store(dbPath);
  return { store, dir, dbPath };
}

function startServer(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// SUITE 1: ADVERSARIAL TESTING — x402 PAYMENT SERVER (src/x402server.ts)
// ---------------------------------------------------------------------------
describe("Adversarial: x402 Payment Server", () => {
  const recipient = "RecipientWallet111111111111111111111111111";

  const stubScan = async (wallet: string) => ({
    wallet,
    txCount: 10,
    riskScore: 15,
    anomalies: [],
    digest: "All clear",
  });

  // Attack 1: Parallel Double-Spend / Race Condition
  test("ADV-X402-01: Parallel double-spend race condition (20 concurrent requests with identical signature)", async () => {
    const { store, dir } = tmpDb();
    const targetWallet = "TargetWappet11111111111111111111111111111111";
    const sharedSig = "adv_tx_signature_race_test_" + Date.now();
    const payer = "PayerWappet111111111111111111111111111111111";

    let verificationCalls = 0;
    const server = createX402Server({
      store,
      recipient,
      scanHandler: stubScan,
      paymentVerifier: async () => {
        verificationCalls++;
        // Simulate real-world RPC latency (25ms) to widen race condition window
        await new Promise((r) => setTimeout(r, 25));
        return { valid: true, amount: 0.005, payer, recipient };
      },
    });

    const { port, close } = await startServer(server);

    try {
      // Fire 20 parallel requests with the identical payment signature
      const parallelRequests = Array.from({ length: 20 }).map(() =>
        fetch(`http://127.0.0.1:${port}/scan`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Payment-Signature": sharedSig,
            "X-Payment-Payer": payer,
          },
          body: JSON.stringify({ wallet: targetWallet }),
        }),
      );

      const responses = await Promise.all(parallelRequests);
      const statuses = responses.map((r) => r.status);

      const count200 = statuses.filter((s) => s === 200).length;
      const count402 = statuses.filter((s) => s === 402).length;

      // Invariant: Exactly ONE request can succeed. All 19 concurrent race attempts must be 402 rejected
      assert.equal(count200, 1, `Expected exactly 1 success (200), received ${count200}`);
      assert.equal(count402, 19, `Expected 19 replay rejections (402), received ${count402}`);

      // Verify that database settled record is uniquely persisted
      assert.equal(store.hasSettledPayment(sharedSig), true);

      // Verify that subsequent request after completion is also rejected
      const retryRes = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": sharedSig,
          "X-Payment-Payer": payer,
        },
        body: JSON.stringify({ wallet: targetWallet }),
      });
      assert.equal(retryRes.status, 402);
      const retryBody = (await retryRes.json()) as any;
      assert.equal(retryBody.error, "Payment Required");
      assert.match(retryBody.detail || "", /already settled/i);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Attack 2: Off-by-One Payment Amount & Micro-Precision
  test("ADV-X402-02: Off-by-one payment amount & precision boundaries", async () => {
    const requirement: PaymentRequirement = {
      endpoint: "/scan",
      recipient: "RecipientAta111111111111111111111111111111",
      minAmount: 0.005,
      mint: USDC_MINT,
    };

    const dummyProof: PaymentProof = {
      signature: "adv_sig_amount_test",
      payer: "PayerWallet11111111111111111111111111111111",
    };

    // Subcase 2a: 0.004999 USDC (1 micro-USDC under required 0.005) -> REJECT
    const mockTxUnderpaid = {
      transaction: {
        message: {
          accountKeys: [dummyProof.payer, requirement.recipient],
          header: { numRequiredSignatures: 1 },
        },
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.0 } }],
        postTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.004999 } }],
      },
      blockTime: Math.floor(Date.now() / 1000),
    };

    // Subcase 2b: Exactly 0.005000 USDC -> ACCEPT
    const mockTxExact = {
      transaction: {
        message: {
          accountKeys: [dummyProof.payer, requirement.recipient],
          header: { numRequiredSignatures: 1 },
        },
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.0 } }],
        postTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.005000 } }],
      },
      blockTime: Math.floor(Date.now() / 1000),
    };

    // Subcase 2c: 0.000000 USDC -> REJECT
    const mockTxZero = {
      transaction: {
        message: {
          accountKeys: [dummyProof.payer, requirement.recipient],
          header: { numRequiredSignatures: 1 },
        },
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.0 } }],
        postTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.0 } }],
      },
      blockTime: Math.floor(Date.now() / 1000),
    };

    // Subcase 2d: Floating-point precision artifact check (0.0049994 rounds down to 0.004999) -> REJECT
    const mockTxEpsilonUnder = {
      transaction: {
        message: {
          accountKeys: [dummyProof.payer, requirement.recipient],
          header: { numRequiredSignatures: 1 },
        },
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.0 } }],
        postTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: USDC_MINT, uiTokenAmount: { uiAmount: 10.0049994 } }],
      },
      blockTime: Math.floor(Date.now() / 1000),
    };

    const createMockRpc = (tx: any) => {
      return http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: "x402-verify", result: tx }));
      });
    };

    // Test Underpaid
    const s1 = createMockRpc(mockTxUnderpaid);
    const { port: p1, close: c1 } = await startServer(s1);
    try {
      const res = await verifySolanaPaymentRpc(dummyProof, requirement, `http://127.0.0.1:${p1}`);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /insufficient payment/i);
    } finally {
      await c1();
    }

    // Test Exact
    const s2 = createMockRpc(mockTxExact);
    const { port: p2, close: c2 } = await startServer(s2);
    try {
      const res = await verifySolanaPaymentRpc(dummyProof, requirement, `http://127.0.0.1:${p2}`);
      assert.equal(res.valid, true);
      assert.equal(res.amount, 0.005);
    } finally {
      await c2();
    }

    // Test Zero
    const s3 = createMockRpc(mockTxZero);
    const { port: p3, close: c3 } = await startServer(s3);
    try {
      const res = await verifySolanaPaymentRpc(dummyProof, requirement, `http://127.0.0.1:${p3}`);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /insufficient payment/i);
    } finally {
      await c3();
    }

    // Test Epsilon Under
    const s4 = createMockRpc(mockTxEpsilonUnder);
    const { port: p4, close: c4 } = await startServer(s4);
    try {
      const res = await verifySolanaPaymentRpc(dummyProof, requirement, `http://127.0.0.1:${p4}`);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /insufficient payment/i);
    } finally {
      await c4();
    }
  });

  // Attack 3: Spoofed Mint (Token disguised as USDC)
  test("ADV-X402-03: Spoofed mint token payment disguised as USDC is rejected", async () => {
    const fakeMint = "FakeUSDC11111111111111111111111111111111111";
    const requirement: PaymentRequirement = {
      endpoint: "/scan",
      recipient: "RecipientAta111111111111111111111111111111",
      minAmount: 0.005,
      mint: USDC_MINT,
    };
    const dummyProof: PaymentProof = {
      signature: "adv_sig_spoofed_mint",
      payer: "PayerWallet11111111111111111111111111111111",
    };

    // Attack payload: Attacker transfers 1,000,000 FakeUSDC tokens
    const mockTxSpoofedMint = {
      transaction: {
        message: {
          accountKeys: [dummyProof.payer, requirement.recipient],
          header: { numRequiredSignatures: 1 },
        },
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: fakeMint, uiTokenAmount: { uiAmount: 0 } }],
        postTokenBalances: [{ accountIndex: 1, owner: requirement.recipient, mint: fakeMint, uiTokenAmount: { uiAmount: 1000 } }],
      },
      blockTime: Math.floor(Date.now() / 1000),
    };

    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "x402-verify", result: mockTxSpoofedMint }));
    });
    const { port, close } = await startServer(s);

    try {
      const res = await verifySolanaPaymentRpc(dummyProof, requirement, `http://127.0.0.1:${port}`);
      // Invariant: Transfers of non-USDC mints must yield transferred = 0 and be rejected
      assert.equal(res.valid, false);
      assert.match(res.error || "", /insufficient payment/i);
    } finally {
      await close();
    }
  });

  // Attack 4: Payer Mismatch & Non-Signer Hijacking
  test("ADV-X402-04: Payer mismatch and non-signer payment hijacking is rejected", async () => {
    const victimPayer = "VictimSignerWallet1111111111111111111111111";
    const attackerPayer = "AttackerWallet1111111111111111111111111111";
    const recipientAcc = "RecipientAta111111111111111111111111111111";

    const requirement: PaymentRequirement = {
      endpoint: "/scan",
      recipient: recipientAcc,
      minAmount: 0.005,
      mint: USDC_MINT,
    };

    // Victim paid, Victim signed (numRequiredSignatures: 1, accountKeys[0] is Victim)
    // Attacker is listed as non-signer accountKeys[2] (e.g. read-only account in tx)
    const mockTx = {
      transaction: {
        message: {
          accountKeys: [
            { pubkey: victimPayer, signer: true },
            { pubkey: recipientAcc, signer: false },
            { pubkey: attackerPayer, signer: false },
          ],
          header: { numRequiredSignatures: 1 },
        },
      },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, owner: recipientAcc, mint: USDC_MINT, uiTokenAmount: { uiAmount: 0 } }],
        postTokenBalances: [{ accountIndex: 1, owner: recipientAcc, mint: USDC_MINT, uiTokenAmount: { uiAmount: 0.005 } }],
      },
      blockTime: Math.floor(Date.now() / 1000),
    };

    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "x402-verify", result: mockTx }));
    });
    const { port, close } = await startServer(s);

    try {
      // Attacker claims this payment proof under attacker's own wallet
      const attackerProof: PaymentProof = {
        signature: "valid_tx_signed_by_victim",
        payer: attackerPayer,
      };
      const res = await verifySolanaPaymentRpc(attackerProof, requirement, `http://127.0.0.1:${port}`);
      // Invariant: Attacker is not a signer, rejection is strictly required
      assert.equal(res.valid, false);
      assert.match(res.error || "", /not a signer of the payment transaction/i);
    } finally {
      await close();
    }
  });

  // Attack 5: Unconfirmed & Failed On-Chain Transactions
  test("ADV-X402-05: Unconfirmed, missing, or failed on-chain transactions are rejected", async () => {
    const requirement: PaymentRequirement = {
      endpoint: "/scan",
      recipient: "RecipientAta111111111111111111111111111111",
      minAmount: 0.005,
    };
    const proof: PaymentProof = {
      signature: "adv_sig_unconfirmed",
      payer: "PayerWappet111111111111111111111111111111111",
    };

    // Subcase 5a: Transaction not found on-chain (result: null)
    const sNull = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "x402-verify", result: null }));
    });
    const { port: pNull, close: cNull } = await startServer(sNull);
    try {
      const res = await verifySolanaPaymentRpc(proof, requirement, `http://127.0.0.1:${pNull}`);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /transaction not found on-chain/i);
    } finally {
      await cNull();
    }

    // Subcase 5b: Transaction executed but failed on-chain (meta.err != null)
    const sErr = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x402-verify",
          result: {
            meta: { err: { InstructionError: [0, "Custom: 1"] } },
          },
        }),
      );
    });
    const { port: pErr, close: cErr } = await startServer(sErr);
    try {
      const res = await verifySolanaPaymentRpc(proof, requirement, `http://127.0.0.1:${pErr}`);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /transaction failed on-chain/i);
    } finally {
      await cErr();
    }

    // Subcase 5c: Stale transaction exceeding maxAgeSec (e.g. 500s ago when maxAge is 300s)
    const sStale = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x402-verify",
          result: {
            meta: { err: null },
            blockTime: Math.floor(Date.now() / 1000) - 500,
          },
        }),
      );
    });
    const { port: pStale, close: cStale } = await startServer(sStale);
    try {
      const res = await verifySolanaPaymentRpc(proof, requirement, `http://127.0.0.1:${pStale}`);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /transaction too old/i);
    } finally {
      await cStale();
    }
  });

  // Attack 6: Cross-Header Proof Replay
  test("ADV-X402-06: Cross-header proof replay deduplication across header schemes", async () => {
    const { store, dir } = tmpDb();
    const targetWallet = "TargetWappet11111111111111111111111111111111";
    const sig = "adv_tx_signature_cross_header_" + Date.now();
    const payer = "PayerWappet111111111111111111111111111111111";

    const server = createX402Server({
      store,
      recipient,
      scanHandler: stubScan,
      paymentVerifier: async () => ({ valid: true, amount: 0.005, payer, recipient }),
    });
    const { port, close } = await startServer(server);

    try {
      // Step 1: Submit via X-Payment-Signature
      const res1 = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": sig,
          "X-Payment-Payer": payer,
        },
        body: JSON.stringify({ wallet: targetWallet }),
      });
      assert.equal(res1.status, 200);

      // Step 2: Replay via Authorization: x402 <sig>:<payer>
      const res2 = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `x402 ${sig}:${payer}`,
        },
        body: JSON.stringify({ wallet: targetWallet }),
      });
      assert.equal(res2.status, 402);
      const json2 = (await res2.json()) as any;
      assert.equal(json2.error, "Payment Required");
      assert.match(json2.detail || "", /already settled/i);

      // Step 3: Replay via X-Payment JSON header
      const res3 = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment": JSON.stringify({ signature: sig, payer }),
        },
        body: JSON.stringify({ wallet: targetWallet }),
      });
      assert.equal(res3.status, 402);

      // Step 4: Replay via request body payment object
      const res4 = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: targetWallet, payment: { signature: sig, payer } }),
      });
      assert.equal(res4.status, 402);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SUITE 2: ADVERSARIAL TESTING — RADAR TRANSFER HOOK (src/hook & programs/)
// ---------------------------------------------------------------------------
describe("Adversarial: Radar Transfer Hook & Binary Record Gating", () => {
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const destWalletKp = Keypair.generate();
  const destWallet = destWalletKp.publicKey;
  const nowSec = Math.floor(Date.now() / 1000);

  // Attack 1: Malformed RS01 Payload & Out-of-Bounds Parsing
  test("ADV-HOOK-01: Malformed RS01 payload and out-of-bounds payload_len buffer safety", () => {
    // Subcase 1a: Truncated buffer under 48 bytes
    const truncatedBuf = Buffer.from("RS01too_short_to_be_a_header");
    const evalTruncated = evaluateTransferRisk(truncatedBuf);
    assert.equal(evalTruncated.allowed, false);
    assert.equal(evalTruncated.errorCode, RadarHookErrorCode.InvalidScanRecordMagic);

    // Subcase 1b: payload_len set to 65535, but physical buffer is exactly 48 bytes
    const oobBuf = Buffer.alloc(48);
    SCAN_RECORD_MAGIC.copy(oobBuf, 0);
    destWallet.toBuffer().copy(oobBuf, 4);
    oobBuf.writeUInt8(25, 36); // risk 25
    oobBuf.writeUInt8(1, 37); // verdict 1 (LOW RISK)
    oobBuf.writeBigUInt64LE(BigInt(nowSec - 100), 38);
    oobBuf.writeUInt16LE(65535, 46); // declared 65535 bytes of payload

    // Deserialization must handle declared payload_len > actual buffer gracefully without crash
    const desOob = deserializeScanRecord(oobBuf);
    assert.equal(desOob.riskScore, 25);
    assert.equal(desOob.verdict, "LOW RISK");
    assert.deepEqual(desOob.topRules, []);

    // Evaluation on this buffer must succeed based on clean header
    const evalOob = evaluateTransferRisk(oobBuf, { maxRiskScore: 80 }, nowSec);
    assert.equal(evalOob.allowed, true);

    // Subcase 1c: Corrupted malformed JSON payload bytes
    const malformedJsonBuf = Buffer.alloc(48 + 15);
    SCAN_RECORD_MAGIC.copy(malformedJsonBuf, 0);
    destWallet.toBuffer().copy(malformedJsonBuf, 4);
    malformedJsonBuf.writeUInt8(10, 36);
    malformedJsonBuf.writeUInt8(0, 37);
    malformedJsonBuf.writeBigUInt64LE(BigInt(nowSec - 50), 38);
    malformedJsonBuf.writeUInt16LE(15, 46);
    malformedJsonBuf.write("{NOT_VALID_JSON", 48);

    // Must not throw uncaught syntax error
    const desBroken = deserializeScanRecord(malformedJsonBuf);
    assert.equal(desBroken.riskScore, 10);
    assert.deepEqual(desBroken.topRules, []);
  });

  // Attack 2: Fuzzing 48-byte Header & Future Timestamp Exploit Analysis
  test("ADV-HOOK-02: Fuzzing header magic & FUTURE TIMESTAMP GAP IDENTIFICATION", () => {
    // Subcase 2a: Header magic byte corruption
    const badMagicBuf = Buffer.alloc(48);
    badMagicBuf.write("BAD0", 0);
    assert.equal(evaluateTransferRisk(badMagicBuf).errorCode, RadarHookErrorCode.InvalidScanRecordMagic);

    const rs00Buf = Buffer.alloc(48);
    rs00Buf.write("RS00", 0);
    assert.equal(evaluateTransferRisk(rs00Buf).errorCode, RadarHookErrorCode.InvalidScanRecordMagic);

    // Subcase 2b: Extreme / saturated risk scores
    const recordExtremeScore: ScanLedgerRecord = {
      wallet: destWallet.toBase58(),
      riskScore: 255, // Max uint8
      verdict: "HIGH RISK",
      timestamp: nowSec,
      topRules: ["FLAGGED"],
      txSignatures: [],
    };
    const evalExtreme = evaluateTransferRisk(recordExtremeScore, { maxRiskScore: 80 }, nowSec);
    assert.equal(evalExtreme.allowed, false);
    assert.equal(evalExtreme.errorCode, RadarHookErrorCode.RiskScoreTooHigh);

    // Subcase 2c: Future Timestamp Exploit & Gating
    // An attacker creates an attestation with a future timestamp (e.g. now + 1,000,000s)
    // attempting to bypass maxAttestationAgeSec expiration.
    // The engine must reject future timestamps exceeding MAX_FUTURE_DRIFT_SEC with StaleOracleAttestation.
    const futureTimestamp = nowSec + 1_000_000;
    const recordFuture: ScanLedgerRecord = {
      wallet: destWallet.toBase58(),
      riskScore: 20,
      verdict: "LOW RISK",
      timestamp: futureTimestamp,
      topRules: [],
      txSignatures: [],
    };

    const evalFuture = evaluateTransferRisk(recordFuture, { maxAttestationAgeSec: 3600 }, nowSec);
    assert.equal(evalFuture.allowed, false, "Future timestamp attestation must be rejected");
    assert.equal(evalFuture.errorCode, RadarHookErrorCode.StaleOracleAttestation);
    assert.match(evalFuture.reason || "", /future timestamp|stale/i);

    // Subcase 2d: Attestation within acceptable clock drift tolerance (now + 30s <= 60s drift)
    const recordToleratedDrift: ScanLedgerRecord = {
      wallet: destWallet.toBase58(),
      riskScore: 20,
      verdict: "LOW RISK",
      timestamp: nowSec + 30,
      topRules: [],
      txSignatures: [],
    };
    const evalDrift = evaluateTransferRisk(recordToleratedDrift, { maxAttestationAgeSec: 3600 }, nowSec);
    assert.equal(evalDrift.allowed, true, "Minor clock drift within tolerance should be accepted");
  });

  // Attack 3: Extra Accounts Spoofing in CPI transfer_checked (PDA Validation)
  test("ADV-HOOK-03: Extra accounts spoofing in CPI transfer_checked validates destination record PDA", () => {
    const cleanWallet = Keypair.generate().publicKey;
    const flaggedWallet = Keypair.generate().publicKey;

    // Correct PDA derivations
    const [expectedCleanRecord] = deriveRadarRecordPda(cleanWallet, mint);
    const [expectedFlaggedRecord] = deriveRadarRecordPda(flaggedWallet, mint);

    // Invariant: The record PDA for cleanWallet MUST NOT match flaggedWallet
    assert.notEqual(expectedCleanRecord.toBase58(), expectedFlaggedRecord.toBase58());

    // When constructing a risk-gated instruction targeting flaggedWallet,
    // the instruction builder binds the 7th account (index 7) specifically to flaggedWallet's PDA
    const ix = createRiskGatedTransferCheckedInstruction({
      source: Keypair.generate().publicKey,
      mint,
      destination: Keypair.generate().publicKey,
      owner: Keypair.generate().publicKey,
      amount: 1000,
      decimals: 6,
      destinationWallet: flaggedWallet,
    });

    const passedRecordKey = ix.keys[7].pubkey;
    assert.equal(passedRecordKey.toBase58(), expectedFlaggedRecord.toBase58());
    assert.notEqual(passedRecordKey.toBase58(), expectedCleanRecord.toBase58());

    // In on-chain Rust hook (programs/radar-transfer-hook/src/lib.rs:222):
    // let (expected_record, _) = Pubkey::find_program_address(&[b"radar_record", mint, dest_owner], &crate::ID);
    // if ctx.accounts.record.key() != expected_record { return Err(RecordPdaMismatch); }
    // Attacker passing cleanRecord PDA for a flaggedWallet destination is rejected on-chain with RecordPdaMismatch (6009).
  });

  // Attack 4: allowUnverified Policy Matrix
  test("ADV-HOOK-04: allowUnverified policy matrix prevents flagged wallets from evading checks", () => {
    // Matrix test across allowUnverified x wallet state

    // 1. Missing record, allowUnverified: false -> REJECT (6003)
    const res1 = evaluateTransferRisk(null, { allowUnverified: false });
    assert.equal(res1.allowed, false);
    assert.equal(res1.errorCode, RadarHookErrorCode.UnverifiedCounterparty);

    // 2. Missing record, allowUnverified: true -> ALLOW
    const res2 = evaluateTransferRisk(null, { allowUnverified: true });
    assert.equal(res2.allowed, true);

    // 3. Flagged record (risk 95), allowUnverified: true -> MUST STILL REJECT (6000)
    // An attacker cannot use allowUnverified to bypass an existing high-risk record
    const flaggedRecord: ScanLedgerRecord = {
      wallet: destWallet.toBase58(),
      riskScore: 95,
      verdict: "SUSPICIOUS",
      timestamp: nowSec,
      topRules: ["HIGH_RISK_SWAP"],
      txSignatures: [],
    };
    const res3 = evaluateTransferRisk(flaggedRecord, { allowUnverified: true, maxRiskScore: 80 });
    assert.equal(res3.allowed, false);
    assert.equal(res3.errorCode, RadarHookErrorCode.RiskScoreTooHigh);

    // 4. Flagged record with HIGH RISK verdict, allowUnverified: true -> MUST STILL REJECT (6001)
    const highRiskRecord: ScanLedgerRecord = {
      wallet: destWallet.toBase58(),
      riskScore: 50,
      verdict: "HIGH RISK",
      timestamp: nowSec,
      topRules: ["DRAINER_ASSOCIATE"],
      txSignatures: [],
    };
    const res4 = evaluateTransferRisk(highRiskRecord, { allowUnverified: true });
    assert.equal(res4.allowed, false);
    assert.equal(res4.errorCode, RadarHookErrorCode.CounterpartyFlagged);
  });

  // Attack 5: maxAttestationAgeSec Boundary Precision
  test("ADV-HOOK-05: maxAttestationAgeSec boundary precision (age == max vs age == max + 1)", () => {
    const maxAge = 3600; // 1 hour

    const makeRecord = (ts: number): ScanLedgerRecord => ({
      wallet: destWallet.toBase58(),
      riskScore: 20,
      verdict: "LOW RISK",
      timestamp: ts,
      topRules: [],
      txSignatures: [],
    });

    // Subcase 5a: age = 3599s (1 second before expiry) -> ALLOW
    const resUnder = evaluateTransferRisk(makeRecord(nowSec - 3599), { maxAttestationAgeSec: maxAge }, nowSec);
    assert.equal(resUnder.allowed, true);

    // Subcase 5b: age = 3600s (exact boundary) -> ALLOW (age > maxAge is false)
    const resExact = evaluateTransferRisk(makeRecord(nowSec - 3600), { maxAttestationAgeSec: maxAge }, nowSec);
    assert.equal(resExact.allowed, true);

    // Subcase 5c: age = 3601s (1 second past boundary) -> REJECT (6002)
    const resOver = evaluateTransferRisk(makeRecord(nowSec - 3601), { maxAttestationAgeSec: maxAge }, nowSec);
    assert.equal(resOver.allowed, false);
    assert.equal(resOver.errorCode, RadarHookErrorCode.StaleOracleAttestation);
    assert.match(resOver.reason || "", /stale/i);
  });

  // Attack 6: Transfer Splitting / Chunking (Smurfing)
  test("ADV-HOOK-06: Transfer splitting / chunking (smurfing) is completely gated against flagged wallet", () => {
    // Attacker attempts to transfer 1,000 tokens to a flagged counterparty by splitting
    // into 10 smaller micro-transfers of 100 tokens each.
    const flaggedRecord: ScanLedgerRecord = {
      wallet: destWallet.toBase58(),
      riskScore: 90,
      verdict: "HIGH RISK",
      timestamp: nowSec - 100,
      topRules: ["SANCTIONED_HEURISTIC"],
      txSignatures: [],
    };

    const chunkAmounts = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    const chunkResults = chunkAmounts.map((amt) => {
      // Transfer hook gating evaluates counterparty record on every invocation
      const evalRes = evaluateTransferRisk(flaggedRecord, { maxRiskScore: 80 }, nowSec);
      return { amount: amt, allowed: evalRes.allowed, errorCode: evalRes.errorCode };
    });

    // Invariant: Because Transfer Hook gates on counterparty identity / on-chain verdict rather than
    // per-transfer amounts, ALL 10 micro-transfer attempts are blocked.
    assert.equal(chunkResults.every((c) => !c.allowed), true);
    assert.equal(chunkResults.every((c) => c.errorCode === RadarHookErrorCode.RiskScoreTooHigh), true);
  });
});
