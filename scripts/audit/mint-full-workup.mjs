#!/usr/bin/env node
// Stage 4B.2/4B.3 (ground-truth audit, see CLAUDE.md).
//
// For a list of mints: name/symbol/program/Token-2022 extensions/authority
// type (from onchain-mint-metadata.mjs's lookupMint), PLUS
// getTokenLargestAccounts and the resolved real holder (owner) of each of
// the top 5 token accounts -- classified only as System wallet / known AMM
// pool / pump.fun bonding curve / other program, using the SAME
// KNOWN_AMM_OWNERS set and bonding-curve PDA derivation as src/mint.ts
// (imported from dist/, not re-implemented). No verdicts, only data.
//
// Public RPC only, no API key, never reads radar.env (CLAUDE.md rule 8).
//
// Usage: node scripts/audit/mint-full-workup.mjs <output.jsonl> <mint1> [mint2 ...]

import fs from "node:fs";
import { KNOWN_AMM_OWNERS, getPumpFunBondingCurvePda } from "../../dist/src/mint.js";
import { lookupMint, rpc } from "./onchain-mint-metadata.mjs";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

async function classifyHolders(mint, tokenAccountAddresses) {
  if (tokenAccountAddresses.length === 0) return [];
  const resp = await rpc("getMultipleAccounts", [tokenAccountAddresses, { encoding: "jsonParsed" }]);
  const values = resp?.result?.value ?? [];
  const bondingCurve = getPumpFunBondingCurvePda(mint);

  const holders = [];
  for (let i = 0; i < tokenAccountAddresses.length; i++) {
    const acct = values[i];
    const info = acct?.data?.parsed?.info;
    const holder = info?.owner ?? null;
    let classification;
    if (!holder) classification = "НЕ ПРОВЕРЕНО (аккаунт не найден/не распарсен)";
    else if (holder === bondingCurve || tokenAccountAddresses[i] === bondingCurve) classification = "pump.fun bonding curve";
    else if (KNOWN_AMM_OWNERS.has(holder)) classification = "known AMM pool/program";
    else {
      // Resolve the holder address's own owner program to see if it's a wallet or a PDA/program account.
      await new Promise((r) => setTimeout(r, 300));
      const ownerResp = await rpc("getAccountInfo", [holder, { encoding: "jsonParsed" }]);
      if (ownerResp?.error) {
        classification = `НЕ ПРОВЕРЕНО (RPC error: ${JSON.stringify(ownerResp.error)})`;
      } else {
        const ownerProgram = ownerResp?.result?.value?.owner ?? null;
        classification = ownerProgram === SYSTEM_PROGRAM_ID ? "System wallet" : `program-owned (owner=${ownerProgram ?? "НЕ ПРОВЕРЕНО"})`;
      }
    }
    holders.push({ tokenAccount: tokenAccountAddresses[i], holder, classification, uiAmount: info?.tokenAmount?.uiAmount ?? null });
  }
  return holders;
}

async function classifyAuthority(address) {
  if (!address) return null;
  await new Promise((r) => setTimeout(r, 300));
  const resp = await rpc("getAccountInfo", [address, { encoding: "jsonParsed" }]);
  // IMPORTANT: distinguish "RPC call failed" (resp.error, e.g. exhausted 429 retries)
  // from "RPC succeeded and the account genuinely does not exist" (result.value === null).
  // Conflating the two would silently report a stale/rate-limited failure as an on-chain fact.
  if (resp?.error) return { address, owner: "НЕ ПРОВЕРЕНО", parsedType: "НЕ ПРОВЕРЕНО", note: `RPC error: ${JSON.stringify(resp.error)}` };
  const value = resp?.result?.value;
  if (value === null || value === undefined) return { address, owner: null, parsedType: null, note: "аккаунт не существует on-chain (0 lamports)" };
  return {
    address,
    owner: value.owner ?? null,
    executable: Boolean(value.executable),
    parsedType: value?.data?.parsed?.type ?? "НЕ ПРОВЕРЕНО (не jsonParsed-распознаваемый тип)",
    signers: value?.data?.parsed?.info?.signers ?? null,
    numRequiredSigners: value?.data?.parsed?.info?.numRequiredSigners ?? null,
  };
}

export async function fullWorkup(mint) {
  const base = await lookupMint(mint);
  const freezeAuthorityInfo = await classifyAuthority(base.rawAccountInfo?.result?.value?.data?.parsed?.info?.freezeAuthority ?? null);
  const mintAuthorityInfo = await classifyAuthority(base.rawAccountInfo?.result?.value?.data?.parsed?.info?.mintAuthority ?? null);
  await new Promise((r) => setTimeout(r, 300));
  const largestResp = await rpc("getTokenLargestAccounts", [mint]);
  const largestBlocked = largestResp?.error?.code === 429;
  const largest = (largestResp?.result?.value ?? []).slice(0, 5);
  const holderAddresses = largest.map((a) => a.address);
  await new Promise((r) => setTimeout(r, 300));
  const holders = largestBlocked
    ? "НЕ ПРОВЕРЕНО: getTokenLargestAccounts вернул 429 (публичный api.mainnet-beta.solana.com жёстко ограничивает этот метод; платного RPC-ключа нет, radar.env не читается по правилу 8)"
    : await classifyHolders(mint, holderAddresses);

  const extensions = base.rawAccountInfo?.result?.value?.data?.parsed?.info?.extensions ?? [];

  return {
    mint,
    name: base.name,
    symbol: base.symbol,
    uri: base.uri,
    tokenProgram: base.tokenProgram,
    supply: base.supply,
    decimals: base.decimals,
    metadataSource: base.metadataSource,
    extensions,
    freezeAuthorityInfo,
    mintAuthorityInfo,
    top5LargestAccounts: largest,
    top5HolderClassification: holders,
    rawAccountInfo: base.rawAccountInfo,
    rawGetTokenLargestAccounts: largestResp,
  };
}

async function main() {
  const [, , outPath, ...mints] = process.argv;
  if (!outPath || mints.length === 0) {
    console.error("Usage: node scripts/audit/mint-full-workup.mjs <output.jsonl> <mint1> [mint2 ...]");
    process.exit(1);
  }
  const out = fs.createWriteStream(outPath, { flags: "w" });
  for (const mint of mints) {
    try {
      const result = await fullWorkup(mint);
      out.write(JSON.stringify(result) + "\n");
      const holderSummary = Array.isArray(result.top5HolderClassification)
        ? result.top5HolderClassification.map((h) => h.classification).join(" | ")
        : result.top5HolderClassification;
      console.log(
        `${mint}: name=${JSON.stringify(result.name)} program=${result.tokenProgram} extensions=[${result.extensions.map((e) => e.extension).join(",")}] freezeAuth=${result.freezeAuthorityInfo ? `${result.freezeAuthorityInfo.parsedType}/owner=${result.freezeAuthorityInfo.owner}` : "null"} mintAuth=${result.mintAuthorityInfo ? `${result.mintAuthorityInfo.parsedType}/owner=${result.mintAuthorityInfo.owner}` : "null"} top5=[${holderSummary}]`,
      );
    } catch (err) {
      const errRow = { mint, error: String(err && err.message ? err.message : err) };
      out.write(JSON.stringify(errRow) + "\n");
      console.log(`${mint}: ERROR ${errRow.error}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  out.end();
}

const isMain = process.argv[1] && process.argv[1].endsWith("mint-full-workup.mjs");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
