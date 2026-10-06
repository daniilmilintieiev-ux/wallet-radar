// secaudit: is the oracle memo payload (RADAR_ORACLE: + binary RS01 record + 96-byte Ed25519 trailer) valid UTF-8?
// The SPL Memo program rejects non-UTF-8 instruction data. No network. Usage: node scripts/audit/oracle-memo-utf8.mjs [repo-root]
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
const root = path.resolve(process.argv[2] ?? ".");
const L = await import(pathToFileURL(path.join(root, "dist/src/oracle/ledger.js")).href);
const dec = new TextDecoder("utf-8", { fatal: true });
let valid = 0, N = 2000;
for (let i = 0; i < N; i++) {
  const oracle = Keypair.generate();
  const wallet = Keypair.generate().publicKey.toBase58();
  const rec = { wallet, riskScore: 40, verdict: "SUSPICIOUS", timestamp: 1_790_000_000, topRules: ["LARGE_SWAP"], txSignatures: [] };
  const att = L.signAttestation(rec, oracle);
  const buf = L.serializeScanRecord({ ...rec, ...att });
  const memo = Buffer.concat([Buffer.from("RADAR_ORACLE:"), buf]);
  try { dec.decode(memo); valid++; } catch {}
}
console.log(JSON.stringify({ N, validUtf8: valid }));
