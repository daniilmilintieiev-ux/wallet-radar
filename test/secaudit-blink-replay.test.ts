import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import { createX402Server } from "../src/x402server.js";
import { Store } from "../src/store.js";

// SECAUDIT-M2: the Blink /api/actions/radar-scan/complete verifier did
// check-then-record (hasSettledPayment, await verify, recordSettledPayment) with
// no in-flight guard, and ignored recordSettledPayment's boolean. N concurrent
// requests carrying ONE payment signature could all pass the check while the
// first was still verifying, and all got a scan. It now shares the in-flight set
// with the main paid flow and honours the INSERT result.

describe("secaudit M2: Blink complete route cannot be replayed concurrently", () => {
  after(() => new Promise<void>((r) => setTimeout(r, 200)));

  test("5 concurrent requests with the same signature -> exactly one success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-blink-replay-"));
    const store = new Store(path.join(dir, "t.db"));
    const recipient = Keypair.generate().publicKey.toBase58();
    const target = Keypair.generate().publicKey.toBase58();
    const payer = Keypair.generate().publicKey.toBase58();
    let verifyCalls = 0;
    const server = createX402Server({
      store,
      recipient,
      scanHandler: async () => ({ ok: true, riskScore: 25 }),
      // Slow verifier: every request is "mid-verification" at the same time.
      paymentVerifier: async () => {
        verifyCalls++;
        await new Promise((r) => setTimeout(r, 150));
        return { valid: true, amount: 0.005, payer };
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const fire = () =>
        fetch(`http://127.0.0.1:${port}/api/actions/radar-scan/complete?wallet=${target}&signature=sameSig111`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: payer }),
        }).then(async (r) => {
          await r.arrayBuffer();
          return r.status;
        });
      const statuses = await Promise.all([fire(), fire(), fire(), fire(), fire()]);
      const ok = statuses.filter((s) => s === 200).length;
      assert.equal(ok, 1, `expected exactly one 200, got ${JSON.stringify(statuses)}`);
      assert.equal(statuses.filter((s) => s === 402).length, 4, `others must be rejected with 402: ${JSON.stringify(statuses)}`);
      assert.equal(verifyCalls, 1, "in-flight guard must stop duplicate verification work");
      assert.equal(store.hasSettledPayment("sameSig111"), true);

      // and a later sequential replay is still rejected
      assert.equal(await fire(), 402);
    } finally {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed verification releases the in-flight slot so the legitimate retry can succeed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-blink-replay-"));
    const store = new Store(path.join(dir, "t.db"));
    const recipient = Keypair.generate().publicKey.toBase58();
    const target = Keypair.generate().publicKey.toBase58();
    const payer = Keypair.generate().publicKey.toBase58();
    let attempt = 0;
    const server = createX402Server({
      store,
      recipient,
      scanHandler: async () => ({ ok: true, riskScore: 25 }),
      paymentVerifier: async () => (++attempt === 1 ? { valid: false, error: "not confirmed yet" } : { valid: true, amount: 0.005, payer }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const call = () =>
        fetch(`http://127.0.0.1:${port}/api/actions/radar-scan/complete?wallet=${target}&signature=retrySig222`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: payer }),
        }).then(async (r) => {
          await r.arrayBuffer();
          return r.status;
        });
      assert.equal(await call(), 402);
      assert.equal(await call(), 200);
    } finally {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
