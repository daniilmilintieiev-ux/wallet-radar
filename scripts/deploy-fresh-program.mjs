// Deploys a FRESH SBF program (BPF upgradeable loader) from a temporary buffer.
// This is `solana program deploy` (NOT an upgrade): it allocates a brand-new
// program account AND a brand-new ProgramData account via DeployWithMaxDataLen,
// so the on-chain executable is built from scratch (no stale loader cache).
//
// Why fresh instead of upgrade: the devnet BPF loader (4.3.0-rc.0) keeps a stale
// executable cache across `Upgrade`, so the upgraded program still returned the
// old 12000-range error codes. A brand-new program has a fresh executable.
//
// Layout (from solana-program `bpf_loader_upgradeable`):
//   Buffer:    [ 37 bytes metadata ][ program bytes ... ]   (size_of_buffer_metadata = 37)
//   Program:   [ 36 bytes state    ]                        (size_of_program = 36)
//   ProgramData: [ 45 bytes metadata ][ program bytes ... ]  (size_of_programdata_metadata = 45)
//
// The program account is a REGULAR system account (owner = BPF upgradeable
// loader), and its ProgramData is a PDA:
//     programdata = Pubkey::find_program_address(&[program_key], BPF_LOADER)
// (verified: this reproduces the existing ASXvQYqh... -> GFD5PTTL... mapping).
//
// Instruction data is bincode FIXINT: the enum discriminant is a fixed 4-byte LE
// u32, and DeployWithMaxDataLen carries a fixed 8-byte LE u64 `max_data_len`.
//   node scripts/deploy-fresh-program.mjs
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";

const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const BUFFER_METADATA = 37; // size_of_buffer_metadata()
const PROGRAM_SIZE = 36; // size_of_program()
const PROGRAMDATA_METADATA = 45; // size_of_programdata_metadata()

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DEPLOYER_PATH = process.env.DEPLOYER_KEYPAIR || "E:/JOB/earn/solana-keys/devnet-deployer.json";
const AUTHORITY_PATH = process.env.AUTHORITY_KEYPAIR || "E:/JOB/earn/solana-keys/radar-hook-program-keypair.json";
// Deterministic label for the FRESH program identity + its buffer (distinct from
// the existing program's "radar-buffer" so the two never interfere).
const PROGRAM_LABEL = process.env.PROGRAM_LABEL || "radar-program-fresh";
// Optional: deploy a KNOWN program keypair instead of deriving one from the
// deployer (e.g. re-deploying an existing program identity on another cluster).
const PROGRAM_KEYPAIR = process.env.PROGRAM_KEYPAIR;
// Label used to derive the transient deploy buffer (closed again after deploy).
const BUFFER_LABEL = process.env.BUFFER_LABEL || "radar-buffer-fresh";
const SO_PATH = process.env.SO_PATH || "E:/JOB/earn/repos/wallet-radar/programs/radar-transfer-hook/target/deploy/radar_transfer_hook.so";

function loadKp(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function deriveKp(base, label) {
  // sha256(full secret key || label) -> 32-byte seed. Collision-safe (any two
  // distinct labels give distinct keypairs), matching transfer-hook-devnet.ts.
  const seed = createHash("sha256").update(Buffer.concat([base.secretKey, Buffer.from(label)])).digest();
  return Keypair.fromSeed(seed);
}
function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n >>> 0, 0);
  b.writeUInt32LE(Math.floor(n / 0x100000000) >>> 0, 4);
  return b;
}
// UpgradeableLoaderInstruction variants (fixint 4-byte LE discriminant):
//   InitializeBuffer=0, Write=1, DeployWithMaxDataLen=2, Upgrade=3,
//   SetAuthority=4, Close=5, ExtendProgram=6, SetAuthorityChecked=7
const INSTRUCTION = {
  InitializeBuffer: u32le(0),
  // `offset` is relative to the program-data region (loader adds 37 metadata).
  // The byte-length is a u64 (bincode encodes Vec<u8> length as u64).
  Write: (offset, bytes) => Buffer.concat([u32le(1), u32le(offset), u64le(bytes.length), Buffer.from(bytes)]),
  // max_data_len is the size the loader allocates the ProgramData to; it must be
  // >= size_of_programdata_metadata() (45) + program_len, and roomy for upgrades.
  DeployWithMaxDataLen: (maxDataLen) => Buffer.concat([u32le(2), u64le(maxDataLen)]),
  Close: u32le(5),
};

const conn = new Connection(RPC, "confirmed");
const authority = loadKp(AUTHORITY_KEYPAIR);
const deployer = loadKp(DEPLOYER_KEYPAIR);
// Use an explicit program keypair if provided (re-deploy an existing identity on
// another cluster); otherwise derive a fresh one deterministically.
const programKp = PROGRAM_KEYPAIR ? loadKp(PROGRAM_KEYPAIR) : deriveKp(deployer, PROGRAM_LABEL);
const programdataPda = PublicKey.findProgramAddressSync([programKp.publicKey.toBuffer()], BPF_LOADER)[0];
console.log(`[fresh] RPC: ${RPC}`);
console.log(`[fresh] Deployer (payer): ${deployer.publicKey.toBase58()}`);
console.log(`[fresh] Program authority: ${authority.publicKey.toBase58()}`);
console.log(`[fresh] NEW Program: ${programKp.publicKey.toBase58()}`);
console.log(`[fresh] NEW ProgramData PDA: ${programdataPda.toBase58()}`);

const elf = fs.readFileSync(SO_PATH);
const elfLen = elf.length;
const bufferSpace = BUFFER_METADATA + elfLen;
const maxDataLen = PROGRAMDATA_METADATA + elfLen;
console.log(`[fresh] ELF size: ${elfLen}  -> buffer space: ${bufferSpace}, programdata max_data_len: ${maxDataLen}`);

// Persist the fresh program identity keypair for reference / later tooling
// (only when derived, not when an explicit keypair was supplied).
if (!PROGRAM_KEYPAIR) {
  try {
    fs.writeFileSync(process.env.PROGRAM_KEYPAIR_PATH || "E:/JOB/earn/solana-keys/radar-hook-program-fresh.json", JSON.stringify(Array.from(programKp.secretKey)));
  } catch {
    /* best-effort */
  }
}

const bal = (await conn.getBalance(deployer.publicKey)) / 1e9;
console.log(`[fresh] Deployer balance: ${bal.toFixed(4)} SOL`);
if (bal < 1.0) throw new Error(`Deployer has ${bal.toFixed(4)} SOL; need >= 1.0 SOL for buffer rent.`);

const bufferKp = deriveKp(deployer, BUFFER_LABEL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 / network tolerant RPC wrapper.
async function rpc(fn, label, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message || e);
      const rl = /429|too many/i.test(msg);
      const retryable = rl || /timeout|fetch failed|ECONN|socket|web?socket|5\d\d/i.test(msg);
      if (!retryable || i >= tries) throw e;
      const delay = rl ? Math.min(8000, 1000 * Math.pow(2, i - 1)) : 1000 * i;
      if (i === 1 || i % 3 === 0) console.log(`[fresh] rpc ${label}: ${msg.slice(0, 50)} — retry ${i}/${tries} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

let _bh = null;
let _bhAt = 0;
let _bhUses = 0;
function invalidateBh() {
  _bh = null;
  _bhUses = 0;
}
async function getBlockhash(force = false) {
  const now = Date.now();
  if (!force && _bh && _bhUses < 20 && now - _bhAt < 30000) {
    _bhUses++;
    return _bh;
  }
  _bh = await rpc(() => conn.getLatestBlockhash("confirmed"), "blockhash");
  _bhAt = now;
  _bhUses = 1;
  return _bh;
}

async function confirmSig(sig, label) {
  const deadline = Date.now() + 90000;
  let lastErr = null;
  while (Date.now() < deadline) {
    let st;
    try {
      st = await conn.getSignatureStatuses([sig]);
    } catch (e) {
      lastErr = e;
      await sleep(1500);
      continue;
    }
    const s = st.value[0];
    if (s) {
      if (s.err) {
        let logs = [];
        try {
          const info = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          logs = info?.meta?.logMessages || [];
        } catch {}
        throw new Error(`${label} failed: ${JSON.stringify(s.err)} sig=${sig}\n${logs.join("\n")}`);
      }
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return s;
    }
    await sleep(1500);
  }
  return null;
}

async function send(ixs, signers, label, opts = {}) {
  const bh = await getBlockhash(opts.forceBh);
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = deployer.publicKey;
  tx.sign(...signers);
  const sig = await rpc(
    () => conn.sendRawTransaction(tx.serialize(), { skipPreflight: opts.skipPreflight ?? false, maxRetries: 3 }),
    "sendRaw",
  );
  const c = await confirmSig(sig, label);
  if (!c) throw new Error(`${label} not confirmed within 90s (sig=${sig})`);
  return sig;
}

async function sendRetry(ixs, signers, label, tries = 4, opts = {}) {
  for (let i = 1; ; i++) {
    try {
      return await send(ixs, signers, label, opts);
    } catch (e) {
      if (i >= tries) throw e;
      console.log(`[fresh] ${label} attempt ${i} failed (${e.message.split("\n")[0]}) — retry`);
      invalidateBh();
      await sleep(1500 * i);
    }
  }
}

// Idempotency: if the ProgramData already exists, the program is deployed.
const pdPre = await conn.getAccountInfo(programdataPda);
if (pdPre) {
  console.log(`[fresh] ProgramData ${programdataPda.toBase58()} already exists (len ${pdPre.data.length}) — program already deployed.`);
  console.log(`[fresh]   Program: ${programKp.publicKey.toBase58()}`);
  console.log(`[fresh]   ProgramData: ${programdataPda.toBase58()}`);
  process.exit(0);
}

// ---- 1. Ensure the buffer account exists and is initialized ----
const existing = await conn.getAccountInfo(bufferKp.publicKey);
if (existing != null) {
  const state = existing.data[0];
  if (state === 0) {
    const initIx = new TransactionInstruction({
      programId: BPF_LOADER,
      keys: [
        { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: false, isWritable: false },
      ],
      data: INSTRUCTION.InitializeBuffer,
    });
    const s = await send([initIx], [deployer], "buffer-init");
    console.log(`[fresh] Initialized existing buffer sig=${s}`);
  } else if (state === 1) {
    console.log(`[fresh] Buffer already initialized: ${bufferKp.publicKey.toBase58()} (len ${existing.data.length})`);
  } else {
    throw new Error(`Buffer in unexpected state (disc=${state})`);
  }
} else {
  const bufferRent = await conn.getMinimumBalanceForRentExemption(bufferSpace);
  const initBufferIx = new TransactionInstruction({
    programId: BPF_LOADER,
    keys: [
      { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: false, isWritable: false },
    ],
    data: INSTRUCTION.InitializeBuffer,
  });
  const sig = await send(
    [
      SystemProgram.createAccount({
        fromPubkey: deployer.publicKey,
        newAccountPubkey: bufferKp.publicKey,
        lamports: bufferRent,
        space: bufferSpace,
        programId: BPF_LOADER,
      }),
      initBufferIx,
    ],
    [deployer, bufferKp],
    "buffer-create",
  );
  console.log(`[fresh] Buffer created (space ${bufferSpace}, rent ${bufferRent}) sig=${sig}`);
}

// ---- 2. Write the ELF into the buffer (chunked, batched, idempotent) ----
const CHUNK = 900;
let bufferComplete = false;
{
  const b = await conn.getAccountInfo(bufferKp.publicKey);
  if (b && b.data.length >= BUFFER_METADATA + elfLen) {
    const p = b.data.subarray(BUFFER_METADATA, BUFFER_METADATA + elfLen);
    bufferComplete = Buffer.compare(Buffer.from(p), elf) === 0;
  }
}
if (bufferComplete) console.log(`[fresh] Buffer already matches ELF — skipping writes`);
const offsets = [];
if (!bufferComplete) {
  for (let off = 0; off < elfLen; off += CHUNK) offsets.push(off);
}
const buildWriteIx = (off) => {
  const chunk = elf.subarray(off, Math.min(off + CHUNK, elfLen));
  return new TransactionInstruction({
    programId: BPF_LOADER,
    keys: [
      { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: INSTRUCTION.Write(off, chunk),
  });
};

const BATCH = 10;
async function sendTx(ix, bh) {
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = deployer.publicKey;
  tx.sign(deployer, authority);
  return rpc(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 1 }), "sendRaw");
}

let doneCount = 0;
for (let bi = 0; bi < offsets.length; bi += BATCH) {
  const batch = offsets.slice(bi, bi + BATCH);
  const sigs = new Map();
  const bh = await getBlockhash(true);
  for (const off of batch) {
    sigs.set(off, await sendTx(buildWriteIx(off), bh));
    await sleep(150);
  }
  const stuckRounds = new Map();
  for (let round = 0; ; round++) {
    const st = await rpc(() => conn.getSignatureStatuses([...sigs.values()]), "sigStatuses");
    let allConfirmed = true;
    for (let idx = 0; idx < batch.length; idx++) {
      const off = batch[idx];
      const s = st.value[idx];
      const ok = s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
      if (ok) { stuckRounds.delete(off); continue; }
      allConfirmed = false;
      if (s && s.err) {
        try {
          const info = await conn.getTransaction(sigs.get(off), { maxSupportedTransactionVersion: 0 });
          console.log(`[fresh] write@${off} FAILED: ${JSON.stringify(s.err)}\n${(info?.meta?.logMessages || []).join("\n")}`);
        } catch {}
        sigs.set(off, await sendTx(buildWriteIx(off), await getBlockhash(true)));
        stuckRounds.set(off, 0);
      } else {
        const r = (stuckRounds.get(off) || 0) + 1;
        stuckRounds.set(off, r);
        if (r >= 10) {
          sigs.set(off, await sendTx(buildWriteIx(off), await getBlockhash(true)));
          stuckRounds.set(off, 0);
        }
      }
    }
    if (allConfirmed) break;
    if (round >= 40) throw new Error(`[fresh] batch @${batch[0]} not confirmed after 40 rounds — rerun (idempotent)`);
    await sleep(2000);
  }
  doneCount += batch.length;
  console.log(`[fresh]   buffer write ${Math.min(bi + BATCH, offsets.length)}/${offsets.length} confirmed`);
}
console.log(`[fresh] Buffer fully written and confirmed`);

// ---- 3. Deploy the fresh program (create program acct + programdata + copy) ----
// Per solana-program `deploy_with_max_program_len`:
//   ix1: SystemProgram.createAccount(program, space=36, owner=BPF_LOADER)
//   ix2: DeployWithMaxDataLen { max_data_len }  (loader allocates ProgramData PDA)
//   accounts: [payer(w,s), programdata(w), program(w), buffer(w), rent, clock,
//             system, authority(s,ro)]
const programRent = await conn.getMinimumBalanceForRentExemption(PROGRAM_SIZE);
const programExists = (await conn.getAccountInfo(programKp.publicKey)) != null;
const deployIxs = [];
if (!programExists) {
  deployIxs.push(
    SystemProgram.createAccount({
      fromPubkey: deployer.publicKey,
      newAccountPubkey: programKp.publicKey,
      lamports: programRent,
      space: PROGRAM_SIZE,
      programId: BPF_LOADER,
    }),
  );
  console.log(`[fresh] Program account ${programKp.publicKey.toBase58()} does not exist — will create (rent ${programRent})`);
} else {
  console.log(`[fresh] Program account ${programKp.publicKey.toBase58()} already exists — skipping createAccount`);
}
deployIxs.push(
  new TransactionInstruction({
    programId: BPF_LOADER,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: programdataPda, isSigner: false, isWritable: true },
      { pubkey: programKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: INSTRUCTION.DeployWithMaxDataLen(maxDataLen),
  }),
);
const depSig = await sendRetry(deployIxs, [deployer, programKp, authority], "deploy-fresh", 4, { forceBh: true });
console.log(`[fresh] DEPLOY sig=${depSig}`);

// ---- 4. Close the buffer to reclaim rent (best-effort) ----
try {
  const closeIx = new TransactionInstruction({
    programId: BPF_LOADER,
    keys: [
      { pubkey: bufferKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: deployer.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: INSTRUCTION.Close,
  });
  const cSig = await send([closeIx], [deployer, authority], "buffer-close");
  console.log(`[fresh] Buffer closed sig=${cSig}`);
} catch (e) {
  console.log(`[fresh] Buffer close (optional) skipped: ${e.message.split("\n")[0]}`);
}

// ---- 5. Verify ----
const prog2 = await conn.getAccountInfo(programKp.publicKey);
const pd2 = await conn.getAccountInfo(programdataPda);
const expectedLen = PROGRAMDATA_METADATA + elfLen;
console.log(`[fresh] Program acct: ${prog2 ? `len=${prog2.data.length} owner=${prog2.owner.toBase58()}` : "NOT FOUND"}`);
console.log(`[fresh] ProgramData : ${pd2 ? `len=${pd2.data.length} exec=${pd2.executable} lamports=${pd2.lamports}` : "NOT FOUND"} (expected len ${expectedLen})`);
console.log(`[fresh] ${pd2 && pd2.data.length >= expectedLen ? "SIZE OK (>= 45 + ELF)" : "SIZE MISMATCH"} — fresh deploy DONE`);
console.log(`[fresh] === FRESH PROGRAM DEPLOYED ===`);
console.log(`[fresh] Program:     ${programKp.publicKey.toBase58()}`);
console.log(`[fresh] ProgramData: ${programdataPda.toBase58()}`);
