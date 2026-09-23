import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildActionsJson,
  buildRadarScanActionGet,
  buildRadarScanActionPost,
  buildBlinkUrl,
  buildWalletDeepLink,
  getBlinkRegistrationManifest,
  handleBlinkHttpRequest,
  ACTIONS_CORS_HEADERS,
} from "../src/blink/index.js";
import { createX402Server } from "../src/x402server.js";
import { Store } from "../src/store.js";
import { USDC_MINT } from "../src/types.js";

function tmpDb(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-blink-test-"));
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

describe("Solana Actions & Blinks (src/blink)", () => {
  const payerKeypair = Keypair.generate();
  const payerAccount = payerKeypair.publicKey.toBase58();
  const targetWalletKeypair = Keypair.generate();
  const targetWallet = targetWalletKeypair.publicKey.toBase58();
  const recipientKeypair = Keypair.generate();
  const recipientAddress = recipientKeypair.publicKey.toBase58();

  test("buildActionsJson: produces standard actions.json discovery rules", () => {
    const json = buildActionsJson();
    assert.ok(Array.isArray(json.rules));
    assert.equal(json.rules.length, 2);
    assert.equal(json.rules[0].pathPattern, "/scan/*");
    assert.equal(json.rules[0].apiPath, "/api/actions/radar-scan?wallet=*");
    assert.equal(json.rules[1].pathPattern, "/api/actions/**");
    assert.equal(json.rules[1].apiPath, "/api/actions/**");
  });

  test("buildRadarScanActionGet: produces compliant ActionGetResponse metadata", () => {
    // 1. Discovery view (no target wallet pre-selected)
    const getRes = buildRadarScanActionGet();
    assert.equal(getRes.type, "action");
    assert.ok(getRes.icon);
    assert.equal(getRes.title, "Wallet Radar: On-chain Risk Scan");
    assert.equal(getRes.label, "Scan Wallet");
    assert.ok(getRes.links?.actions);
    assert.equal(getRes.links.actions.length, 1);
    const action = getRes.links.actions[0];
    assert.equal(action.type, "transaction");
    assert.ok(action.href.includes("/api/actions/radar-scan?wallet={wallet}"));
    assert.equal(action.parameters?.[0].name, "wallet");
    assert.equal(action.parameters?.[0].required, true);

    // 2. Specific target wallet view
    const targetedRes = buildRadarScanActionGet({
      targetWallet,
      priceUsdc: 0.005,
    });
    assert.ok(targetedRes.title.includes(targetWallet.slice(0, 4)));
    assert.ok(targetedRes.description.includes(targetWallet));
    assert.ok(targetedRes.label.includes("0.005 USDC"));
    assert.equal(targetedRes.links?.actions?.[0].href, `/api/actions/radar-scan?wallet=${targetWallet}`);
  });

  test("buildRadarScanActionPost: builds signable transaction with memo and USDC transfer", async () => {
    const postRes = await buildRadarScanActionPost(payerAccount, targetWallet, {
      recipient: recipientAddress,
      priceUsdc: 0.005,
      recentBlockhash: "11111111111111111111111111111111",
    });

    assert.equal(postRes.type, "transaction");
    assert.ok(typeof postRes.transaction === "string");
    assert.ok(postRes.message?.includes(targetWallet.slice(0, 4)));

    // Deserialize transaction and verify instructions
    const txBuf = Buffer.from(postRes.transaction, "base64");
    const tx = Transaction.from(txBuf);

    assert.equal(tx.feePayer?.toBase58(), payerAccount);
    assert.equal(tx.recentBlockhash, "11111111111111111111111111111111");
    // [memo, ataSource(idempotent), ataDest(idempotent), transfer] — audit 2.7
    assert.equal(tx.instructions.length, 4);

    // Instruction 0: Audit Memo
    const memoIx = tx.instructions[0];
    assert.equal(memoIx.programId.toBase58(), "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    const memoStr = memoIx.data.toString("utf-8");
    assert.ok(memoStr.startsWith(`RadarScan:${targetWallet}`));

    // Instructions 1-2: idempotent ATA creation (no-op if the account exists)
    const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    assert.equal(tx.instructions[1].programId.toBase58(), ATA_PROGRAM);
    assert.equal(tx.instructions[1].data.readUInt8(0), 1); // create_idempotent
    assert.equal(tx.instructions[2].programId.toBase58(), ATA_PROGRAM);
    assert.equal(tx.instructions[2].data.readUInt8(0), 1);

    // Instruction 3: SPL Token transfer
    const transferIx = tx.instructions[3];
    assert.equal(transferIx.programId.toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    assert.equal(transferIx.data.readUInt8(0), 3); // SPL transfer instruction index
    assert.equal(transferIx.data.readBigUInt64LE(1), 5000n); // 0.005 USDC = 5000 micro-units
  });

  test("buildRadarScanActionPost: rejects invalid public keys with descriptive error", async () => {
    await assert.rejects(
      async () => {
        await buildRadarScanActionPost("invalid_pubkey", targetWallet);
      },
      { message: /Invalid account public key/i },
    );

    await assert.rejects(
      async () => {
        await buildRadarScanActionPost(payerAccount, "invalid_target");
      },
      { message: /Invalid target wallet public key/i },
    );
  });

  test("buildBlinkUrl and buildWalletDeepLink: generates Dialect, Phantom, and Solflare URLs", () => {
    const actionUrl = "https://wallet-radar.app/api/actions/radar-scan";

    const dialectUrl = buildBlinkUrl(actionUrl, { provider: "dialect" });
    assert.ok(dialectUrl.startsWith("https://dial.to/?action="));
    assert.ok(dialectUrl.includes(encodeURIComponent(`solana-action:${actionUrl}`)));

    const dialectDevnet = buildBlinkUrl(actionUrl, { provider: "dialect", cluster: "devnet" });
    assert.ok(dialectDevnet.includes("&cluster=devnet"));

    const phantomUrl = buildWalletDeepLink("phantom", actionUrl);
    assert.ok(phantomUrl.startsWith("https://phantom.app/ul/browse/"));
    assert.ok(phantomUrl.includes("ref=wallet-radar"));

    const solflareUrl = buildWalletDeepLink("solflare", actionUrl);
    assert.ok(solflareUrl.startsWith("https://solflare.com/ul/v1/browse/"));
  });

  test("getBlinkRegistrationManifest: produces complete registry payload", () => {
    const manifest = getBlinkRegistrationManifest("https://api.wallet-radar.app", recipientAddress);

    assert.equal(manifest.name, "Wallet Radar");
    assert.equal(manifest.actionUrl, "https://api.wallet-radar.app/api/actions/radar-scan");
    assert.equal(manifest.actionsJsonUrl, "https://api.wallet-radar.app/actions.json");
    assert.equal(manifest.pricing.amount, 0.005);
    assert.equal(manifest.pricing.token, "USDC");
    assert.equal(manifest.pricing.mint, USDC_MINT);
    assert.equal(manifest.pricing.recipient, recipientAddress);
    assert.ok(manifest.deepLinks.dialect.startsWith("https://dial.to/?action="));
    assert.ok(manifest.deepLinks.phantom.startsWith("https://phantom.app/ul/browse/"));
    assert.ok(manifest.deepLinks.solflare.startsWith("https://solflare.com/ul/v1/browse/"));
    assert.equal(manifest.deepLinks.protocol, `solana-action:${manifest.actionUrl}`);
  });

  test("HTTP server integration: handles OPTIONS CORS preflight on Actions endpoints", async () => {
    const { store, dir } = tmpDb();
    const server = createX402Server({ store, recipient: recipientAddress });
    const { port, close } = await startServer(server);

    try {
      // 1. OPTIONS /actions.json
      const res1 = await fetch(`http://127.0.0.1:${port}/actions.json`, {
        method: "OPTIONS",
      });
      assert.equal(res1.status, 204);
      assert.equal(res1.headers.get("access-control-allow-origin"), "*");
      assert.ok(res1.headers.get("access-control-allow-methods")?.includes("POST"));

      // 2. OPTIONS /api/actions/radar-scan
      const res2 = await fetch(`http://127.0.0.1:${port}/api/actions/radar-scan`, {
        method: "OPTIONS",
      });
      assert.equal(res2.status, 204);
      assert.equal(res2.headers.get("access-control-allow-origin"), "*");
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HTTP server integration: serves /actions.json discovery file with CORS", async () => {
    const { store, dir } = tmpDb();
    const server = createX402Server({ store, recipient: recipientAddress });
    const { port, close } = await startServer(server);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions.json`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.equal(res.headers.get("content-type"), "application/json");

      const data = (await res.json()) as any;
      assert.ok(Array.isArray(data.rules));
      assert.equal(data.rules[0].pathPattern, "/scan/*");
      assert.equal(data.rules[0].apiPath, "/api/actions/radar-scan?wallet=*");
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HTTP server integration: handles GET /api/actions/radar-scan metadata and targeted scan", async () => {
    const { store, dir } = tmpDb();
    const server = createX402Server({ store, recipient: recipientAddress });
    const { port, close } = await startServer(server);

    try {
      // General discovery GET
      const res1 = await fetch(`http://127.0.0.1:${port}/api/actions/radar-scan`);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers.get("access-control-allow-origin"), "*");
      const meta1 = (await res1.json()) as any;
      assert.equal(meta1.type, "action");
      assert.equal(meta1.title, "Wallet Radar: On-chain Risk Scan");
      assert.equal(meta1.links.actions[0].parameters[0].name, "wallet");

      // Targeted wallet GET
      const res2 = await fetch(`http://127.0.0.1:${port}/api/actions/radar-scan?wallet=${targetWallet}`);
      assert.equal(res2.status, 200);
      const meta2 = (await res2.json()) as any;
      assert.ok(meta2.title.includes(targetWallet.slice(0, 4)));
      assert.ok(meta2.links.actions[0].href.includes(targetWallet));
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HTTP server integration: handles POST /api/actions/radar-scan generating serialized signable transaction", async () => {
    const { store, dir } = tmpDb();
    const server = createX402Server({ store, recipient: recipientAddress });
    const { port, close } = await startServer(server);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/actions/radar-scan?wallet=${targetWallet}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: payerAccount,
        }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const data = (await res.json()) as any;
      assert.equal(data.type, "transaction");
      assert.ok(typeof data.transaction === "string");
      assert.ok(data.message.includes(targetWallet.slice(0, 4)));

      // Verify transaction deserialization
      // [memo, ataSource(idempotent), ataDest(idempotent), transfer] — audit 2.7
      const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
      assert.equal(tx.feePayer?.toBase58(), payerAccount);
      assert.equal(tx.instructions.length, 4);
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HTTP server integration: POST returns 400 when account or wallet is missing", async () => {
    const { store, dir } = tmpDb();
    const server = createX402Server({ store, recipient: recipientAddress });
    const { port, close } = await startServer(server);

    try {
      // Missing account
      const res1 = await fetch(`http://127.0.0.1:${port}/api/actions/radar-scan?wallet=${targetWallet}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res1.status, 400);
      const json1 = (await res1.json()) as any;
      assert.ok(json1.error.includes("account"));

      // Missing wallet parameter
      const res2 = await fetch(`http://127.0.0.1:${port}/api/actions/radar-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: payerAccount }),
      });
      assert.equal(res2.status, 400);
      const json2 = (await res2.json()) as any;
      assert.ok(json2.error.includes("wallet"));
    } finally {
      await close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
