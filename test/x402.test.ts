import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import {
  createX402Server,
  extractPaymentProof,
  PaymentProof,
  PaymentRequirement,
  verifySolanaPaymentRpc,
  X402_PRICING,
} from "../src/x402server.js";
import { getVersion } from "../src/mcp-server.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverScript = path.join(rootDir, "dist/src/x402server.js");
const binScript = path.join(rootDir, "bin/x402-server");

function tmpDb(): { store: Store; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-x402-test-"));
  const dbPath = path.join(dir, "test.db");
  const store = new Store(dbPath);
  return { store, dir, dbPath };
}

function runCommand(file: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: rootDir }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: err ? ((err.code as number) ?? 1) : 0,
      });
    });
  });
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

test("x402: GET /selftest is free (no payment needed)", async () => {
  const { store, dir } = tmpDb();
  const server = createX402Server({ store });
  const { port, close } = await startServer(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/selftest`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const json = (await res.json()) as any;
    assert.equal(json.ok, true);
    assert.equal(typeof json.riskScore, "number");
    assert.ok(Array.isArray(json.anomalies));
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: POST /scan returns 402 without payment", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";
  const server = createX402Server({ store, recipient });
  const { port, close } = await startServer(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: "DemoWappet11111111111111111111111111111111" }),
    });

    assert.equal(res.status, 402);
    assert.equal(res.headers.get("x-payment-required"), "true");
    assert.equal(res.headers.get("x-payment-amount"), "0.005");
    assert.equal(res.headers.get("x-payment-currency"), "USDC");
    assert.equal(res.headers.get("x-payment-recipient"), recipient);

    const json = (await res.json()) as any;
    assert.equal(json.error, "Payment Required");
    assert.equal(json.x402.amount, 0.005);
    assert.equal(json.x402.recipient, recipient);
    assert.equal(json.x402.token, "USDC");
    assert.ok(json.x402.proofFormat);
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: POST /scan returns 402 on insufficient amount", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";
  const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
    return {
      valid: false,
      error: `Insufficient payment: found 0.001 USDC, required ${req.minAmount} USDC`,
      amount: 0.001,
    };
  };

  const server = createX402Server({
    store,
    recipient,
    paymentVerifier: stubVerifier,
  });
  const { port, close } = await startServer(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Signature": "sig_insufficient_123",
        "X-Payment-Payer": "PayerWappet1111111111111111111111111111111",
      },
      body: JSON.stringify({ wallet: "DemoWappet11111111111111111111111111111111" }),
    });

    assert.equal(res.status, 402);
    const json = (await res.json()) as any;
    assert.equal(json.error, "Payment Required");
    assert.ok(json.detail.includes("Insufficient payment"));
    // Signature was not settled
    assert.equal(store.hasSettledPayment("sig_insufficient_123"), false);
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: 200 + correct result on valid payment, then 402 on replayed signature", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";
  const payer = "PayerWappet1111111111111111111111111111111";
  const sig = "sig_valid_payment_456";

  const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
    if (proof.signature === sig && proof.payer === payer) {
      return { valid: true, amount: 0.005, payer, recipient };
    }
    return { valid: false, error: "Invalid payment" };
  };

  const stubScan = async (wallet: string) => ({
    wallet,
    txCount: 42,
    riskScore: 15,
    anomalies: [],
    digest: "All clear",
  });

  const server = createX402Server({
    store,
    recipient,
    paymentVerifier: stubVerifier,
    scanHandler: stubScan,
  });
  const { port, close } = await startServer(server);

  try {
    // First request with valid payment -> 200
    const res1 = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Signature": sig,
        "X-Payment-Payer": payer,
      },
      body: JSON.stringify({ wallet: "TargetWappet111111111111111111111111111111" }),
    });

    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as any;
    assert.equal(body1.wallet, "TargetWappet111111111111111111111111111111");
    assert.equal(body1.txCount, 42);
    assert.equal(body1.riskScore, 15);

    // Verify signature was settled in store ledger
    assert.equal(store.hasSettledPayment(sig), true);
    const settled = store.getSettledPayment(sig);
    assert.ok(settled);
    assert.equal(settled.amount, 0.005);
    assert.equal(settled.endpoint, "/scan");

    // Second request with REPLAYED signature -> 402
    const res2 = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Signature": sig,
        "X-Payment-Payer": payer,
      },
      body: JSON.stringify({ wallet: "TargetWappet111111111111111111111111111111" }),
    });

    assert.equal(res2.status, 402);
    const body2 = (await res2.json()) as any;
    assert.equal(body2.error, "Payment Required");
    assert.ok(body2.detail.includes("already settled (replay rejected)"));
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: POST /analyze with Authorization and JSON header proof schemes", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";

  const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
    assert.equal(req.minAmount, 0.001); // analyze pricing
    return { valid: true, amount: 0.001, payer: proof.payer, recipient };
  };

  const server = createX402Server({
    store,
    recipient,
    paymentVerifier: stubVerifier,
  });
  const { port, close } = await startServer(server);

  try {
    const txFixture = [
      { signature: "s1", timestamp: 1700000000, source: "JUPITER", programs: [] },
    ];

    // Format 1: Authorization: x402 <sig>:<payer>
    const resAuth = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "x402 sig_auth_101:payer_auth_101",
      },
      body: JSON.stringify({ wallet: "AnalyzeWallet1", txs: txFixture }),
    });
    assert.equal(resAuth.status, 200);
    const jsonAuth = (await resAuth.json()) as any;
    assert.equal(jsonAuth.wallet, "AnalyzeWallet1");
    assert.equal(jsonAuth.txCount, 1);
    assert.equal(store.hasSettledPayment("sig_auth_101"), true);

    // Format 2: X-Payment JSON string header
    const resXPay = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment": JSON.stringify({ signature: "sig_json_102", payer: "payer_json_102" }),
      },
      body: JSON.stringify({ wallet: "AnalyzeWallet2", txs: txFixture }),
    });
    assert.equal(resXPay.status, 200);
    const jsonXPay = (await resXPay.json()) as any;
    assert.equal(jsonXPay.wallet, "AnalyzeWallet2");
    assert.equal(store.hasSettledPayment("sig_json_102"), true);

    // Format 3: in body payment: { signature, payer }
    const resBody = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: "AnalyzeWallet3",
        txs: txFixture,
        payment: { signature: "sig_body_103", payer: "payer_body_103" },
      }),
    });
    assert.equal(resBody.status, 200);
    assert.equal(store.hasSettledPayment("sig_body_103"), true);
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: GET /health returns service status and pricing", async () => {
  const { store, dir } = tmpDb();
  const server = createX402Server({ store, recipient: "DemoRecipient" });
  const { port, close } = await startServer(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.ok, true);
    assert.equal(json.service, "wallet-radar-x402");
    assert.equal(json.pricing["/scan"], 0.005);
    assert.equal(json.pricing["/analyze"], 0.001);
    assert.equal(json.pricing["/selftest"], 0.0);
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402-server CLI: --version and --health flags", async () => {
  const resVer = await runCommand("node", [serverScript, "--version"]);
  assert.equal(resVer.code, 0);
  assert.equal(resVer.stdout.trim(), getVersion());

  const resHealth = await runCommand("node", [serverScript, "--health"]);
  assert.equal(resHealth.code, 0);
  const health = JSON.parse(resHealth.stdout.trim());
  assert.equal(health.ok, true);
  assert.equal(health.name, "wallet-radar-x402");
  assert.equal(health.pricing["/scan"], 0.005);

  // Test bin/x402-server
  const binVer = await runCommand("node", [binScript, "--version"]);
  assert.equal(binVer.code, 0);
  assert.equal(binVer.stdout.trim(), getVersion());
});

test("verifySolanaPaymentRpc: verifies parsed RPC response and handles errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Transaction not found
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", result: null }));
    const r1 = await verifySolanaPaymentRpc(
      { signature: "s_missing", payer: "p1" },
      { endpoint: "/scan", recipient: "r1", minAmount: 0.005 },
      "http://mock-rpc",
    );
    assert.equal(r1.valid, false);
    assert.ok(r1.error?.includes("not found"));

    // 2. Transaction failed on-chain
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", result: { meta: { err: { InstructionError: [0, "Custom"] } } } }));
    const r2 = await verifySolanaPaymentRpc(
      { signature: "s_err", payer: "p1" },
      { endpoint: "/scan", recipient: "r1", minAmount: 0.005 },
      "http://mock-rpc",
    );
    assert.equal(r2.valid, false);
    assert.ok(r2.error?.includes("failed on-chain"));

    // 3. Valid transaction with postTokenBalances delta
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            blockTime: Math.floor(Date.now() / 1000) - 60,
            meta: {
              err: null,
              preTokenBalances: [
                { accountIndex: 2, owner: "Recipient111", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", uiTokenAmount: { uiAmount: 1.0 } },
              ],
              postTokenBalances: [
                { accountIndex: 2, owner: "Recipient111", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", uiTokenAmount: { uiAmount: 1.005 } },
              ],
            },
          },
        }),
      );

    const r3 = await verifySolanaPaymentRpc(
      { signature: "s_ok", payer: "Payer111" },
      { endpoint: "/scan", recipient: "Recipient111", minAmount: 0.005, maxAgeSec: 3600 },
      "http://mock-rpc",
    );
    assert.equal(r3.valid, true);
    assert.equal(r3.amount, 0.005);
    assert.equal(r3.recipient, "Recipient111");

    // 4. Insufficient amount in transfer
    const r4 = await verifySolanaPaymentRpc(
      { signature: "s_insufficient", payer: "Payer111" },
      { endpoint: "/scan", recipient: "Recipient111", minAmount: 0.010, maxAgeSec: 3600 },
      "http://mock-rpc",
    );
    assert.equal(r4.valid, false);
    assert.ok(r4.error?.includes("Insufficient payment"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("x402: 404 for unknown endpoints", async () => {
  const { store, dir } = tmpDb();
  const server = createX402Server({ store });
  const { port, close } = await startServer(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/unknown-route`);
    assert.equal(res.status, 404);
    const json = (await res.json()) as { error: string };
    assert.ok(json.error.includes("Not Found"));
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: POST /scan returns 400 on malformed JSON body", async () => {
  const { store, dir } = tmpDb();
  const server = createX402Server({ store });
  const { port, close } = await startServer(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Signature": "valid_sig_123",
        "X-Payment-Payer": "payer_123",
      },
      body: "malformed JSON {{{{",
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.ok(json.error.includes("Invalid JSON"));
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractPaymentProof returns null when headers are missing or malformed", () => {
  const req = {
    headers: {},
  } as any;
  assert.equal(extractPaymentProof(req), null);

  const reqBadAuth = {
    headers: { authorization: "Bearer token123" }, // not x402
  } as any;
  assert.equal(extractPaymentProof(reqBadAuth), null);

  // Authorization x402 without colon
  const reqBadAuthNoColon = {
    headers: { authorization: "x402 only_signature_no_colon" },
  } as any;
  assert.equal(extractPaymentProof(reqBadAuthNoColon), null);

  // X-Payment with malformed JSON string (not valid json, no colon)
  const reqBadXPay = {
    headers: { "x-payment": "{broken json" },
  } as any;
  assert.equal(extractPaymentProof(reqBadXPay), null);

  // X-Payment with colon format string parses correctly
  const reqColon = {
    headers: { "x-payment": "sig_colon_1:payer_colon_1" },
  } as any;
  assert.deepEqual(extractPaymentProof(reqColon), {
    signature: "sig_colon_1",
    payer: "payer_colon_1",
  });
});

test("verifySolanaPaymentRpc: rejects transactions exceeding maxAgeSec", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const oldBlockTime = Math.floor(Date.now() / 1000) - 7200; // 2 hours old
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            blockTime: oldBlockTime,
            meta: {
              err: null,
              preTokenBalances: [{ accountIndex: 1, owner: "R1", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", uiTokenAmount: { uiAmount: 0 } }],
              postTokenBalances: [{ accountIndex: 1, owner: "R1", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", uiTokenAmount: { uiAmount: 1 } }],
            },
          },
        }),
      );

    const res = await verifySolanaPaymentRpc(
      { signature: "s_old", payer: "p1" },
      { endpoint: "/scan", recipient: "R1", minAmount: 0.005, maxAgeSec: 3600 },
      "http://mock-rpc",
    );
    assert.equal(res.valid, false);
    assert.match(res.error ?? "", /Transaction too old/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifySolanaPaymentRpc: falls back to parsed instructions and inner instructions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Top-level instruction transferChecked
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
            transaction: {
              message: {
                instructions: [
                  {
                    parsed: {
                      type: "transferChecked",
                      info: {
                        destination: "RecipientParsed1",
                        tokenAmount: { uiAmount: 0.005 },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      );

    const res1 = await verifySolanaPaymentRpc(
      { signature: "s_inst", payer: "Payer1" },
      { endpoint: "/scan", recipient: "RecipientParsed1", minAmount: 0.005 },
      "http://mock-rpc",
    );
    assert.equal(res1.valid, true);
    assert.equal(res1.amount, 0.005);

    // 2. Inner instruction transfer
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            meta: {
              err: null,
              preTokenBalances: [],
              postTokenBalances: [],
              innerInstructions: [
                {
                  instructions: [
                    {
                      parsed: {
                        type: "transfer",
                        info: {
                          destination: "RecipientInner1",
                          amount: "5000", // 5000 / 1e6 = 0.005
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
      );

    const res2 = await verifySolanaPaymentRpc(
      { signature: "s_inner", payer: "Payer1" },
      { endpoint: "/scan", recipient: "RecipientInner1", minAmount: 0.005 },
      "http://mock-rpc",
    );
    assert.equal(res2.valid, true);
    assert.equal(res2.amount, 0.005);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifySolanaPaymentRpc: ignores non-target mint balances and handles RPC errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Different mint transferred (not USDC) -> insufficient payment
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            meta: {
              err: null,
              preTokenBalances: [{ accountIndex: 1, owner: "R_MINT", mint: "RandomMint11111111111111111111111111111111", uiTokenAmount: { uiAmount: 0 } }],
              postTokenBalances: [{ accountIndex: 1, owner: "R_MINT", mint: "RandomMint11111111111111111111111111111111", uiTokenAmount: { uiAmount: 500 } }],
            },
          },
        }),
      );

    const resMint = await verifySolanaPaymentRpc(
      { signature: "s_wrong_mint", payer: "P1" },
      { endpoint: "/scan", recipient: "R_MINT", minAmount: 0.005 },
      "http://mock-rpc",
    );
    assert.equal(resMint.valid, false);
    assert.match(resMint.error ?? "", /Insufficient payment/);

    // 2. RPC returns HTTP 500
    globalThis.fetch = async () =>
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });

    const res500 = await verifySolanaPaymentRpc(
      { signature: "s_500", payer: "P1" },
      { endpoint: "/scan", recipient: "R1", minAmount: 0.005 },
      "http://mock-rpc",
    );
    assert.equal(res500.valid, false);
    assert.match(res500.error ?? "", /RPC HTTP error 500/);

    // 3. RPC returns JSON-RPC error payload
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", error: { message: "Node lagging" } }));

    const resRpcErr = await verifySolanaPaymentRpc(
      { signature: "s_rpc_err", payer: "P1" },
      { endpoint: "/scan", recipient: "R1", minAmount: 0.005 },
      "http://mock-rpc",
    );
    assert.equal(resRpcErr.valid, false);
    assert.match(resRpcErr.error ?? "", /Node lagging/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("x402: parameter validation errors do NOT settle payment signature", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";
  const payer = "PayerWappet1111111111111111111111111111111";
  const sigScan = "sig_valid_but_missing_wallet_param";
  const sigAnalyze = "sig_valid_but_missing_txs_param";

  const stubVerifier = async (proof: PaymentProof, req: PaymentRequirement) => {
    return { valid: true, amount: req.minAmount, payer, recipient };
  };

  const server = createX402Server({
    store,
    recipient,
    paymentVerifier: stubVerifier,
  });
  const { port, close } = await startServer(server);

  try {
    // 1. POST /scan with valid payment but missing wallet param -> 400
    const resScan = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Signature": sigScan,
        "X-Payment-Payer": payer,
      },
      body: JSON.stringify({}), // missing wallet!
    });
    assert.equal(resScan.status, 400);
    const dataScan = (await resScan.json()) as any;
    assert.match(dataScan.error, /body.wallet must be a Solana base58 address/);
    assert.equal(store.hasSettledPayment(sigScan), false, "signature must not be settled on 400 error");

    // 2. POST /analyze with valid payment but missing txs -> 400
    const resAnalyze = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Signature": sigAnalyze,
        "X-Payment-Payer": payer,
      },
      body: JSON.stringify({ wallet: "W1" }), // missing txs!
    });
    assert.equal(resAnalyze.status, 400);
    const dataAnalyze = (await resAnalyze.json()) as any;
    assert.match(dataAnalyze.error, /Missing required parameters/);
    assert.equal(store.hasSettledPayment(sigAnalyze), false, "signature must not be settled on 400 error");

    // 3. GET /scan returns 405 Method Not Allowed
    const resGetScan = await fetch(`http://127.0.0.1:${port}/scan`);
    assert.equal(resGetScan.status, 405);
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});




test("x402: paid endpoint rejects X-Payment-Dry-Run: true", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";
  const payer = "PayerWappet1111111111111111111111111111111";

  const server = createX402Server({
    store,
    recipient,
    paymentVerifier: async () => ({ valid: true, amount: 0.005, payer, recipient }),
    scanHandler: async () => ({ ok: true }),
  });
  const { port, close } = await startServer(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Signature": "sig_dry_run_attempt",
        "X-Payment-Payer": payer,
        "X-Payment-Dry-Run": "true",
      },
      body: JSON.stringify({ wallet: "TargetWappet111111111111111111111111111111" }),
    });

    assert.equal(res.status, 402);
    const body = (await res.json()) as any;
    assert.ok(body.detail?.includes("Dry-run payments not allowed"));
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: concurrent requests with identical signature are guarded against replay", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";
  const payer = "PayerWappet1111111111111111111111111111111";
  const sig = "sig_concurrent_replay_race";

  let verifierDelayMs = 50;
  const server = createX402Server({
    store,
    recipient,
    paymentVerifier: async () => {
      await new Promise((r) => setTimeout(r, verifierDelayMs));
      return { valid: true, amount: 0.005, payer, recipient };
    },
    scanHandler: async () => ({ ok: true }),
  });
  const { port, close } = await startServer(server);

  try {
    // Launch 2 concurrent requests with the identical signature
    const [res1, res2] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": sig,
          "X-Payment-Payer": payer,
        },
        body: JSON.stringify({ wallet: "TargetWappet111111111111111111111111111111" }),
      }),
      fetch(`http://127.0.0.1:${port}/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Signature": sig,
          "X-Payment-Payer": payer,
        },
        body: JSON.stringify({ wallet: "TargetWappet111111111111111111111111111111" }),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // Exactly one should succeed (200) and the other should be rejected (402)
    assert.deepEqual(statuses, [200, 402]);
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("x402: body > 1MB returns 413 Payload Too Large", async () => {
  const { store, dir } = tmpDb();
  const recipient = "RecipientWappet111111111111111111111111111";
  const server = createX402Server({ store, recipient });
  const { port, close } = await startServer(server);

  try {
    const hugePayload = "x".repeat(1_050_000);
    const res = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: hugePayload,
    });
    assert.equal(res.status, 413);
  } finally {
    await close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

