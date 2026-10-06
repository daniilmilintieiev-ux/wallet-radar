// Prints /scan results for a fixed fixture sequence against a built tree, so the
// output of two builds (before/after the secaudit M1 change) can be diffed.
// Usage: node scripts/audit/m1-scan-compare.mjs <path-to-build-root-containing-dist/src>
// No network: fetchers are injected. Only timestamp-free fields are printed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] ?? ".");
const { createServer } = await import(pathToFileURL(path.join(root, "dist/src/http-server.js")).href);
const { Store } = await import(pathToFileURL(path.join(root, "dist/src/store.js")).href);

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WALLETS = ["5nY93xYzVdqbtrsU2PjEmwkJNJogsnKjLYNGCMdFjJM8", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"];
const swap = (sig, ts, i, o) => ({
  signature: sig, timestamp: ts, source: "JUPITER", type: "SWAP",
  programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
  swap: {
    tokenInputs: [{ mint: USDC, rawTokenAmount: { tokenAmount: String(Math.round(i * 1e6)), decimals: 6 } }],
    tokenOutputs: [{ mint: MEME, rawTokenAmount: { tokenAmount: String(Math.round(o * 1e6)), decimals: 6 } }],
  },
});
const history = [swap("a", 1_700_000_000, 100, 10_000), swap("b", 1_700_000_100, 100, 10_000), swap("c", 1_700_000_200, 100, 10_000), swap("d", 1_700_000_300, 100, 10_000)];
const big = [...history, swap("e", 1_700_000_400, 5000, 500_000)];
const bigger = [...big, swap("f", 1_700_000_500, 9000, 900_000), swap("g", 1_700_000_600, 9000, 900_000)];
const sequence = [history, big, bigger, bigger];

const dir = mkdtempSync(path.join(tmpdir(), "m1-compare-"));
const store = new Store(path.join(dir, "radar.db"));
let current = history;
const server = createServer({
  store, rateLimitPerMin: 0, apiKey: "k",
  fetchTxs: async () => current,
  fetchPrices: async () => ({ [USDC]: 1, [MEME]: 0.01 }),
  fetchMintRisk: async () => ({}),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const out = [];
for (const wallet of WALLETS) {
  for (let i = 0; i < sequence.length; i++) {
    current = sequence[i];
    const res = await fetch(`${base}/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
    const j = await res.json();
    out.push({ wallet, step: i, status: res.status, riskScore: j.riskScore, verdict: j.verdict, anomalies: (j.anomalies ?? []).map((a) => `${a.type}:${a.severity}`), txCount: j.txCount });
  }
}
console.log(JSON.stringify(out, null, 2));
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
store.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
