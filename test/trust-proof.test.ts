import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import { Store } from "../src/store.js";
import { MockZKOracleClient, ScanLedgerRecord } from "../src/oracle/index.js";
import { buildTrustProof, TrustProofBundle } from "../src/trust-proof.js";
import { createServer } from "../src/http-server.js";
import { createX402Server } from "../src/x402server.js";
import { createRadarClient } from "../src/sdk/index.js";

describe("/trust-proof — independently verifiable attestation bundle", () => {
  const flaggedKp = Keypair.generate();
  const flaggedWallet = flaggedKp.publicKey.toBase58();
  const payerKp = Keypair.generate();
  const payerWallet = payerKp.publicKey.toBase58();
  const unknownKp = Keypair.generate();
  const unknownWallet = unknownKp.publicKey.toBase58();

  function makeTmpDb(): { dbPath: string; cleanup: () => void } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-trustproof-test-"));
    const dbPath = path.join(tmpDir, "radar.db");
    return {
      dbPath,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  test("buildTrustProof: flagged wallet with on-chain ZK attestation and x402 payment receipt", async () => {
    const { dbPath, cleanup } = makeTmpDb();
    const store = new Store(dbPath);
    const mockOracle = new MockZKOracleClient();

    try {
      const nowSec = 1726700000;

      // 1. Commit on-chain ZK scan attestation into oracle
      const scanRecord: ScanLedgerRecord = {
        wallet: flaggedWallet,
        riskScore: 90,
        verdict: "HIGH RISK",
        timestamp: nowSec,
        topRules: ["REGIME_SHIFT", "TOXIC_MINT"],
        txSignatures: ["txSigFlagged1111111111111111111111111111111111111111111111111111111111"],
      };
      await mockOracle.commit(scanRecord);

      // 2. Record x402 payment in store
      const paymentSig = "paySig111111111111111111111111111111111111111111111111111111111111";
      store.recordSettledPayment({
        signature: paymentSig,
        payer: payerWallet,
        recipient: "Recipient1111111111111111111111111111111111",
        amount: 0.005,
        endpoint: "/scan",
        wallet: flaggedWallet,
      }, nowSec);

      // 3. Build trust proof
      const proof = await buildTrustProof(flaggedWallet, {
        oracleClient: mockOracle,
        store,
        nowSec,
      });

      assert.equal(proof.wallet, flaggedWallet);
      assert.equal(proof.verified, true);
      assert.ok(proof.attestation !== null);
      assert.ok(proof.attestation.signature?.startsWith("sig_"));
      assert.ok(typeof proof.attestation.slot === "number");
      assert.ok(proof.attestation.compressedAddress?.startsWith("comp_"));
      assert.equal(proof.attestation.timestamp, nowSec);

      assert.equal(proof.riskScore, 90);
      assert.equal(proof.verdict, "HIGH RISK");
      assert.deepEqual(proof.topRules, ["REGIME_SHIFT", "TOXIC_MINT"]);

      assert.ok(proof.payment !== null);
      assert.equal(proof.payment.payer, payerWallet);
      assert.equal(proof.payment.amountUsdc, 0.005);
      assert.equal(proof.payment.txSignature, paymentSig);
      assert.equal(proof.payment.signature, paymentSig);
      assert.equal(proof.payment.settledAt, nowSec);

      assert.equal(proof.generatedAt, nowSec);
    } finally {
      store.close();
      cleanup();
    }
  });

  test("buildTrustProof: flagged wallet with on-chain ZK attestation but free / unpaid", async () => {
    const { dbPath, cleanup } = makeTmpDb();
    const store = new Store(dbPath);
    const mockOracle = new MockZKOracleClient();

    try {
      const nowSec = 1726700000;
      const scanRecord: ScanLedgerRecord = {
        wallet: flaggedWallet,
        riskScore: 65,
        verdict: "SUSPICIOUS",
        timestamp: nowSec,
        topRules: ["LARGE_SWAP"],
        txSignatures: ["txSigFree111111111111111111111111111111111111111111111111111111111111"],
      };
      await mockOracle.commit(scanRecord);

      const proof = await buildTrustProof(flaggedWallet, {
        oracleClient: mockOracle,
        store,
        nowSec,
      });

      assert.equal(proof.wallet, flaggedWallet);
      assert.equal(proof.verified, true);
      assert.ok(proof.attestation !== null);
      assert.equal(proof.riskScore, 65);
      assert.equal(proof.verdict, "SUSPICIOUS");
      assert.deepEqual(proof.topRules, ["LARGE_SWAP"]);
      assert.equal(proof.payment, null);
    } finally {
      store.close();
      cleanup();
    }
  });

  test("buildTrustProof: unknown wallet returns graceful empty/null bundle", async () => {
    const mockOracle = new MockZKOracleClient();

    const proof = await buildTrustProof(unknownWallet, {
      oracleClient: mockOracle,
    });

    assert.equal(proof.wallet, unknownWallet);
    assert.equal(proof.verified, false);
    assert.equal(proof.attestation, null);
    assert.equal(proof.riskScore, null);
    assert.equal(proof.verdict, "UNKNOWN");
    assert.deepEqual(proof.topRules, []);
    assert.equal(proof.payment, null);
    assert.ok(typeof proof.generatedAt === "number");
  });

  test("http-server: GET /trust-proof returns attestation bundle and validates input", async () => {
    const { dbPath, cleanup } = makeTmpDb();
    const store = new Store(dbPath);
    const mockOracle = new MockZKOracleClient();

    const scanRecord: ScanLedgerRecord = {
      wallet: flaggedWallet,
      riskScore: 88,
      verdict: "HIGH RISK",
      timestamp: 1726700100,
      topRules: ["DORMANT_ACTIVE"],
      txSignatures: ["txSig1"],
    };
    await mockOracle.commit(scanRecord);

    const paymentSig = "paySig222222222222222222222222222222222222222222222222222222222222";
    store.recordSettledPayment({
      signature: paymentSig,
      payer: payerWallet,
      recipient: "Recipient1111111111111111111111111111111111",
      amount: 0.005,
      endpoint: "/scan",
      wallet: flaggedWallet,
    }, 1726700100);

    const server = createServer({
      store,
      oracleClient: mockOracle,
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Successful GET /trust-proof?wallet=<flaggedWallet>
      const res1 = await fetch(`${baseUrl}/trust-proof?wallet=${flaggedWallet}`);
      assert.equal(res1.status, 200);
      const data1 = (await res1.json()) as TrustProofBundle;
      assert.equal(data1.wallet, flaggedWallet);
      assert.equal(data1.verified, true);
      assert.equal(data1.riskScore, 88);
      assert.equal(data1.verdict, "HIGH RISK");
      assert.deepEqual(data1.topRules, ["DORMANT_ACTIVE"]);
      assert.equal(data1.payment?.amountUsdc, 0.005);
      assert.equal(data1.payment?.txSignature, paymentSig);

      // 2. Unknown wallet GET /trust-proof?wallet=<unknownWallet>
      const res2 = await fetch(`${baseUrl}/trust-proof?wallet=${unknownWallet}`);
      assert.equal(res2.status, 200);
      const data2 = (await res2.json()) as TrustProofBundle;
      assert.equal(data2.verified, false);
      assert.equal(data2.attestation, null);
      assert.equal(data2.riskScore, null);
      assert.equal(data2.verdict, "UNKNOWN");
      assert.deepEqual(data2.topRules, []);
      assert.equal(data2.payment, null);

      // 3. Missing wallet query parameter
      const res3 = await fetch(`${baseUrl}/trust-proof`);
      assert.equal(res3.status, 400);
      const err3 = await res3.json();
      assert.match(err3.error, /wallet query parameter is required/);

      // 4. Invalid base58 address
      const res4 = await fetch(`${baseUrl}/trust-proof?wallet=bad_not_base58_wallet!!!`);
      assert.equal(res4.status, 400);
      const err4 = await res4.json();
      assert.match(err4.error, /must be a Solana base58 address/);

      // 5. POST /trust-proof with body
      const res5 = await fetch(`${baseUrl}/trust-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: flaggedWallet }),
      });
      assert.equal(res5.status, 200);
      const data5 = (await res5.json()) as TrustProofBundle;
      assert.equal(data5.wallet, flaggedWallet);
      assert.equal(data5.verified, true);
      assert.equal(data5.riskScore, 88);

      // 6. POST /trust-proof with invalid wallet
      const res6 = await fetch(`${baseUrl}/trust-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: "not-base58!" }),
      });
      assert.equal(res6.status, 400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      cleanup();
    }
  });

  test("x402server: GET /trust-proof serves verifiable attestation bundle", async () => {
    const { dbPath, cleanup } = makeTmpDb();
    const store = new Store(dbPath);
    const mockOracle = new MockZKOracleClient();

    const scanRecord: ScanLedgerRecord = {
      wallet: flaggedWallet,
      riskScore: 78,
      verdict: "HIGH RISK",
      timestamp: 1726700200,
      topRules: ["REGIME_SHIFT"],
      txSignatures: ["txSigX402"],
    };
    await mockOracle.commit(scanRecord);

    const x402Srv = createX402Server({
      store,
      oracleClient: mockOracle,
      recipient: "F6wWPy4c3fXTJDqU19Nax8FhQumeMcsSVpD2YwxLpBNR",
    });

    await new Promise<void>((resolve) => x402Srv.listen(0, "127.0.0.1", resolve));
    const port = (x402Srv.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${baseUrl}/trust-proof?wallet=${flaggedWallet}`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as TrustProofBundle;
      assert.equal(data.wallet, flaggedWallet);
      assert.equal(data.verified, true);
      assert.equal(data.riskScore, 78);
      assert.equal(data.verdict, "HIGH RISK");
      assert.deepEqual(data.topRules, ["REGIME_SHIFT"]);
    } finally {
      await new Promise<void>((resolve) => x402Srv.close(() => resolve()));
      store.close();
      cleanup();
    }
  });

  test("RadarClient SDK: client.trustProof(wallet) retrieves bundle", async () => {
    const mockOracle = new MockZKOracleClient();
    const scanRecord: ScanLedgerRecord = {
      wallet: flaggedWallet,
      riskScore: 82,
      verdict: "HIGH RISK",
      timestamp: 1726700300,
      topRules: ["TOXIC_MINT"],
      txSignatures: ["txSigSdk"],
    };
    await mockOracle.commit(scanRecord);

    const server = createServer({
      oracleClient: mockOracle,
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const client = createRadarClient({ baseUrl, oracleClient: mockOracle });
      const bundle = await client.trustProof(flaggedWallet);

      assert.equal(bundle.wallet, flaggedWallet);
      assert.equal(bundle.verified, true);
      assert.equal(bundle.riskScore, 82);
      assert.equal(bundle.verdict, "HIGH RISK");
      assert.deepEqual(bundle.topRules, ["TOXIC_MINT"]);
      assert.equal(bundle.payment, null);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
