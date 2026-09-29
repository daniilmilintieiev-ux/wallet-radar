#!/usr/bin/env node
// Stage 3C.3 (ground-truth audit, see CLAUDE.md).
//
// Offline-only recount: of the 58 BLOCKED wallets (benchmarks/simulation-results.json),
// how many remain BLOCKED-via-TOXIC_MINT if the wallets whose ONLY TOXIC_MINT
// basis is one of a named set of mints/freeze-authority groups are excluded.
//
// Does NOT fetch on-chain name/symbol/program metadata (that needs live RPC +
// HELIUS_API_KEY; CLAUDE.md rule 8 forbids reading radar.env, and no key is
// set in the ambient shell env of this session -- see stage-3 report, 3C.1/3C.2).
// This script only re-uses the ALREADY CACHED benchmarks/mint-cache.json and
// benchmarks/history-cache/*.json on disk, exactly like blocked-table.mjs.
// No conclusions about "legitimacy" are drawn or printed.
//
// Usage: node scripts/audit/mint-group-impact.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeRows } from "./lib/toxic-mint-rows.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// Groups named in the stage-3 task (3C.2/3C.3), identified purely by the
// freezeAuthority address shared across cached mint-cache.json entries, or by
// exact mint address for the single-mint groups (USD1 / JupUSD / CASH).
// Membership was found by grepping benchmarks/mint-cache.json in this same
// session (see stage-3 report, 3C.3 raw output) -- no RPC calls involved.
const EXCLUDED_MINTS = new Set([
  // freezeAuthority JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs (19 mints, "Xs" family)
  "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re",
  "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",
  "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
  "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
  "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
  "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc",
  "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4",
  "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM",
  "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
  "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
  "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2",
  "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg",
  "Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x",
  "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
  "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  // freezeAuthority 2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a (25 mints)
  "RBLXDGRD64AtRamHMFVcjqne3Ar7NLWtFtYNtsrf1cE",
  "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1",
  "GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH",
  "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3",
  "DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow",
  "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
  "N7Q5fYX7YRnDQksfdBKnoUb3awm92n7QNAD35X3Rq1X",
  "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo",
  "AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc",
  "URARfsinxCRw4JpvQhuT4CxavdZXZEMjv9ZwWmWpwag",
  "HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx",
  "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF",
  "UPSqUeMHcWbkdg784XuBUEF9DtySSnW9ur5LAVdcuB9",
  "BBosJLw8ZzoATiEyywiifx7AgmrD2Cm3XjFWbhbRhChy",
  "SQQQAa3gUxgnqcEsdjPA4RQNQBgB97TnG2hJhk2WaGE",
  "USNv3NkKA27Dh4nsHJDPhW4VoEcTQmjoZyJt2dqdwFu",
  "EWY4owSJYMpwN33qGDu5gGxpkQkpMJu8ZUsQJaNZG5dv",
  "RDDTGbhHwVXfyCvQMXzzowKjf5qrYBZAnehoXW83ooh",
  "CYPHuMmCL1GxJWa2tsPhLKykC7GrHJTCHwbXD4g5uawK",
  "ARMbSB1MBRQrY6PNMao1HdQ431VafC6JRJCsGZ2Yv3iJ",
  "CzLTZppPdZtTjyq3WGpHLstoc3GLhu7zH5Zg6xUa6Gv5",
  "BULL151gUXcFV5wXEUqu9Am2L7Qt4bTJRLRuAUjkcspC",
  "AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES",
  "SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz",
  "PTNzAfFAB4LvoUQEUUGrFMyUoRLExMYjH6CcfyQfsVP",
  // freezeAuthority == mintAuthority WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc (4 mints)
  "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
  "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
  "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP",
  "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd",
  // Named single mints
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
  "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", // JupUSD
  "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", // CASH
]);

const { rows } = computeRows(ROOT);

const toxicMintBlocked = rows.filter((r) => r.mint);
const excludedRows = toxicMintBlocked.filter((r) => EXCLUDED_MINTS.has(r.mint));
const remainingRows = rows.filter((r) => !(r.mint && EXCLUDED_MINTS.has(r.mint)));

console.log("=== Excluded (sole TOXIC_MINT basis is a named mint) ===");
for (const r of excludedRows) {
  console.log(`  ${r.address}  mint=${r.mint}  bucket=${r.bucket}`);
}

console.log(`\nTotal BLOCKED (before exclusion): ${rows.length}`);
console.log(`TOXIC_MINT-attributed BLOCKED (mint identified): ${toxicMintBlocked.length}`);
console.log(`Excluded by named mint groups: ${excludedRows.length}`);
console.log(`Remaining BLOCKED after exclusion: ${remainingRows.length}`);
console.log(`  of which still TOXIC_MINT-attributed to a DIFFERENT mint: ${remainingRows.filter((r) => r.mint).length}`);
console.log(`  of which "без токенных правил" (never depended on TOXIC_MINT): ${remainingRows.filter((r) => r.bucket === "без токенных правил").length}`);
console.log(`  of which "НЕ ОПРЕДЕЛЕНО": ${remainingRows.filter((r) => r.bucket === "НЕ ОПРЕДЕЛЕНО").length}`);
