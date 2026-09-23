import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const DEPLOYER_PATH =
  process.env.DEPLOYER_KEYPAIR ||
  (process.env.SOLANA_KEY_DIR ? path.join(process.env.SOLANA_KEY_DIR, "devnet-deployer.json") : null) ||
  path.join(process.cwd(), "keys", "devnet-deployer.json");
if (!fs.existsSync(DEPLOYER_PATH)) {
  console.error(`Deployer keypair not found at ${DEPLOYER_PATH}. Set DEPLOYER_KEYPAIR or SOLANA_KEY_DIR.`);
  process.exit(1);
}
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, "utf8"))));
function deriveKp(label) {
  const seed = createHash("sha256").update(Buffer.concat([deployer.secretKey, Buffer.from(label)])).digest();
  return Keypair.fromSeed(seed);
}
for (const label of ["radar-buffer", "radar-buffer-reupgrade", "radar-buffer-fresh"]) {
  const kp = deriveKp(label);
  const acc = await conn.getAccountInfo(kp.publicKey);
  if (!acc) { console.log(`${label} ${kp.publicKey.toBase58()} -> not on chain`); continue; }
  const disc = acc.data.length > 0 ? acc.data[0] : -1;
  console.log(`${label} ${kp.publicKey.toBase58()} -> len=${acc.data.length} lamports=${acc.lamports} (${(acc.lamports / 1e9).toFixed(6)} SOL) disc=${disc} owner=${acc.owner.toBase58()}`);
}
// Find random buffers referenced by the 9/19 deploys (CLI-created)
for (const sig of [
  "vaMg3X7HeBqBR9qYNSYoGvLrdxh3pexaUWZH9i55QspD9ZvxpLJUbc7bdqNUgE1XZ2sGL3HgnXoBWPSu7sseCXG",
]) {
  try {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx) { console.log(`tx ${sig}: not found`); continue; }
    const seen = new Set();
    for (const msg of [tx.transaction.message, ...(tx.transaction.message ? [] : [])]) {
      // legacy message
    }
    const m = tx.transaction.message;
    const accounts = m.isCompiled ? [] : m.getAccountKeys();
    const keys = m.getAccountKeys ? m.getAccountKeys().toArray() : [];
    for (const k of keys) {
      if (seen.has(k.toBase58())) continue;
      seen.add(k.toBase58());
      const acc = await conn.getAccountInfo(k);
      if (acc && acc.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111" && acc.data.length > 10000) {
        console.log(`tx ${sig}: loader account ${k.toBase58()} len=${acc.data.length} lamports=${(acc.lamports / 1e9).toFixed(6)} SOL`);
      }
    }
  } catch (e) {
    console.log(`tx ${sig}: ${e.message}`);
  }
}
