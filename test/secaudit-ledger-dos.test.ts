import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import { handleDashboardHttpRequest } from "../src/dashboard.js";
import { LightZKOracleClient, type ZKOracleClient, type ScanLedgerRecord } from "../src/oracle/index.js";

// SECAUDIT-H2: /dashboard and /api/ledger are unauthenticated. The wallet query
// parameter used to be passed unvalidated into the oracle reader, so every
// distinct string cost the server a burst of upstream RPC calls, and each one
// left a permanent entry in the in-memory anchorCache (unbounded growth, keyed
// by an attacker-chosen string of up to ~16 KB).

function countingOracle() {
  let queries = 0;
  const client: ZKOracleClient = {
    commit: async () => ({ signature: "x" }),
    query: async (): Promise<ScanLedgerRecord[]> => {
      queries++;
      return [];
    },
  };
  return { client, queries: () => queries };
}

async function withServer(oracle: ZKOracleClient, fn: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    void handleDashboardHttpRequest(req, res, { oracleClient: oracle }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("secaudit: ledger endpoints do not do upstream work for junk wallets", () => {
  test("/api/ledger rejects a non-base58 wallet with 400 and never queries the oracle", async () => {
    const o = countingOracle();
    await withServer(o.client, async (base) => {
      const junk = encodeURIComponent("not a wallet " + "A".repeat(2000));
      const res = await fetch(`${base}/api/ledger?wallet=${junk}`);
      assert.equal(res.status, 400);
      assert.equal(o.queries(), 0);
    });
  });

  test("/dashboard does not query the oracle for a junk wallet", async () => {
    const o = countingOracle();
    await withServer(o.client, async (base) => {
      const res = await fetch(`${base}/dashboard?wallet=${encodeURIComponent("<script>alert(1)</script>")}`);
      assert.equal(o.queries(), 0);
      const html = await res.text();
      assert.ok(!html.includes("<script>alert(1)</script>"), "junk wallet must never be reflected unescaped");
    });
  });

  test("a valid wallet is still queried", async () => {
    const o = countingOracle();
    await withServer(o.client, async (base) => {
      const w = Keypair.generate().publicKey.toBase58();
      const res = await fetch(`${base}/api/ledger?wallet=${w}`);
      assert.equal(res.status, 200);
      assert.equal(o.queries(), 1);
    });
  });
});

describe("secaudit: oracle anchor cache is bounded", () => {
  test("querying many distinct wallets does not grow anchorCache without limit", async () => {
    const oracleKp = Keypair.generate();
    const conn = { getSignaturesForAddress: async () => [], getTransactions: async () => [] };
    const client = new LightZKOracleClient({
      rpcUrl: "https://mock-rpc.invalid",
      oraclePublicKey: oracleKp.publicKey.toBase58(),
      connectionFactory: () => conn as never,
    });
    for (let i = 0; i < 3000; i++) {
      await client.query(Keypair.generate().publicKey.toBase58(), 5);
    }
    const size = (client as unknown as { anchorCache: Map<string, unknown> }).anchorCache.size;
    assert.ok(size <= 1000, `anchorCache grew to ${size} entries`);
  });
});
