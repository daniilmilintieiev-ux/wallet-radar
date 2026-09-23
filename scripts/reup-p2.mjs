// Re-upgrade P2's ProgramData from a FRESH buffer. This changes the ProgramData
// slot, which the devnet loader's buggy executable-cache keys off — a cheap attempt
// to bust the stale 12000-range cache while staying on PUBLIC devnet.
// Authority = radar-hook-program-keypair (P2's upgrade authority from the fresh deploy).
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";

const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const P2_DATA = new PublicKey(process.env.PROGRAM_DATA || "9L33ZtFxBErLSFfmVP7CC2WE9NYEu8zv9D4oUAXmm8tm");
const P2_PROGRAM = new PublicKey(process.env.PROGRAM || "7DeRG1BDToqYnfACzSdS4MfEwTGBCmkFo7Y61dmE2t2C");
const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SO_PATH = process.env.SO_PATH || "E:/JOB/earn/repos/wallet-radar/programs/radar-transfer-hook/target/deploy/radar_transfer_hook.so";
const BUFFER_LABEL = process.env.BUFFER_LABEL || "radar-buffer-reupgrade";
const BUFFER_METADATA = 37;

const DEPLOYER_PATH = process.env.DEPLOYER_KEYPAIR || "E:/JOB/earn/solana-keys/devnet-deployer.json";
const AUTHORITY_PATH = process.env.AUTHORITY_KEYPAIR || "E:/JOB/earn/solana-keys/radar-hook-program-keypair.json";
const conn = new Connection(RPC, "confirmed");
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_PATH, "utf8"))),
);
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"))),
);
function deriveKp(base, label) {
  const seed = createHash("sha256").update(Buffer.concat([base.secretKey, Buffer.from(label)])).digest();
  return Keypair.fromSeed(seed);
}
const bufferKp = deriveKp(deployer, BUFFER_LABEL);

const elf = fs.readFileSync(SO_PATH);
const elfLen = elf.length;
const bufferSpace = BUFFER_METADATA + elfLen;
console.log(`[reup] ELF ${elfLen} bytes; buffer ${bufferKp.publicKey.toBase58()}`);

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u64le(n) { const b = Buffer.alloc(8); b.writeUInt32LE(n >>> 0, 0); b.writeUInt32LE(Math.floor(n / 0x100000000) >>> 0, 4); return b; }
const InitializeBuffer = u32le(0);
const Write = (offset, bytes) => Buffer.concat([u32le(1), u32le(offset), u64le(bytes.length), Buffer.from(bytes)]);
const Upgrade = u32le(3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(fn, label, tries = 8) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const m = String(e?.message || e);
      const rl = /429|too many/i.test(m);
      const r = rl || /timeout|fetch failed|ECONN|socket|web?socket|5\d\d/i.test(m);
      if (!r || i >= tries) throw e;
      await sleep(rl ? Math.min(8000, 1000 * 2 ** (i - 1)) : 1000 * i);
    }
  }
}
let _bh = null, _bhAt = 0, _bhUses = 0;
async function getBlockhash(force = false) {
  const now = Date.now();
  if (!force && _bh && _bhUses < 15 && now - _bhAt < 25000) { _bhUses++; return _bh; }
  _bh = await rpc(() => conn.getLatestBlockhash("confirmed"), "bh"); _bhAt = now; _bhUses = 1; return _bh;
}
async function confirmSig(sig, label) {
  const dl = Date.now() + 90000;
  while (Date.now() < dl) {
    let st;
    try { st = await conn.getSignatureStatuses([sig]); } catch { await sleep(1500); continue; }
    const s = st.value[0];
    if (s) {
      if (s.err) {
        let logs = [];
        try { logs = (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages || []; } catch {}
        throw new Error(`${label} failed: ${JSON.stringify(s.err)}\n${logs.join("\n")}`);
      }
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return s;
    }
    await sleep(1500);
  }
  throw new Error(`${label} not confirmed (sig=${sig})`);
}
async function sendRaw(ix, signers) {
  const bh = await getBlockhash(true);
  const tx = new Transaction();
  tx.add(ix); tx.recentBlockhash = bh.blockhash; tx.feePayer = deployer.publicKey; tx.sign(...signers);
  return rpc(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 }), "sendRaw");
}

// ---- 1. Create + init buffer (idempotent) ----
// BUFFER_FUNDER=authority -> the upgrade authority pays rent+fee for the buffer
// (used when the deployer is out of SOL and the airdrop cap is hit).
const funder = process.env.BUFFER_FUNDER === "authority" ? authority : deployer;
const existing = await conn.getAccountInfo(bufferKp.publicKey);
if (existing == null) {
  const rent = await rpc(() => conn.getMinimumBalanceForRentExemption(bufferSpace), "rent");
  const initIx = new TransactionInstruction({
    programId: BPF_LOADER,
    keys: [
      { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: false, isWritable: false },
    ],
    data: InitializeBuffer,
  });
  const tx = new Transaction();
  tx.add(SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: bufferKp.publicKey, lamports: rent, space: bufferSpace, programId: BPF_LOADER }));
  tx.add(initIx);
  const bh = await getBlockhash(true);
  tx.recentBlockhash = bh.blockhash; tx.feePayer = funder.publicKey; tx.sign(funder, bufferKp);
  const sig = await rpc(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 }), "create");
  await confirmSig(sig, "buffer-create");
  console.log(`[reup] buffer created sig=${sig}`);
} else {
  console.log(`[reup] buffer already exists (len ${existing.data.length})`);
}

// ---- 2. Write ELF (chunked, 10 writes/tx) ----
const skipWrites = !!process.env.SKIP_WRITES && existing && existing.data.length === bufferSpace;
if (skipWrites) console.log(`[reup] SKIP_WRITES: buffer already ${existing.data.length} bytes, skipping writes`);
const CHUNK = 900, BATCH = 10;
const offsets = [];
for (let off = 0; off < elfLen; off += CHUNK) offsets.push(off);
let done = 0;
for (let bi = 0; !skipWrites && bi < offsets.length; bi += BATCH) {
  const batch = offsets.slice(bi, bi + BATCH);
  const bh = await getBlockhash(true);
  const sigs = [];
  for (const off of batch) {
    const chunk = elf.subarray(off, Math.min(off + CHUNK, elfLen));
    const ix = new TransactionInstruction({
      programId: BPF_LOADER,
      keys: [
        { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: Write(off, chunk),
    });
    sigs.push(await sendRaw(ix, [deployer, authority]));
    await sleep(120);
  }
  for (let round = 0; ; round++) {
    const st = await rpc(() => conn.getSignatureStatuses(sigs), "statuses");
    let allOk = true;
    for (let idx = 0; idx < sigs.length; idx++) {
      const s = st.value[idx];
      if (s && s.err) throw new Error(`write@${batch[idx]} failed: ${JSON.stringify(s.err)}`);
      if (!s || !(s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) allOk = false;
    }
    if (allOk) break;
    if (round >= 40) throw new Error(`batch @${batch[0]} not confirmed`);
    await sleep(1500);
  }
  done += batch.length;
  if (done % 50 < BATCH) console.log(`[reup] buffer ${done}/${offsets.length}`);
}
console.log(`[reup] buffer fully written (${done} chunks)`);

// ---- 3. Upgrade P2's ProgramData from the buffer ----
const before = (await conn.getAccountInfo(P2_DATA)).data;
const slotBefore = before.readBigUInt64LE(4);
console.log(`[reup] ProgramData slot BEFORE: ${slotBefore}`);
// v4.3.0-rc.0 loader (programs/bpf_loader/src/lib.rs:367-375) requires 7 accounts:
// 0=programdata(w) 1=program(w) 2=buffer(w) 3=spill(w) 4=rent 5=clock 6=authority(signer)
const upgradeIx = new TransactionInstruction({
  programId: BPF_LOADER,
  keys: [
    { pubkey: P2_DATA, isSigner: false, isWritable: true },
    { pubkey: P2_PROGRAM, isSigner: false, isWritable: true },
    { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ],
  data: Upgrade,
});
const tx = new Transaction();
tx.add(upgradeIx);
const bh2 = await getBlockhash(true);
tx.recentBlockhash = bh2.blockhash; tx.feePayer = deployer.publicKey; tx.sign(deployer, authority);
const sig = await rpc(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }), "upgrade");
await confirmSig(sig, "upgrade");
const after = (await conn.getAccountInfo(P2_DATA)).data;
console.log(`[reup] UPGRADE sig=${sig}`);
console.log(`[reup] ProgramData slot AFTER:  ${after.readBigUInt64LE(4)}  (len ${after.length})`);
console.log(`[reup] done — re-run flagged-retry.mjs to test the executable`);
