#!/usr/bin/env node
// Stage 3C.1/3C.2 (ground-truth audit, see CLAUDE.md).
//
// For a list of mint addresses, fetches raw on-chain account info via the
// PUBLIC Solana RPC (no API key required for getAccountInfo -- this never
// reads radar.env or HELIUS_API_KEY, per CLAUDE.md rule 8) and tries to
// extract name/symbol/uri from either:
//   (a) the Token-2022 `tokenMetadata` extension (if the mint uses the
//       Token-2022 program and the RPC's jsonParsed encoding surfaces it), or
//   (b) the Metaplex Token Metadata PDA (classic SPL Token mints), parsed
//       manually from raw base64 account data (minimal Borsh string reader).
// Whatever cannot be determined is recorded as "НЕ ПРОВЕРЕНО", never guessed.
//
// The full raw RPC response for each mint is kept in the output (so the
// figures are independently checkable), one JSON object per line.
//
// Usage: node scripts/audit/onchain-mint-metadata.mjs <output.jsonl> <mint1> [mint2 ...]

import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

function metaplexPda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
    METADATA_PROGRAM_ID,
  );
  return pda.toBase58();
}

/** Borsh string: u32 LE length prefix + utf8 bytes (Metaplex pads name/symbol/uri with NUL to a fixed width). */
function readBorshString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const value = buf
    .slice(offset + 4, offset + 4 + len)
    .toString("utf8")
    .replace(/\0/g, "")
    .trim();
  return { value, next: offset + 4 + len };
}

function parseMetaplexMetadata(base64Data) {
  const buf = Buffer.from(base64Data, "base64");
  // key(1) + updateAuthority(32) + mint(32), then Borsh name/symbol/uri strings.
  let offset = 1 + 32 + 32;
  const name = readBorshString(buf, offset);
  offset = name.next;
  const symbol = readBorshString(buf, offset);
  offset = symbol.next;
  const uri = readBorshString(buf, offset);
  return { name: name.value, symbol: symbol.value, uri: uri.value };
}

export async function lookupMint(mint) {
  const acctResp = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const value = acctResp?.result?.value;
  if (value === null || value === undefined) {
    return {
      mint,
      tokenProgram: "НЕ ПРОВЕРЕНО (аккаунт не найден)",
      supply: null,
      decimals: null,
      name: "НЕ ПРОВЕРЕНО",
      symbol: "НЕ ПРОВЕРЕНО",
      uri: "НЕ ПРОВЕРЕНО",
      metadataSource: "аккаунт mint отсутствует on-chain",
      rawAccountInfo: acctResp,
    };
  }
  const owner = value.owner ?? null;
  const info = value?.data?.parsed?.info ?? null;
  const extensions = Array.isArray(info?.extensions) ? info.extensions : [];
  const tokenMetadataExt = extensions.find((e) => e.extension === "tokenMetadata");

  let name = null;
  let symbol = null;
  let uri = null;
  let metadataSource = null;
  let metaplexRaw = null;

  if (tokenMetadataExt?.state) {
    name = tokenMetadataExt.state.name ?? null;
    symbol = tokenMetadataExt.state.symbol ?? null;
    uri = tokenMetadataExt.state.uri ?? null;
    metadataSource = "token2022_tokenMetadata_extension";
  } else {
    const pda = metaplexPda(mint);
    const mdResp = await rpc("getAccountInfo", [pda, { encoding: "base64" }]);
    metaplexRaw = mdResp;
    const mdValue = mdResp?.result?.value;
    if (mdValue?.data?.[0]) {
      try {
        const parsed = parseMetaplexMetadata(mdValue.data[0]);
        name = parsed.name;
        symbol = parsed.symbol;
        uri = parsed.uri;
        metadataSource = `metaplex_pda(${pda})`;
      } catch (err) {
        name = "НЕ ПРОВЕРЕНО";
        symbol = "НЕ ПРОВЕРЕНО";
        uri = "НЕ ПРОВЕРЕНО";
        metadataSource = `metaplex_pda(${pda})_parse_failed: ${err.message}`;
      }
    } else {
      name = "НЕ ПРОВЕРЕНО";
      symbol = "НЕ ПРОВЕРЕНО";
      uri = "НЕ ПРОВЕРЕНО";
      metadataSource = `НЕ ПРОВЕРЕНО (нет ни Token-2022 tokenMetadata extension, ни Metaplex PDA ${pda})`;
    }
  }

  return {
    mint,
    tokenProgram: owner,
    supply: info?.supply ?? "НЕ ПРОВЕРЕНО",
    decimals: info?.decimals ?? "НЕ ПРОВЕРЕНО",
    name,
    symbol,
    uri,
    metadataSource,
    rawAccountInfo: acctResp,
    rawMetaplexInfo: metaplexRaw,
  };
}

async function main() {
  const [, , outPath, ...mints] = process.argv;
  if (!outPath || mints.length === 0) {
    console.error("Usage: node scripts/audit/onchain-mint-metadata.mjs <output.jsonl> <mint1> [mint2 ...]");
    process.exit(1);
  }
  const out = fs.createWriteStream(outPath, { flags: "w" });
  for (const mint of mints) {
    try {
      const result = await lookupMint(mint);
      out.write(JSON.stringify(result) + "\n");
      console.log(`${mint}: program=${result.tokenProgram} name=${JSON.stringify(result.name)} symbol=${JSON.stringify(result.symbol)} source=${result.metadataSource}`);
    } catch (err) {
      const errRow = { mint, error: String(err && err.message ? err.message : err) };
      out.write(JSON.stringify(errRow) + "\n");
      console.log(`${mint}: ERROR ${errRow.error}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  out.end();
}

const isMain = process.argv[1] && process.argv[1].endsWith("onchain-mint-metadata.mjs");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
