import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { createX402Server, PaymentProof, PaymentRequirement } from "../src/x402server.js";
import { createRadarClient } from "../src/sdk/index.js";
import { MockZKOracleClient, ScanLedgerRecord } from "../src/oracle/index.js";
import { Store } from "../src/store.js";
import { fetchAndRenderDashboard } from "../src/dashboard.js";
import {
  evaluateTransferRisk,
  RadarHookErrorCode,
  createRiskGatedTransferCheckedInstruction,
} from "../src/hook/index.js";

function tmpDb(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-e2e-test-"));
  const dbPath = path.join(dir, "e2e.db");
  const store = new Store(dbPath);
  return { store, dir };
}

function startServer(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const close = () =>
        new Promise<void>((res) => {
          server.close(() => res());
        });
      resolve({ port: addr.port, close });
    });
  });
}

describe("E2E Integration & Verification (Hackathon Full Flow)", () => {
  const recipientKeypair = Keypair.generate();
  const recipient = recipientKeypair.publicKey.toBase58();

  const agentPayerKeypair = Keypair.generate();
  const agentPayer = agentPayerKeypair.publicKey.toBase58();

  const safeTargetKeypair = Keypair.generate();
  const safeTarget = safeTargetKeypair.publicKey.toBase58();

  const toxicTargetKeypair = Keypair.generate();
  const toxicTarget = toxicTargetKeypair.publicKey.toBase58();

  test("Full-Circle E2E Flow: scan -> x402 auto-pay -> ZK oracle commit -> SDK read -> dashboard render -> Token-22 hook gate", async () => {
    const { store, dir } = tmpDb();
    const oracleClient = new MockZKOracleClient();

    // 1. Payment verifier verifying signatures
    const verifiedSignatures = new Set<string>();
    const verifier = async (proof: PaymentProof, req: PaymentRequirement) => {
      if (proof.payer !== agentPayer) {
        return { valid: false, error: "Unexpected payer" };
      }
      if (!proof.signature || proof.signature.length < 10) {
        return { valid: false, error: "Malformed signature format" };
      }
      verifiedSignatures.add(proof.signature);
      return {
        valid: true,
        amount: req.minAmount,
        payer: proof.payer,
        recipient: req.recipient,
      };
    };

    // 2. Scan handler returning realistic anomaly assessment
    const scanHandler = async (wallet: string) => {
      if (wallet === toxicTarget) {
        return {
          wallet,
          riskScore: 90,
          verdict: "HIGH RISK",
          anomalies: [
            { type: "DORMANT_ACTIVE", severity: "high", text: "Awakened after 180 days" },
            { type: "LARGE_SWAP", severity: "high", text: "Swap 15x normal volume" },
            { type: "TOXIC_MINT", severity: "high", text: "Freeze authority active" },
          ],
          txSignatures: ["tx_toxic_1", "tx_toxic_2"],
        };
      }
      return {
        wallet,
        riskScore: 15,
        verdict: "SAFE",
        anomalies: [],
        txSignatures: ["tx_safe_1"],
      };
    };

    const server = createX402Server({
      store,
      recipient,
      oracleClient,
      enableOracle: true,
      paymentVerifier: verifier,
      scanHandler,
    });
    const { port, close } = await startServer(server);

    try {
      // Step A: Instantiate Autonomous Agent SDK client
      const agentClient = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        x402Payer: agentPayerKeypair,
        recipient,
        oracleClient,
      });

      // Step B: Agent triggers scan on safeTarget (triggers x402 challenge, auto-payment, oracle commit)
      const scanResult = await agentClient.scan(safeTarget);

      // Verify scan result structure
      assert.equal(scanResult.wallet, safeTarget);
      assert.equal(scanResult.riskScore, 15);
      assert.equal(scanResult.verdict, "SAFE");
      assert.ok(scanResult.onchainLedgerSig, "onchainLedgerSig must be returned");
      assert.ok(scanResult.onchainLedgerSig.startsWith("sig_"));

      // Verify payment settlement in SQLite store
      assert.equal(verifiedSignatures.size, 1);
      const paymentSig = Array.from(verifiedSignatures)[0];
      assert.equal(store.hasSettledPayment(paymentSig), true);

      // Step C: Agent reads ZK scan ledger on-chain directly
      const onchainHistory = await agentClient.readOnchainLedger(safeTarget);
      assert.equal(onchainHistory.length, 1);
      const latestOnchain = onchainHistory[0];
      assert.equal(latestOnchain.wallet, safeTarget);
      assert.equal(latestOnchain.riskScore, 15);
      assert.equal(latestOnchain.verdict, "SAFE");
      assert.equal(latestOnchain.onchainSignature, scanResult.onchainLedgerSig);
      assert.ok(latestOnchain.compressedAddress, "ZK compressed address must be generated");
      assert.ok(latestOnchain.slot && latestOnchain.slot >= 300_000_000);

      // Step D: Web Dashboard renders verified on-chain history
      const dashHtml = await fetchAndRenderDashboard(safeTarget, {
        client: oracleClient,
      });
      assert.ok(dashHtml.includes(safeTarget), "Dashboard must include target wallet");
      assert.ok(dashHtml.includes("Scan ledger"), "Dashboard must render scan ledger");
      assert.ok(dashHtml.includes("15"), "Dashboard must render risk score");
      assert.ok(dashHtml.includes("SAFE"), "Dashboard must render SAFE verdict");
      assert.ok(dashHtml.includes("ARMED"), "Dashboard must render armed/safe stance");
      assert.ok(dashHtml.includes(latestOnchain.onchainSignature!.slice(0, 12)));

      // Step E: Server HTTP endpoints test (/dashboard and /api/ledger)
      const httpDashRes = await fetch(`http://127.0.0.1:${port}/dashboard?wallet=${safeTarget}`);
      assert.equal(httpDashRes.status, 200);
      const httpDashText = await httpDashRes.text();
      assert.ok(httpDashText.includes(safeTarget));

      const httpLedgerRes = await fetch(`http://127.0.0.1:${port}/api/ledger?wallet=${safeTarget}`);
      assert.equal(httpLedgerRes.status, 200);
      const ledgerJson = await httpLedgerRes.json();
      assert.equal(ledgerJson.wallet, safeTarget);
      assert.equal(ledgerJson.count, 1);
      assert.equal(ledgerJson.latest.riskScore, 15);

      // Step F: Token-22 Transfer Hook evaluates safe counterparty
      const safeHookEval = evaluateTransferRisk(latestOnchain, { maxRiskScore: 80 });
      assert.equal(safeHookEval.allowed, true);
      assert.equal(safeHookEval.riskScore, 15);

      // Step G: Toxic counterparty workflow
      const toxicResult = await agentClient.scan(toxicTarget);
      assert.equal(toxicResult.riskScore, 90);
      assert.equal(toxicResult.verdict, "HIGH RISK");
      assert.ok(toxicResult.onchainLedgerSig);

      const toxicOnchain = (await agentClient.readOnchainLedger(toxicTarget))[0];
      assert.equal(toxicOnchain.riskScore, 90);
      assert.equal(toxicOnchain.verdict, "HIGH RISK");

      // Token-22 Hook gates transfer to toxic counterparty
      const toxicHookEval = evaluateTransferRisk(toxicOnchain, { maxRiskScore: 80 });
      assert.equal(toxicHookEval.allowed, false);
      assert.equal(toxicHookEval.errorCode, RadarHookErrorCode.RiskScoreTooHigh);
      assert.ok(toxicHookEval.reason?.includes("exceeds maximum allowed"));

      // Verify instruction builder compiles transfer instruction with hook accounts
      const ix = createRiskGatedTransferCheckedInstruction({
        source: Keypair.generate().publicKey,
        mint: Keypair.generate().publicKey,
        destination: Keypair.generate().publicKey,
        owner: agentPayerKeypair.publicKey,
        amount: 500_000n,
        decimals: 6,
        destinationWallet: safeTargetKeypair.publicKey,
      });
      assert.equal(ix.data.length, 10);
      assert.equal(ix.keys.length, 8);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Load & Concurrency Test: 25 concurrent paid scans with replay prevention and oracle commits", async () => {
    const { store, dir } = tmpDb();
    const oracleClient = new MockZKOracleClient();
    let scanCount = 0;

    const verifier = async (proof: PaymentProof, req: PaymentRequirement) => {
      return {
        valid: true,
        amount: req.minAmount,
        payer: proof.payer,
        recipient: req.recipient,
      };
    };

    const scanHandler = async (wallet: string) => {
      scanCount++;
      return {
        wallet,
        riskScore: (scanCount * 3) % 100,
        verdict: scanCount % 2 === 0 ? "SAFE" : "LOW RISK",
        anomalies: [],
      };
    };

    const server = createX402Server({
      store,
      recipient,
      oracleClient,
      enableOracle: true,
      paymentVerifier: verifier,
      scanHandler,
    });
    const { port, close } = await startServer(server);

    try {
      const CONCURRENCY = 25;
      const startTime = Date.now();

      // Launch 25 concurrent agent scan operations
      const tasks = Array.from({ length: CONCURRENCY }, async (_, idx) => {
        const clientPayer = Keypair.generate();
        const client = createRadarClient({
          baseUrl: `http://127.0.0.1:${port}`,
          x402Payer: clientPayer,
          recipient,
          oracleClient,
        });

        const target = Keypair.generate().publicKey.toBase58();
        const res = await client.scan(target);
        assert.equal(res.wallet, target);
        assert.ok(res.onchainLedgerSig);

        // Verify that on-chain ledger recorded it
        const ledger = await client.readOnchainLedger(target);
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].wallet, target);
        assert.equal(ledger[0].onchainSignature, res.onchainLedgerSig);

        return { target, sig: res.onchainLedgerSig };
      });

      const results = await Promise.all(tasks);
      const elapsedMs = Date.now() - startTime;

      assert.equal(results.length, CONCURRENCY);
      assert.equal(scanCount, CONCURRENCY);

      // Verify all signatures are distinct
      const uniqueSigs = new Set(results.map((r) => r.sig));
      assert.equal(uniqueSigs.size, CONCURRENCY);

      // Verify all settled in store
      for (const r of results) {
        assert.equal(oracleClient.getAllRecords().some((rec) => rec.onchainSignature === r.sig), true);
      }

      // Assert load completed within reasonable threshold
      assert.ok(elapsedMs < 10000, `25 concurrent scans completed in ${elapsedMs}ms (< 10000ms)`);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Security & Anti-Replay: payment signature replayed across calls is rejected with 402", async () => {
    const { store, dir } = tmpDb();
    const verifier = async (proof: PaymentProof, req: PaymentRequirement) => ({
      valid: true,
      amount: req.minAmount,
      payer: proof.payer,
      recipient: req.recipient,
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: verifier,
      scanHandler: async (wallet: string) => ({ wallet, riskScore: 0, verdict: "SAFE", anomalies: [] }),
    });
    const { port, close } = await startServer(server);

    try {
      const fixedProofSig = "sig_replayed_proof_token_12345678";
      const customPayer = async () => ({
        signature: fixedProofSig,
        payer: agentPayer,
      });

      const client = createRadarClient({
        baseUrl: `http://127.0.0.1:${port}`,
        paymentSigner: customPayer,
      });

      // First call succeeds and settles signature in SQLite
      const firstRes = await client.scan(safeTarget);
      assert.equal(firstRes.wallet, safeTarget);
      assert.equal(store.hasSettledPayment(fixedProofSig), true);

      // Second call using identical signature fails with 402 replay error
      await assert.rejects(
        () => client.scan(safeTarget),
        /Payment signature already settled|Payment required/i,
      );
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
