#!/usr/bin/env node
// Stage 4A.1 (ground-truth audit, see CLAUDE.md).
//
// Re-derives, per named mint group, exactly which BLOCKED wallets were
// excluded in scripts/audit/mint-group-impact.mjs, and sums by group. This
// exists specifically to catch and show a bug found in the stage-3 report:
// the PROSE summary there said "2cVYpagT group -> 4 blocked wallets", but
// the per-mint table printed in that same report actually listed 5 distinct
// 2cVYpagT mints with 1 blocked wallet each (a manual arithmetic slip when
// compressing the table into prose, not a bug in the underlying script --
// mint-group-impact.mjs's total of 26 was always correct).
//
// Read-only, no network calls, no src/ changes.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeRows } from "./lib/toxic-mint-rows.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const GROUPS = {
  JDq14BWv: new Set([
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
  ]),
  "2cVYpagT": new Set([
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
  ]),
  WV9PJN7X: new Set([
    "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
    "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP",
    "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd",
  ]),
  USD1: new Set(["USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"]),
  JupUSD: new Set(["JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD"]),
  CASH: new Set(["CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH"]),
};

function groupOf(mint) {
  for (const [name, set] of Object.entries(GROUPS)) {
    if (set.has(mint)) return name;
  }
  return null;
}

const { rows } = computeRows(ROOT);
const excluded = rows.filter((r) => r.mint && groupOf(r.mint));

console.log("address,mint,group,bucket");
for (const r of excluded) {
  console.log([r.address, r.mint, groupOf(r.mint), r.bucket].join(","));
}

const byGroup = {};
for (const r of excluded) {
  const g = groupOf(r.mint);
  byGroup[g] = (byGroup[g] || 0) + 1;
}
console.error("\n=== Sum by group ===");
let sum = 0;
for (const [g, count] of Object.entries(byGroup)) {
  console.error(`  ${g}: ${count}`);
  sum += count;
}
console.error(`Sum of per-group counts: ${sum}`);
console.error(`Total excluded rows (distinct wallets, deduped by construction -- one row per wallet): ${excluded.length}`);
console.error(`Distinct wallet addresses: ${new Set(excluded.map((r) => r.address)).size}`);
