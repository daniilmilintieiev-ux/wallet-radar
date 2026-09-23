// Inspect all known programdata + program accounts: error-code series,
// embedded declare_id pubkeys, and program-account pointers.
const RPC = "https://api.devnet.solana.com";

function c(h, a, b) { let n = 0; for (let i = 0; i + 1 < h.length; i++) if (h[i] === a && h[i + 1] === b) n++; return n; }

async function getAcc(addr) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [addr, { encoding: "base64", commitment: "confirmed" }] }),
  });
  const json = await res.json();
  const v = json.result && json.result.value;
  return v ? Buffer.from(v.data[0], "base64") : null;
}

const KNOWN = {
  P2: "7DeRG1BDToqYnfACzSdS4MfEwTGBCmkFo7Y61dmE2t2C",
  P3: "C3ESEdoxRNstM11CeZpRmKbzGzBpRHMzSmAz1RNS3Xki",
  P4: "wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV",
  P5: "62reSGcYu6A4sJjS1qeMr95ShajjZe3er7xoeofkKGSf",
  OLD: "ASXvQYqhWYz82YFcqHUdcWDNotqt9atTJYp3xDHiV8Qz",
};

// decode bs58 pubkey -> Buffer
function b58(s) {
  const ALC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(ALC.indexOf(ch));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

function containsPubkey(hay, pk) { return hay.includes(pk); }

const DATA = {
  "P2 data 9L33ZtFx": "9L33ZtFxBErLSFfmVP7CC2WE9NYEu8zv9D4oUAXmm8tm",
  "P3 data F5Vs1WLD": "F5Vs1WLD8ffakTAR5HSL3DZiDdTipbukeAKxY21PLakE",
  "P4 data EmiU4LFi": "EmiU4LFiep9gqonS8ema6MFYeFjUXDYAp47ACzpoEAvY",
  "P5 data 5UVUd2zu": "5UVUd2zuXnv1b3auvRenEDuXti2baZotT3owZbX71tgf",
  "OLD GFD5PTTL": "GFD5PTTLvJCEkL4qvvEjBCDH38hcjNtGe9Tf219LrVoH",
};

const pks = Object.fromEntries(Object.entries(KNOWN).map(([k, v]) => [k, b58(v)]));

for (const [label, addr] of Object.entries(DATA)) {
  const d = await getAcc(addr);
  if (!d) { console.log(`${label}: MISSING`); continue; }
  const elf = d.subarray(45);
  const ids = Object.keys(KNOWN).filter((k) => containsPubkey(elf, pks[k]));
  console.log(`${label}: len=${d.length} slot=${d.readBigUInt64LE(4).toString()} 6001=x${c(elf, 0x71, 0x17)} 12001=x${c(elf, 0xe1, 0x2e)} declareIds=[${ids.join(",")}]`);
  await new Promise((r) => setTimeout(r, 250));
}

console.log("\nprogram account pointers:");
for (const [label, addr] of Object.entries(KNOWN)) {
  const d = await getAcc(addr);
  if (!d) { console.log(`${label}: MISSING`); continue; }
  const variant = d.readUInt32LE(0);
  const pointer = d.subarray(4, 36).toString("base58" === "x" ? "hex" : "base64");
  // convert pointer buffer to base58
  const ALC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of d.subarray(4, 36)) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALC[Number(n % 58n)] + s; n /= 58n; }
  for (const b of d.subarray(4, 36)) { if (b === 0) s = "1" + s; else break; }
  console.log(`${label}: variant=${variant} pointer=${s}`);
  await new Promise((r) => setTimeout(r, 250));
}
