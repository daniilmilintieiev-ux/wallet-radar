import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { Keypair } from "@solana/web3.js";
import { createServer } from "../src/http-server.js";
import { Store } from "../src/store.js";

// SECAUDIT-H3: with no RADAR_API_TOKEN the server used to accept the mutating
// control-plane routes (/defense/:wallet/clear, /watch, /unwatch, /poll) from
// anyone who could reach the port. The default bind address is 0.0.0.0, GET
// /defense lists every wallet under a stance, and the body parser accepts
// text/plain JSON, so even a drive-by browser page can send these requests.
// Fail closed: without a token they are refused unless explicitly opted in.

const NOW = Math.floor(Date.now() / 1000);

async function start(store: Store, opts: Parameters<typeof createServer>[0] = {}) {
  const server = createServer({ store, rateLimitPerMin: 0, apiKey: "k", ...opts });
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

function freshStore() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "radar-secaudit-auth-"));
  return { store: new Store(path.join(dir, "radar.db")), dir };
}

describe("secaudit: mutating endpoints fail closed without RADAR_API_TOKEN", () => {
  test("no token: /defense/:wallet/clear is refused and the blocked stance survives", async () => {
    const prev = process.env.RADAR_API_TOKEN;
    const prevOpt = process.env.RADAR_ALLOW_UNAUTH_MUTATIONS;
    delete process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_ALLOW_UNAUTH_MUTATIONS;
    const { store, dir } = freshStore();
    const wallet = Keypair.generate().publicKey.toBase58();
    store.setDefenseState(wallet, { state: "blocked", riskAt: 90, setAt: NOW, quietStreak: 0, actions: 1 });
    const s = await start(store);
    try {
      const res = await fetch(`${s.base}/defense/${wallet}/clear`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      assert.equal(res.status, 403);
      assert.equal(store.getDefenseState(wallet)?.state, "blocked", "defense stance must not be reset by an anonymous caller");
    } finally {
      await s.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (prev !== undefined) process.env.RADAR_API_TOKEN = prev;
      if (prevOpt !== undefined) process.env.RADAR_ALLOW_UNAUTH_MUTATIONS = prevOpt;
    }
  });

  test("no token: /watch, /unwatch and /poll are refused; reads stay open", async () => {
    const prev = process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_API_TOKEN;
    delete process.env.RADAR_ALLOW_UNAUTH_MUTATIONS;
    const { store, dir } = freshStore();
    const wallet = Keypair.generate().publicKey.toBase58();
    const s = await start(store);
    try {
      for (const p of ["/watch", "/unwatch", "/poll"]) {
        const res = await fetch(`${s.base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
        assert.equal(res.status, 403, `${p} must be refused without a configured token`);
      }
      assert.equal(store.listWallets().length, 0, "nothing may be added to the watchlist anonymously");
      assert.equal((await fetch(`${s.base}/watch`)).status, 200);
      assert.equal((await fetch(`${s.base}/defense`)).status, 200);
      assert.equal((await fetch(`${s.base}/selftest`, { method: "POST", body: "{}" })).status, 200);
    } finally {
      await s.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (prev !== undefined) process.env.RADAR_API_TOKEN = prev;
    }
  });

  test("explicit opt-in (option or RADAR_ALLOW_UNAUTH_MUTATIONS=1) restores the old open behaviour", async () => {
    delete process.env.RADAR_API_TOKEN;
    const { store, dir } = freshStore();
    const wallet = Keypair.generate().publicKey.toBase58();
    const s = await start(store, { allowUnauthenticatedMutations: true });
    try {
      const res = await fetch(`${s.base}/watch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
      assert.equal(res.status, 200);
    } finally {
      await s.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with a token configured, behaviour is unchanged (401 without it, 200 with it)", async () => {
    const { store, dir } = freshStore();
    const wallet = Keypair.generate().publicKey.toBase58();
    const s = await start(store, { apiToken: "tok-123" });
    try {
      const body = JSON.stringify({ wallet });
      const h = { "content-type": "application/json" };
      assert.equal((await fetch(`${s.base}/watch`, { method: "POST", headers: h, body })).status, 401);
      assert.equal((await fetch(`${s.base}/watch`, { method: "POST", headers: { ...h, Authorization: "Bearer tok-123" }, body })).status, 200);
    } finally {
      await s.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
