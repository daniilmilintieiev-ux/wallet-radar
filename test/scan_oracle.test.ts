import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createX402Server, PaymentProof, PaymentRequirement } from "../src/x402server.js";
import { buildServer } from "../src/mcp.js";
import { MockZKOracleClient } from "../src/oracle/index.js";
import { Store } from "../src/store.js";
import { EnhancedTx } from "../src/types.js";

function tmpDb(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-oracle-scan-test-"));
  const dbPath = path.join(dir, "test.db");
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

describe("Wire oracle into scan path (x402 and MCP)", () => {
  const recipient = "RecipientWallet111111111111111111111111111";
  const payer = "PayerWallet1111111111111111111111111111111";
  const targetWallet = "DemoTargetWallet1111111111111111111111111";

  const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
    return { valid: true, amount: req.minAmount, payer: proof.payer, recipient: req.recipient };
  };

  test("x402 /scan: best-effort commitScan when oracle enabled via oracleClient", async () => {
    const { store, dir } = tmpDb();
    const mockOracle = new MockZKOracleClient();

    const stubScan = async (wallet: string) => ({
      wallet,
      txCount: 15,
      riskScore: 75,
      anomalies: [
        { type: "LARGE_SWAP", wallet, severity: "high", timestamp: 1000, evidence: {}, text: "large swap" },
        { type: "NEW_VENUE", wallet, severity: "medium", timestamp: 1001, evidence: {}, text: "new venue" },
      ],
      txSignatures: ["sigTx1", "sigTx2"],
      digest: "High risk activity detected",
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
      scanHandler: stubScan,
      oracleClient: mockOracle,
      enableOracle: true,
    });
    const { port, close } = await startServer(server);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": "sig_paid_scan_1",
          "X-Payment-Payer": payer,
        },
        body: JSON.stringify({ wallet: targetWallet }),
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.wallet, targetWallet);
      assert.equal(json.riskScore, 75);
      assert.equal(json.verdict, "HIGH RISK");
      assert.ok(json.onchainLedgerSig, "should include onchainLedgerSig");
      assert.ok(json.onchainLedgerSig.startsWith("sig_"));
      assert.ok(json.oracle, "should include oracle result object");
      assert.equal(json.oracle.success, true);
      assert.equal(json.oracle.signature, json.onchainLedgerSig);

      // Verify record was stored in mock oracle
      const records = await mockOracle.query(targetWallet);
      assert.equal(records.length, 1);
      assert.equal(records[0].wallet, targetWallet);
      assert.equal(records[0].riskScore, 75);
      assert.equal(records[0].verdict, "HIGH RISK");
      assert.deepEqual(records[0].topRules, ["LARGE_SWAP", "NEW_VENUE"]);
      assert.deepEqual(records[0].txSignatures, ["sigTx1", "sigTx2"]);
      assert.equal(records[0].onchainSignature, json.onchainLedgerSig);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("x402 /scan: oracle failure is best-effort and does not break the scan", async () => {
    const { store, dir } = tmpDb();
    const mockOracle = new MockZKOracleClient();
    mockOracle.setFailCommit("Simulated Light Protocol RPC timeout");

    const stubScan = async (wallet: string) => ({
      wallet,
      txCount: 5,
      riskScore: 10,
      anomalies: [],
      digest: "Clean history",
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
      scanHandler: stubScan,
      oracleClient: mockOracle,
      enableOracle: true,
    });
    const { port, close } = await startServer(server);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": "sig_paid_scan_2",
          "X-Payment-Payer": payer,
        },
        body: JSON.stringify({ wallet: targetWallet }),
      });

      // Crucial requirement: scan must still succeed with 200
      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.wallet, targetWallet);
      assert.equal(json.riskScore, 10);
      assert.equal(json.verdict, "LOW RISK");
      // onchainLedgerSig is omitted or null when commit failed
      assert.equal(json.onchainLedgerSig, undefined);
      assert.ok(json.oracle);
      assert.equal(json.oracle.success, false);
      assert.match(json.oracle.error, /Simulated Light Protocol RPC timeout/);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("x402 /scan: oracle commit is skipped when oracle is disabled", async () => {
    const { store, dir } = tmpDb();
    const mockOracle = new MockZKOracleClient();

    const stubScan = async (wallet: string) => ({
      wallet,
      txCount: 1,
      riskScore: 0,
      anomalies: [],
      digest: "All safe",
    });

    const server = createX402Server({
      store,
      recipient,
      paymentVerifier: stubVerifier,
      scanHandler: stubScan,
      oracleClient: mockOracle,
      enableOracle: false, // explicitly disabled
    });
    const { port, close } = await startServer(server);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": "sig_paid_scan_3",
          "X-Payment-Payer": payer,
        },
        body: JSON.stringify({ wallet: targetWallet }),
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.wallet, targetWallet);
      assert.equal(json.onchainLedgerSig, undefined);
      assert.equal(json.oracle, undefined);
      assert.equal(mockOracle.getAllRecords().length, 0);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MCP radar_scan: best-effort oracle commit when oracleClient is injected", async () => {
    const mockOracle = new MockZKOracleClient();
    const server = buildServer({ oracleClient: mockOracle, enableOracle: true });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const responses = new Map<number, any>();
    clientTransport.onmessage = (msg: any) => {
      if (msg.id !== undefined) responses.set(msg.id, msg);
    };
    await clientTransport.start();

    let id = 1;
    const request = async (method: string, params: unknown): Promise<any> => {
      const reqId = id++;
      await clientTransport.send({ jsonrpc: "2.0", id: reqId, method, params } as any);
      while (!responses.has(reqId)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return responses.get(reqId)!;
    };

    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
      await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as any);

      // Calling radar_scan without HELIUS_API_KEY returns error content gracefully
      const origKey = process.env.HELIUS_API_KEY;
      delete process.env.HELIUS_API_KEY;

      const noKeyRes = await request("tools/call", {
        name: "radar_scan",
        arguments: { wallet: targetWallet },
      });
      assert.equal(noKeyRes.result?.isError, true);
      assert.match(noKeyRes.result?.content?.[0]?.text, /HELIUS_API_KEY is not set/);

      if (origKey) process.env.HELIUS_API_KEY = origKey;
    } finally {
      await server.close();
      await clientTransport.close();
    }
  });

  test("MCP radar_scan: successful scan commits attestation to oracle and returns onchainLedgerSig", async () => {
    const mockOracle = new MockZKOracleClient();
    const stubTxs: EnhancedTx[] = [
      {
        signature: "sigMcp1",
        timestamp: 1_700_000_000,
        source: "JUPITER",
        programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      },
    ];

    const server = buildServer({
      oracleClient: mockOracle,
      enableOracle: true,
      fetchTxs: async () => stubTxs,
      fetchPrices: async () => null,
      fetchMintRisk: async () => ({}),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const responses = new Map<number, any>();
    clientTransport.onmessage = (msg: any) => {
      if (msg.id !== undefined) responses.set(msg.id, msg);
    };
    await clientTransport.start();

    let id = 1;
    const request = async (method: string, params: unknown): Promise<any> => {
      const reqId = id++;
      await clientTransport.send({ jsonrpc: "2.0", id: reqId, method, params } as any);
      while (!responses.has(reqId)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return responses.get(reqId)!;
    };

    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
      await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as any);

      const res = await request("tools/call", {
        name: "radar_scan",
        arguments: { wallet: targetWallet },
      });

      assert.equal(res.result?.isError, undefined);
      const text = res.result?.content?.[0]?.text;
      assert.ok(text);
      const data = JSON.parse(text);

      assert.equal(data.wallet, targetWallet);
      assert.equal(typeof data.riskScore, "number");
      assert.equal(typeof data.verdict, "string");
      assert.ok(data.onchainLedgerSig, "should include onchainLedgerSig");
      assert.ok(data.onchainLedgerSig.startsWith("sig_"));
      assert.ok(data.oracle);
      assert.equal(data.oracle.success, true);
      assert.equal(data.oracle.signature, data.onchainLedgerSig);

      // Verify stored in mock oracle
      const records = await mockOracle.query(targetWallet);
      assert.equal(records.length, 1);
      assert.equal(records[0].wallet, targetWallet);
      assert.equal(records[0].onchainSignature, data.onchainLedgerSig);
      assert.deepEqual(records[0].txSignatures, ["sigMcp1"]);
    } finally {
      await server.close();
      await clientTransport.close();
    }
  });

  test("MCP radar_scan: oracle failure does not break the scan result", async () => {
    const mockOracle = new MockZKOracleClient();
    mockOracle.setFailCommit("Simulated network timeout in oracle commit");

    const stubTxs: EnhancedTx[] = [
      {
        signature: "sigMcp2",
        timestamp: 1_700_000_100,
        source: "RAYDIUM",
        programs: [],
      },
    ];

    const server = buildServer({
      oracleClient: mockOracle,
      enableOracle: true,
      fetchTxs: async () => stubTxs,
      fetchPrices: async () => null,
      fetchMintRisk: async () => ({}),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const responses = new Map<number, any>();
    clientTransport.onmessage = (msg: any) => {
      if (msg.id !== undefined) responses.set(msg.id, msg);
    };
    await clientTransport.start();

    let id = 1;
    const request = async (method: string, params: unknown): Promise<any> => {
      const reqId = id++;
      await clientTransport.send({ jsonrpc: "2.0", id: reqId, method, params } as any);
      while (!responses.has(reqId)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return responses.get(reqId)!;
    };

    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
      await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as any);

      const res = await request("tools/call", {
        name: "radar_scan",
        arguments: { wallet: targetWallet },
      });

      // Crucial: isError must not be true!
      assert.equal(res.result?.isError, undefined);
      const text = res.result?.content?.[0]?.text;
      assert.ok(text);
      const data = JSON.parse(text);

      assert.equal(data.wallet, targetWallet);
      assert.equal(data.onchainLedgerSig, undefined);
      assert.ok(data.oracle);
      assert.equal(data.oracle.success, false);
      assert.match(data.oracle.error, /Simulated network timeout in oracle commit/);
    } finally {
      await server.close();
      await clientTransport.close();
    }
  });
});
