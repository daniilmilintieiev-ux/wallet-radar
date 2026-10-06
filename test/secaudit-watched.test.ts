import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../src/http-server.js";
import { Store } from "../src/store.js";
import type { EnhancedTx } from "../src/types.js";

// SECAUDIT-M1: /scan persists a scoring profile via saveBaseline, which used to
// INSERT into the same `wallets` table the watch loop iterates. An anonymous
// /scan therefore added the scanned wallet to the poll list (unbounded growth,
// upstream API cost). `wallets.watched` now separates the two: only /watch and
// `radar add` set watched=1; /scan keeps saving the profile (scoring unchanged).

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const W = "5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8";

function swap(sig: string, ts: number, inAmt: number, outAmt: number): EnhancedTx {
  return {
    signature: sig,
    timestamp: ts,
    source: "JUPITER",
    type: "SWAP",
    programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    swap: {
      tokenInputs: [{ mint: USDC, rawTokenAmount: { tokenAmount: String(Math.round(inAmt * 1e6)), decimals: 6 } }],
      tokenOutputs: [{ mint: MEME, rawTokenAmount: { tokenAmount: String(Math.round(outAmt * 1e6)), decimals: 6 } }],
    },
  };
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "radar-secaudit-watched-"));
  return { dir, file: path.join(dir, "radar.db") };
}

async function start(store: Store, txs: () => EnhancedTx[]) {
  const server = createServer({
    store,
    rateLimitPerMin: 0,
    apiKey: "k",
    allowUnauthenticatedMutations: true,
    fetchTxs: async () => txs(),
    fetchPrices: async () => ({ [USDC]: 1, [MEME]: 0.01 }),
    fetchMintRisk: async () => ({}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const post = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
};

describe("secaudit M1: /scan does not enrol a wallet in the watch loop", () => {
  after(() => new Promise<void>((r) => setTimeout(r, 200)));

  test("anonymous /scan keeps the profile but does not add the wallet to the poll list; /watch does", async () => {
    const { dir, file } = tmpDb();
    const store = new Store(file);
    const batch = [swap("a", 1_700_000_000, 100, 10_000), swap("b", 1_700_000_100, 100, 10_000), swap("c", 1_700_000_200, 100, 10_000), swap("d", 1_700_000_300, 100, 10_000)];
    const s = await start(store, () => batch);
    try {
      const scan = await post(`${s.base}/scan`, { wallet: W });
      assert.equal(scan.status, 200);
      assert.deepEqual(store.listWallets(), [], "scan must not add the wallet to the poll list");
      assert.equal(store.isWatched(W), false);
      assert.ok(store.getBaseline(W) !== null, "scoring profile is still persisted");

      const watch = await post(`${s.base}/watch`, { wallet: W });
      assert.equal(watch.status, 200);
      assert.deepEqual(store.listWallets(), [W]);
      assert.equal(store.isWatched(W), true);
      assert.ok(store.getBaseline(W) !== null, "watching an already-scanned wallet keeps its profile");

      // a later scan must not flip the flag back
      await post(`${s.base}/scan`, { wallet: W });
      assert.deepEqual(store.listWallets(), [W]);

      // many distinct anonymous scans never grow the poll list
      const other = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
      await post(`${s.base}/scan`, { wallet: other });
      assert.deepEqual(store.listWallets(), [W]);
      assert.equal(store.hasWallet(other), true);
    } finally {
      await s.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repeat /scan verdict is unchanged by the watched flag (profile still used for scoring)", async () => {
    const { dir, file } = tmpDb();
    const store = new Store(file);
    const history = [swap("a", 1_700_000_000, 100, 10_000), swap("b", 1_700_000_100, 100, 10_000), swap("c", 1_700_000_200, 100, 10_000), swap("d", 1_700_000_300, 100, 10_000)];
    const withBig = [...history, swap("e", 1_700_000_400, 5000, 500_000)];
    let current = history;
    const s = await start(store, () => current);
    try {
      await post(`${s.base}/scan`, { wallet: W });
      current = withBig;
      const second = (await post(`${s.base}/scan`, { wallet: W })).json as { riskScore: number; verdict: string; anomalies: Array<{ type: string }> };
      // Second scan scored against the stored profile: the 50x swap must still be flagged.
      assert.ok(second.anomalies.some((a) => a.type === "LARGE_SWAP"), "LARGE_SWAP must still fire against the persisted profile");
      assert.ok(second.riskScore > 0);
    } finally {
      await s.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secaudit M1: migration of pre-existing databases", () => {
  test("an old wallets table without `watched` gets the column and every existing row is watched=1", () => {
    const { dir, file } = tmpDb();
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE wallets (address TEXT PRIMARY KEY, added_at INTEGER NOT NULL, baseline_json TEXT);`);
    old.prepare("INSERT INTO wallets (address, added_at, baseline_json) VALUES (?, ?, NULL)").run(W, 1);
    old.prepare("INSERT INTO wallets (address, added_at, baseline_json) VALUES (?, ?, NULL)").run("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", 2);
    old.close();

    const store = new Store(file);
    assert.deepEqual(store.listWallets(), [W, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"], "existing watch list is preserved");
    store.close();

    // idempotent: a second open must not re-mark rows that were later de-watched / scan-only
    const again = new Store(file);
    again.saveBaseline({ walletAddress: "6Qp6gJ7hY9mBq9RjVwq5Z2dYy8pXk3nXhVv3nH7uJ5kA", lastSeenAt: 1 } as never);
    again.close();
    const third = new Store(file);
    assert.equal(third.listWallets().length, 2, "scan-only row added after migration stays unwatched");
    third.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
