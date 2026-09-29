import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Stage 3D fixes (see CLAUDE.md, scratch history for the bug list this
// addresses):
//   1. Reads record.class (PROTOCOL.md / labels.jsonl actually use "class",
//      not "label" -- the old code read the wrong field, so every record
//      silently failed this check and effectively could never PASS).
//   2. An unknown/uninitialized account (RPC `value === null`) is now FAIL,
//      not a silent pass-through.
//   3. The source_url itself is stripped out of the fetched page text before
//      checking "address found in body" -- otherwise a canonical-link/og:url
//      meta tag that merely echoes the request URL makes the check vacuous
//      for any explorer URL shaped like ".../account/<address>".
//   4. evidence_quote (<=15 words, verbatim in body) is now required for
//      ALL classes (SAFE/DANGEROUS/UNCERTAIN), not just DANGEROUS.
//   5. class must be one of SAFE/DANGEROUS/UNCERTAIN (previously
//      unvalidated).
//   6. fetch and RPC calls are injectable (`opts.fetchPage`, `opts.fetchRpc`)
//      so tests run fully offline/deterministically, and so this script no
//      longer needs to read radar.env itself (CLAUDE.md rule 8): the default
//      RPC endpoint is `process.env.SOLANA_RPC_URL` or the public
//      mainnet-beta endpoint, which needs no API key for getAccountInfo.

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const VALID_CLASSES = new Set(["SAFE", "DANGEROUS", "UNCERTAIN"]);

/** Default page fetcher: plain HTTP GET, no API key involved. */
export async function defaultFetchPage(sourceUrl) {
  const res = await fetch(sourceUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, text: res.status === 200 ? await res.text() : null };
}

/** Default RPC caller: public Solana RPC unless SOLANA_RPC_URL is set. Never reads radar.env. */
export async function defaultFetchRpc(address) {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "jsonParsed" }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return { ok: false, status: res.status, value: undefined };
  const data = await res.json();
  return { ok: true, status: res.status, value: data?.result?.value };
}

export function loadExp1Addresses(exp1Path = path.resolve("archive/exp1/large-wallets.json")) {
  const addresses = new Set();
  if (fs.existsSync(exp1Path)) {
    try {
      const data = JSON.parse(fs.readFileSync(exp1Path, "utf8"));
      for (const item of data) {
        if (item && item.address) addresses.add(item.address);
      }
    } catch (err) {
      console.error(`Warning: Failed to load ${exp1Path}:`, err.message);
    }
  }
  return addresses;
}

/**
 * Verify one ground-truth label record. `opts.fetchPage`/`opts.fetchRpc` are
 * injectable for testing; `opts.exp1Addresses` and `opts.seenAddresses` carry
 * cross-record state the caller owns.
 */
export async function verifyRecord(record, opts = {}) {
  const errors = [];
  const warnings = [];
  const fetchPage = opts.fetchPage ?? defaultFetchPage;
  const fetchRpc = opts.fetchRpc ?? defaultFetchRpc;
  const exp1Addresses = opts.exp1Addresses ?? new Set();
  const seenAddresses = opts.seenAddresses ?? new Set();

  const address = record.address;
  const cls = record.class;
  const sourceUrl = record.source_url;
  const cutoffDate = record.cutoff_date;
  const eventDate = record.event_date;
  const evidenceQuote = record.evidence_quote;

  // 1. Address syntax & duplicate check
  if (!address || typeof address !== "string") {
    errors.push("Missing or invalid address field");
    return { pass: false, errors, warnings };
  }
  if (seenAddresses.has(address)) {
    errors.push(`Duplicate address in dataset: ${address}`);
  }
  seenAddresses.add(address);

  // 2. Overlap with experiment 1
  if (exp1Addresses.has(address)) {
    errors.push("Contamination: address is present in archive/exp1/large-wallets.json");
  }

  // 3. class field (fixed: was record.label)
  if (!cls || typeof cls !== "string") {
    errors.push("Missing or invalid class field");
  } else if (!VALID_CLASSES.has(cls)) {
    errors.push(`Invalid class "${cls}" (expected one of: ${[...VALID_CLASSES].join(", ")})`);
  }

  // 4. Temporal consistency (DANGEROUS only, per PROTOCOL.md 2.1)
  if (cls === "DANGEROUS") {
    if (!cutoffDate || !eventDate) {
      errors.push("DANGEROUS class requires both cutoff_date and event_date");
    } else {
      const cDate = new Date(cutoffDate);
      const eDate = new Date(eventDate);
      if (isNaN(cDate.getTime()) || isNaN(eDate.getTime())) {
        errors.push(`Invalid date format (cutoff: ${cutoffDate}, event: ${eventDate})`);
      } else if (eDate <= cDate) {
        errors.push(`Lookahead violation: event_date (${eventDate}) <= cutoff_date (${cutoffDate})`);
      }
    }
  }

  // 5. evidence_quote: required for ALL classes now (was DANGEROUS-only)
  let quoteWordsOk = false;
  if (!evidenceQuote || typeof evidenceQuote !== "string" || evidenceQuote.trim().length === 0) {
    errors.push("evidence_quote is required for every class (verbatim excerpt, up to 15 words)");
  } else {
    const words = evidenceQuote.trim().split(/\s+/);
    if (words.length > 15) {
      errors.push(`evidence_quote exceeds 15 words limit (got ${words.length} words: "${evidenceQuote}")`);
    } else {
      quoteWordsOk = true;
    }
  }

  // 6. Source URL check
  let pageText = null;
  if (!sourceUrl || typeof sourceUrl !== "string") {
    errors.push("Missing or invalid source_url");
  } else {
    try {
      const { status, text } = await fetchPage(sourceUrl);
      if (status !== 200) {
        errors.push(`source_url returned HTTP ${status} (expected 200)`);
      } else {
        pageText = text ?? "";
        // Strip every literal occurrence of the source_url itself before
        // checking for the address: otherwise a canonical/og:url tag that
        // merely echoes the request URL (e.g. ".../account/<address>") makes
        // "address found in body" trivially true for any explorer link.
        const bodyWithoutUrl = pageText.split(sourceUrl).join("");
        if (!bodyWithoutUrl.includes(address)) {
          errors.push(`Address "${address}" only found inside source_url itself, not in the response body`);
        }
        if (evidenceQuote && quoteWordsOk && !pageText.includes(evidenceQuote.trim())) {
          errors.push(`evidence_quote "${evidenceQuote}" not found verbatim in raw HTTP response`);
        }
      }
    } catch (fetchErr) {
      errors.push(`source_url fetch failed: ${fetchErr.message}`);
    }
  }

  // 7. RPC account check: must exist, be System-owned, and non-executable
  try {
    const { ok, status, value } = await fetchRpc(address);
    if (!ok) {
      errors.push(`RPC getAccountInfo returned HTTP ${status}`);
    } else if (value === null || value === undefined) {
      // Fixed: previously treated a nonexistent/uninitialized account as an
      // implicit pass ("System owned default"). An address with no on-chain
      // account cannot be verified as a wallet, exploiter, or anything else.
      errors.push("RPC getAccountInfo returned null: account does not exist on-chain");
    } else if (typeof value === "object") {
      const owner = value.owner;
      const executable = Boolean(value.executable);
      if (executable) {
        errors.push("Account is executable (smart contract / program), not a wallet");
      }
      if (owner !== SYSTEM_PROGRAM_ID) {
        errors.push(`Account owner is "${owner}" (expected System Program ${SYSTEM_PROGRAM_ID})`);
      }
    }
  } catch (rpcErr) {
    errors.push(`RPC getAccountInfo failed: ${rpcErr.message}`);
  }

  return { pass: errors.length === 0, errors, warnings };
}

async function main() {
  const targetFile = process.argv[2] || "ground-truth/labels.jsonl";
  console.log("============================================================");
  console.log(`LABEL VERIFIER: ${targetFile}`);
  const exp1Addresses = loadExp1Addresses();
  console.log(`Loaded ${exp1Addresses.size} exp1 addresses for contamination checks`);
  console.log("============================================================\n");

  if (!fs.existsSync(targetFile)) {
    console.error(`Target file not found: ${targetFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(targetFile, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  console.log(`Found ${lines.length} records to verify.\n`);

  const seenAddresses = new Set();
  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < lines.length; i++) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch (parseErr) {
      console.log(`[RECORD ${i + 1}] FAIL - Invalid JSON: ${parseErr.message}`);
      failCount++;
      continue;
    }

    const res = await verifyRecord(record, { exp1Addresses, seenAddresses });
    const addr = record.address || "UNKNOWN";
    const cls = record.class || "UNKNOWN";

    if (res.pass) {
      console.log(`[RECORD ${i + 1}] PASS | Address: ${addr} | Class: ${cls}`);
      passCount++;
    } else {
      console.log(`[RECORD ${i + 1}] FAIL | Address: ${addr} | Class: ${cls}`);
      for (const err of res.errors) {
        console.log(`   - REASON: ${err}`);
      }
      failCount++;
    }
  }

  console.log("\n============================================================");
  console.log("VERIFICATION SUMMARY:");
  console.log(`Total records: ${lines.length}`);
  console.log(`PASS: ${passCount}`);
  console.log(`FAIL: ${failCount}`);
  console.log("============================================================");

  if (failCount > 0) {
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error("Fatal verifier error:", err);
    process.exit(1);
  });
}
