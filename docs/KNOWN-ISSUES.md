# Known Issues

Tracked documentation/code inconsistencies found during the stage 9B/9D
documentation audit. Each entry cites the exact command or file:line used to
confirm it. `src/` is intentionally left unmodified for these entries (out of
scope for stage 9D, a documentation-only pass) — fixing the underlying code is
a separate, future change.

## Version string mismatch: `package.json` vs the A2A card endpoint

- `package.json:3` — `"version": "1.0.0"`.
- `src/http-server.ts:592` — the A2A agent-card object (`a2aCard()`) hardcodes
  `version: "0.3.0"`, unrelated to and out of sync with the package version.
- Confirmed via `grep -rn "0.3.0" package-lock.json src/http-server.ts` —
  the only two `0.3.0` occurrences in the repository are this literal and an
  unrelated transitive dependency version (`@solana/buffer-layout-utils`,
  `package-lock.json:196-197`, not a project version at all).
- **Status:** fixed in this branch, not deployed: the public server still returns 0.3.0 until redeployed.

## Rule count: analyzer.ts implements a 9th independent check not reflected in the "9 rules" count anywhere

- `src/analyzer.ts:471-501` (`checkFundingSource`, `type: "TAINTED_FUNDING"`)
  is a real, independently-firing anomaly rule — checked first in
  `detectAnomalies` (`analyzer.ts:520-523`) — that exists alongside the 9
  rules the rest of the codebase counts and documents everywhere as "9
  deterministic rules": `src/http-server.ts` (`/scan` description, "9
  deterministic anomaly rules"), `src/mcp.ts` (`radar_scan` / `radar_analyze`
  / `radar_trust` tool descriptions, same wording), and
  `test/regime.test.ts:332` (`"Any rule-count text now says 8"`, which
  hard-asserts the literal string "9 rules"/"9 deterministic..." across
  README.md, docs/index.html, src/http-server.ts, and src/mcp.ts).
- README.md and docs/index.html document `TAINTED_FUNDING` this stage as an
  additional, separately-called-out check (not folded into the "9" count,
  to avoid breaking `test/regime.test.ts`, which also asserts against
  `src/http-server.ts`/`src/mcp.ts` text that stage 9D is not permitted to
  change).
- **Status:** fixed in branch fixes-a (commit bb1e9bf), not deployed.

## DORMANT_ACTIVE observation: the default 7-day trust window may itself manufacture the "dormancy" gap

- **Observation from offline reproduction (stage 9E task 3), live data validation needed after collection stops.**
- `src/trust.ts:277-288` (`selectScoring`): splits a wallet's fetched history
  at `windowStart = now - windowDays*86400` (default `windowDays = 7`,
  `TRUST_DEFAULTS.windowDays`) into `priorTxs` (strictly older than
  `windowStart`, becomes the baseline) and `evalTxs` (`>= windowStart`,
  becomes the scored batch).
- `src/baseline.ts:58,78-79`: `baseline.lastSeenAt` is set to the newest
  timestamp among the txs passed into `updateBaseline` — i.e., for the
  trust-check path, the newest **prior-window** (pre-cutoff) transaction.
- `src/analyzer.ts:525-543` (`DORMANT_ACTIVE`): fires when
  `(newest_of_evalTxs - baseline.lastSeenAt) / 86400 >= dormantDays` (default
  `dormantDays = 7`).
- **Offline reproduction (`scratch/task3-dormant-window.mjs`, not committed):**
  a synthetic wallet trading exactly once every day for 20 straight days (no
  real gap ever exceeding ~1 day) was run through `selectScoring` with the
  real default `windowDays = 7`, then `updateBaseline` + `detectAnomalies`
  with the real default config. Result: `DORMANT_ACTIVE` **fired** (severity
  `medium`), reporting `daysSilent: 8` — a number produced entirely by the
  width of the two-window split (baseline pinned to just before the 7-day
  cutoff, eval batch newest near "now"), not by any actual gap in trading
  activity. Because `baseline.lastSeenAt` is structurally always ~`windowDays`
  in the past relative to "now" on this code path, this appears likely to
  fire on *every* `radar_trust`/`radar_gate_copy` call (default window) for
  *any* continuously-active wallet, not just a genuinely dormant one — but
  this has only been reproduced offline, against a synthetic fixture, this
  stage. It has not been checked against real wallet histories.
- **Status:** fixed in branch `fixes-b` (commit bcdcef1), not deployed.
  Added `RadarConfig.dormantMeasure` ("newest" default, unchanged; "first" —
  measures the gap to the evaluated batch's EARLIEST tx instead) and wired
  `"first"` into `trust.ts`'s one `detectAnomalies` call specifically. The
  walk-forward/`scan` path is provably unaffected (never touches `trust.ts`,
  default stays `"newest"`). Re-run against the real cached data this
  observation describes (`benchmarks/history-cache`, 1001 wallets, offline —
  not the live shadow-collector run, which is a separate, still-pending
  confirmation after collection stops): `DORMANT_ACTIVE` firings on the
  trust path dropped from 197/1001 to 133/1001; 25 wallets' overall trust
  verdict changed (14 `LOW_TRUST_WARMING`→`VERIFIED_SAFE`, 11
  `BLOCKED`→`LOW_TRUST_WARMING`), all 25 solely because `DORMANT_ACTIVE` no
  longer co-fires alongside their other anomalies — 0 wallets got a worse
  verdict. Live-data confirmation against the shadow collector's run
  remains open (unaffected by this fix; same caveat as before).

## TAINTED_FUNDING checks only the wallet's very first incoming transfer

- `src/analyzer.ts:471-501` (`checkFundingSource`): sorts the wallet's
  transactions ascending by timestamp and iterates them; for the **first**
  transaction found containing any incoming native transfer
  (`nt.toUserAccount === wallet`, `:476-481`), it checks whether the funder is
  in `KNOWN_EXPLOITERS`. If yes, it returns the `TAINTED_FUNDING` anomaly
  (`:483-495`). If no, it returns `null` **immediately** (`:496`) — the
  function does not continue scanning any later transaction, even if a later
  incoming transfer came from a listed exploiter address.
- Practical effect: a wallet whose first-ever recorded funding was legitimate
  can later receive funds directly from a known drainer/exploiter and
  `TAINTED_FUNDING` will never fire for it.
- Documented next to the rule's description in README.md (§"9 Deterministic
  Anomaly Rules", the `TAINTED_FUNDING` paragraph).
- **Status:** fixed in branch `fixes-b` (commit 54a8c6f), not deployed.
  `checkFundingSource` now scans every incoming native transfer in the
  supplied history, firing on the earliest one matching `KNOWN_EXPLOITERS`
  (unmodified) rather than stopping at the first incoming transfer found
  regardless of match. Severity unchanged (`high`). Test: a clean first
  incoming transfer followed by a tainted second now fires (confirmed
  failing under the pre-fix early-return logic, passing after).

## README's "Decision Engine Mapping" (§2) does not match decision.ts/trust.ts/simulate.ts's actual logic

- README described a single continuous risk-score axis (`0–30 allow, 30–70
  throttle, >70 block`) as if it were `computeDecision`'s own logic. It is
  not: see stage 9E task 1's findings (now corrected in README directly).
  Kept here only as a pointer in case a future edit reintroduces the same
  conflation: `block` in `src/decision.ts:118-126` is driven by anomaly
  **severity** (`hasExploitHigh`), not by a numeric risk-score cutoff; the
  literal `riskScore >= 70` constant that inspired "70" lives in
  `src/simulate.ts:104-105` and zeroes out **tiered payment limits**, a
  different mechanism than `computeDecision`'s verdict, and only applies
  inside the simulation path (`copyAmountUsd > 0` and a valid `mint`
  supplied). `src/defense.ts:103-118`'s `DEFENSE_THRESHOLDS` (30/50/75) is a
  third, independent system (persistent per-wallet posture, not a per-call
  verdict).
- **Status:** documentation fixed this stage (README.md, this branch). No
  code change made or proposed — the three systems are each internally
  consistent; this entry exists only to prevent the same conflation from
  recurring in future doc edits.

## `/gate-copy` cannot be gated by any authentication, and is open by default

- Source: report 11A, item 2.
- `src/http-server.ts:108-131` (`authorizeMutating`): line 115, `if (!token)
  return true;` — without `RADAR_API_TOKEN` set (the out-of-the-box
  default), every route is authorized, including the mutating set
  (`/watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear`, `:116-118`).
- Even when `RADAR_API_TOKEN` and `RADAR_AUTH_HEAVY`/`RADAR_REQUIRE_AUTH`
  are both set, the `isHeavy` set (`:119-122`) only covers `/batch`,
  `/scan`, `/trust`, `/simulate` — `/gate-copy` is in neither `isMutating`
  nor `isHeavy`, so it cannot be gated by this mechanism under any
  configuration.
- `/gate-copy` is in `LIVE_HELIUS_PATHS` (`http-server.ts:800-811`) and
  exists only in `http-server.ts`, not in the paid `src/x402server.ts`
  (confirmed via `grep -n "gate-copy" src/x402server.ts` — no match) — so
  it is both unauthenticated-by-default and free, while still incurring
  real Helius API cost.
- **Status:** fixed in branch fixes-a (commit f816910), not deployed.
- Update (branch `secaudit2`): the first bullet is stale for the mutating routes. With no `RADAR_API_TOKEN` they now answer 403 instead of being open; see H3 in the "Security audit, branch `secaudit2`" section at the end of this file.

## `fetchMintMetadata`/`getTokenLargestAccounts` failure silently skips TOXIC_MINT for that mint (fails open)

- Source: report 11A, item 1(a).
- `src/mint.ts:496-524` (`fetchSwapMintRisk`): a per-mint fetch failure is
  caught (`:516-518`) and that mint is simply omitted from the returned
  `MintRiskMap` — not recorded as `null`, just absent.
- `src/analyzer.ts:780`: `const meta = mintRisk[m]; if (!meta) continue;
  // Fetch failed or no metadata: skip rule for this mint` — a mint whose
  metadata fetch failed receives no TOXIC_MINT evaluation at all,
  regardless of its actual risk.
- **Status:** fixed in branch `fixes-b` (commit 69c1120), not deployed, for
  `/gate-copy` and `radar_gate_copy` specifically (the single-mint
  `fetchMintMetadata` lookup these use, not `fetchSwapMintRisk`'s
  batch-map path used by `/scan`/`/trust`, which this entry's `analyzer.ts:780`
  silent-skip still applies to — that batch path was out of this stage's
  scope). A fetch failure (thrown error, or a successful call resolving to
  `null`) now sets `tokenCheck: "unavailable"`, emits a new
  `TOKEN_CHECK_UNAVAILABLE` anomaly (severity `low`, contributes 0 risk
  points), and caps the verdict at `manual_review` whenever
  `copyAmountUsd > 0` — block stays block, but what would have been
  `throttle`/`allow` is downgraded, so a failed check can never read as
  safer than "needs a human."

## `BLUECHIP_FALLBACK_PRICES` is defined but never used; price-feed failure degrades LARGE_SWAP to major-mints-only

- Source: report 11A, item 1(c).
- `src/pricing.ts:115-128` defines a hardcoded fallback USD price table
  (SOL, USDC, USDT, WBTC, WETH, mSOL, bSOL, JitoSOL, JUP, RAY, BONK, PYTH).
  `grep -rn "BLUECHIP_FALLBACK_PRICES" src/*.ts` finds only this
  definition — it is never imported or referenced anywhere else.
- On a real Jupiter price-feed failure, `fetchSwapPrices` (`pricing.ts:
  135-149`) returns `null` (`:147`); `LARGE_SWAP` then falls back to
  comparing raw token quantities restricted to `MAJOR_MINTS` (SOL/USDC/
  USDT) only (`analyzer.ts:661-681`) — non-major mints get no LARGE_SWAP
  detection at all during a price-feed outage, not stale hardcoded prices.
- **Status:** fixed in branch `fixes-b` (commit 3feeaba), not deployed.
  `BLUECHIP_FALLBACK_PRICES` is explicitly commented as dead-in-production
  (kept only for `scripts/audit/*.mjs`'s offline historical replay, which
  legitimately needs a frozen, reproducible price set — not wired into any
  live path). Separately, `/scan`, `/trust`/`/batch` (`TrustResult.degraded`),
  and `/gate-copy` now report `degraded: ["PRICES_UNAVAILABLE"]` when the
  price fetch actually failed (not when a caller deliberately requested
  `noPrices`) — verdicts and risk scores themselves are unchanged by this
  item; it only makes the existing degrade-to-major-mints-only behavior
  visible in the response instead of silent.

## TOXIC_MINT does not consider Token-2022 extensions

- Source: report 11A, item 1(b).
- `grep -rn "permanentDelegate|pausable|transferHook|defaultAccountState"
  src/mint.ts src/types.ts src/analyzer.ts` — zero matches.
- `MintRiskInfo` (`src/mint.ts:9-46`, `:48-73`) only ever extracts
  `mintAuthority`, `freezeAuthority`, `top10Pct`, `isPumpFun`. Token-2022
  extensions that can equally or more severely affect counterparty risk
  (`permanentDelegate` — clawback, `pausableConfig` — global transfer
  halt, `transferHook` — arbitrary on-transfer logic, `defaultAccountState`
  — new accounts start frozen) are not read or evaluated by TOXIC_MINT at
  all.
- **Status:** fixed in branch `fixes-b` (commit 73395bc), not deployed, for
  the RPC `getAccountInfo` jsonParsed fallback path specifically (the
  Helius DAS `getAsset` path, `parseDasAssetResponse`, is NOT extended —
  its Token-2022 extensions jsonParsed shape was not independently
  confirmed, so nothing was guessed there; this is a known remaining gap).
  `MintRiskInfo` gained `permanentDelegate`, `pausable`, `transferHook`,
  `defaultAccountStateFrozen`. Fixed severities: `permanentDelegate` and a
  frozen `defaultAccountState` → `high`; `pausable` and a `transferHook`
  pointing at any program other than this project's own hook
  (`wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV`) → `medium`. This check
  does not currently apply to `/gate-copy`'s own mint check — see the
  `TOKEN_CHECK_UNAVAILABLE`/`fetchMintMetadata` entry above: `simulate.ts`'s
  TOXIC_MINT-equivalent logic (used by `/gate-copy`) only checks
  `freezeAuthority`/`top10Pct`, not these new fields — a pre-existing gap
  this stage did not close.

## x402 replay protection is per-process; cross-process concurrent delivery is possible

- Source: report 11A, item 3.
- `src/x402server.ts:1000-1005`: the replay check (`inFlightPayments.has()
  || store.hasSettledPayment()`) and `inFlightPayments.add()` are fully
  synchronous with no `await` between them — not racy within one process.
- `inFlightPayments` is in-memory, per-process. `x402server.ts:1161-1169`
  (and the matching `/analyze` branch, `:1183-1187`): the 200 response with
  the full paid result is sent **regardless** of whether
  `store.recordSettledPayment()` returned `true` or `false` — the code's
  own debug log admits this: `console.warn("[x402] payment signature
  settled concurrently; scan still delivered")` (`:1162`). Two concurrent
  requests carrying the same valid signature, routed to two different
  worker processes, would each pass their own local check, each re-verify
  successfully (verification is read-only against the chain), and each be
  served — the SQLite `UNIQUE` constraint on `settled_payments.signature`
  prevents a duplicate database row, not duplicate delivery.
- Confirmed by reading the code; not exercised under real multi-process
  concurrency (out of scope, no network/process orchestration this stage).
- **Status:** fixed in branch fixes-a (commit 0e50956), not deployed.

## Payment-verification error message may include `err.message`; whether it can contain the RPC URL (with the API key) is unconfirmed

- Source: report 11A, item 1(d)/item 3.
- `src/mint.ts:411`, `src/trust.ts:336`, `src/x402server.ts:180` all embed
  `HELIUS_API_KEY` directly into the RPC URL as a query parameter
  (`?api-key=...`).
- `src/x402server.ts:492-493`: `catch (err) { return { valid: false, error:
  \`Verification exception: ${err.message}\` } }` — this `error` field is
  returned in the public HTTP response to the paying client.
- Whether a failed `fetch()` call's `.message` can ever contain the
  request URL (and thus the embedded key) — NOT VERIFIED: confirming this
  requires triggering a real network failure against a key-bearing URL,
  which this stage's rules do not permit.
- **Status:** fixed in branch fixes-a (commit 27145ac), not deployed.

## Transfer Hook: single program upgrade authority, single per-mint config authority, no explicit risk_score bound

- Source: report 11A, item 4.
- The program's own upgrade authority (`4bDZPMF9j3Jm6rUVofT3be6JH67C1tRFBff9MnrsE2EY`,
  confirmed stage 9B) is a single key that can redeploy the entire program
  for every mint that uses it — no multisig/timelock observed on-chain
  (whether that key is itself a multisig/Squads vault was not checked,
  would require a live RPC call).
- Each mint's `config.authority` (`programs/radar-transfer-hook/src/
  lib.rs:640,710,739`, Anchor `has_one = authority`) is a single `Signer`
  per mint, separate from the program upgrade authority, with no on-chain
  multisig requirement.
- `write_scan_record`'s `risk_score: u8` parameter (`lib.rs:492`) has no
  explicit `<= 100` bounds check — low severity, since only the trusted
  `config.authority` can call this instruction.
- **Status:** finding, fix planned after 2026-10-06.

## Test-quality: two constants have zero test coverage at their boundary, five tests are tautological

- Source: report 11A, item 5.
- Mutating `REGIME_DOMINANT_RATIO` (`analyzer.ts:256`, 0.7 → 0.4) and
  `DEFENSE_THRESHOLDS.blocked` (`defense.ts:109`, 75 → 90) each produced
  **zero** failures across `test/analyzer.test.js`, `test/defense.test.js`,
  `test/toxic_mint.test.js`, `test/regime.test.js` (115 tests total).
  Verified by editing each constant in turn, running `npm run build &&
  node --test <the 4 files>`, then reverting (`git checkout --`); final
  `git status` was clean.
- Five tests derive their own pass/fail oracle from the same constant the
  production rule reads, so they cannot catch a regression in that
  constant's value (only in the comparison operator):
  1. `test/analyzer.test.ts:685` — "DORMANT_ACTIVE: boundary conditions" —
     builds its gap from `DEFAULT_CONFIG.dormantDays * 86_400` (`:687`).
  2. `test/analyzer.test.ts:465` — "ACTIVITY_BURST: window boundary" —
     builds its window from `DEFAULT_CONFIG.burstWindowMin * 60` (`:467`).
  3. `test/analyzer.test.ts:536` — "CONCENTRATION: window boundary" —
     builds its span from `DEFAULT_CONFIG.concentrationWindowMin * 60`
     (`:538`).
  4. `test/defense.test.ts:67` — "escalates to blocked at risk >= blocked
     threshold" — feeds `DEFENSE_THRESHOLDS.blocked` directly as the input
     `riskScore` (`:68`).
  5. `test/defense.test.ts:62` — "escalates to gated at risk >= gated
     threshold" — same pattern with `DEFENSE_THRESHOLDS.gated` (`:63`).
- **Status:** fixed in branch fixes-a (commit e0dc8d9), not deployed.

## `npm audit`: 12 known vulnerabilities in the dependency tree (9 moderate, 3 high)

- Source: report 11B.
- Reported packages: `bigint-buffer`, `@solana/buffer-layout-utils`,
  `@solana/spl-token` — all reachable through `@solana/spl-token@0.4.15`'s
  own dependency tree, not a direct top-level choice.
- Re-confirmed on branch `fixes-b` via `npm audit` (2026-10-01): still 12
  vulnerabilities (9 moderate, 3 high) — unchanged from report 11B. No
  dependency was changed by this update.

### B7: reachability analysis (stage 15B) — dependency versions NOT changed

Every place `src/` imports `@solana/spl-token`, and whether the specific
flagged `bigint-buffer` functions (`toBigIntLE`, `toBigIntBE`, `toBufferLE`,
`toBufferBE`) are actually reachable with externally-sourced data (RPC
responses, user input) through those import sites:

- **All `@solana/spl-token` imports in `src/`** (confirmed exhaustive via
  `grep -rn "@solana/spl-token" src/*.ts src/**/*.ts`): exactly two files,
  each importing exactly one function, `createAssociatedTokenAccountIdempotentInstruction`:
  - `src/blink/index.ts:10` (import), called at `src/blink/index.ts:225-226`.
  - `src/sdk/index.ts:3` (import), called at `src/sdk/index.ts:372-373`.
  - No other `@solana/spl-token` export is imported anywhere in `src/`.
- **Call-graph trace for `createAssociatedTokenAccountIdempotentInstruction`**
  (`node_modules/@solana/spl-token/lib/esm/instructions/associatedTokenAccount.js:31-33`):
  delegates to `buildAssociatedTokenAccountInstruction`, which only builds a
  `TransactionInstruction` from a fixed 1-byte data buffer and account
  pubkeys (`new PublicKey(...)`/`.toBuffer()` calls) — it does not decode any
  on-chain account data. Its only other import from `spl-token` is
  `getAssociatedTokenAddressSync` (`../state/mint.js:124-129`), which is pure
  PDA derivation (`PublicKey.isOnCurve`, `PublicKey.findProgramAddressSync`)
  and likewise never touches a byte-layout codec.
- **Where `toBigIntLE`/`toBigIntBE`/`toBufferLE`/`toBufferBE` actually live**:
  `node_modules/@solana/buffer-layout-utils/lib/cjs/bigint.js:21` (decode,
  `toBigIntLE`/`toBigIntBE`) and `:32` (encode, `toBufferLE`/`toBufferBE`),
  inside that package's `u64`/`u128`-style layout codec. `state/mint.js:1-2`
  imports this codec (`@solana/buffer-layout-utils`'s `bool`/`publicKey`/`u64`)
  at module scope for its OTHER exports (`MintLayout`, `unpackMint`, binary
  decoders of on-chain mint accounts) — so the vulnerable package is loaded
  into the process (an ES module's top-level imports always execute), but
  `getAssociatedTokenAddressSync` specifically never calls into that codec.
- **No other file under `src/` imports `@solana/buffer-layout-utils` or
  `bigint-buffer` directly** (confirmed via
  `grep -rn "buffer-layout-utils\|bigint-buffer" src/*.ts src/**/*.ts` —
  no match).
- **Classification for all four flagged functions** (`toBigIntLE`,
  `toBigIntBE`, `toBufferLE`, `toBufferBE`): **недостижимо** (unreachable)
  through this project's actual code — the only two call sites into
  `@solana/spl-token` use a function whose own call graph never reaches the
  codec that wraps these, and no other path into `bigint-buffer` exists in
  `src/`. This is a reachability finding based on static tracing of the
  exact functions called, not a claim that the dependency itself is safe to
  leave unpatched, and it does not account for any future code change that
  imports a different `@solana/spl-token` export (e.g. `unpackMint`,
  `getAccount`) that WOULD reach this codec.
- **Status:** reachability analysis complete (this stage, branch `fixes-b`,
  not deployed) — dependency versions unchanged, `npm audit` still reports
  the same 12 vulnerabilities; this entry documents exploitability through
  this project's own code, it does not resolve the underlying advisories.

## "Sub-second" latency claim holds for offline `/analyze` only, not for live `/trust`

- Source: report 11B.
- Offline `/analyze` (pre-recorded fixtures, no network): median 3.69ms.
- Live `/trust` (real Helius history fetch + RPC balance query): measured
  1.0–2.4s across 5 wallets.
- README wording corrected this stage (see below) to distinguish the two.
- **Status:** finding, fix planned after 2026-10-06 (wording
  fixed this stage; no code change proposed).

## `examples/copy-bot-firewall.ts` demo uses a built-in mock `fetchFn`, never calls a real server

- Source: report 11A/11B.
- `examples/copy-bot-firewall.ts:74-94`: `createRadarClient` is
  constructed with a `fetchFn` that always returns canned, hardcoded
  responses keyed on specific example wallet addresses ("Mock fallback
  fetcher for standalone demo runs if remote server is offline", `:76`) —
  this mock always takes priority, so the demo never actually reaches
  `RADAR_API_URL`/a real running server, regardless of whether one exists.
- Not a bug — the demo is explicitly designed to run standalone — but
  worth stating plainly rather than implying it exercises a live gate.
- **Status:** finding, fix planned after 2026-10-06 (demo
  behavior, not incorrect, just undocumented until now).

## Light Protocol oracle: logic confirmed in tests, on-chain write path unverified; the program ID is Light's own, not project-specific

- Source: report 11B.
- `src/oracle/ledger.ts:77`: `DEFAULT_ORACLE_PROGRAM_ID = new
  PublicKey("SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7")` — the comment
  directly above it states "Defaults to Light Protocol System Program" —
  this is Light Protocol's own program, not a program this project
  deployed or controls.
- Confirmed: unit-test coverage of the ledger's pack/unpack/verify logic
  exists. Not confirmed this stage: an actual write to Light Protocol's
  compressed-account state on a live network (would require network
  access, out of scope).
- **Status:** finding, fix planned after 2026-10-06.

## Public server `radar.cbellory.xyz`: read-only routes open behind Cloudflare without authentication

- Source: verified by user directly on the public server (live check, outside the tools of this session — network access to external hosts was not performed in this stage).
- User confirmed: `GET /watch`, `GET /alerts`, `GET /defense`, `GET /dashboard`, `GET /economics` on `radar.cbellory.xyz` (behind Cloudflare) respond without any authentication; response contents checked by user — contain no sensitive data (keys, private balances, addresses outside the public watchlist).
- Independently confirmed by code reading (this session, without network): all these routes are registered as `GET` (`src/http-server.ts:53,56,57,58,
  63,66`), and `authorizeMutating` (`http-server.ts:108-131`) checks authorization only for `method === "POST"` (`:116-122`) — GET routes **structurally cannot be gated** by this mechanism under any `RADAR_API_TOKEN` configuration, not merely "open by default" as already noted for POST routes (see the entry '`/gate-copy` cannot be gated by any authentication, and is open by default').
- `POST /gate-copy`, `POST /scan`, `POST /trust`, `POST /batch` on this public server were not verified by user (live request was not performed); per code (`authorizeMutating:115`, see the entry '`/gate-copy` cannot be gated by any authentication, and is open by default') they are unprotected if `RADAR_API_TOKEN` is not set — i.e., open if this is the sole defense and token is unconfigured.
- HSTS: `Strict-Transport-Security` header is nowhere set in the application (`grep -rn "Strict-Transport-Security" src/` — zero matches); whether it is enabled at the Cloudflare level — per user observation, not enabled on the public server.
- CORS: `Access-Control-Allow-Origin: *` confirmed by reading code — `src/config.ts:71`, active when `RADAR_CORS_ORIGINS` is not set.
- Revenue via `/economics` on the public server at the time of user check: 0.005 USDC (single payment) — user observation, not measured by this session.
- **Status:** fixed in branch fixes-a (commit f816910), not deployed. See
  `docs/DEPLOY-CHECKLIST.md` (added in branch `fixes-b`) for the full set of
  env vars and verification steps for a public-facing deployment, including
  the explicit list of routes (`/dashboard`, `/economics`, `/trust-proof`,
  `/.well-known/agent.json`, `/a2a`) that stay open under every
  combination of those vars, since none of the auth checks ever inspect
  them.

## Sole x402 payment: confirms pipeline, not revenue; typo in payer address in daily-digest.ts

- Source: report 11E.
- (a) Sole payment in the recipient history of `F6wWPy4c3fXTJDqU19Nax8FhQumeMcsSVpD2YwxLpBNR`: 0.005 USDC, 2026-09-18, payer `3fNNY9iEvzmfqt4gTdEmvRKNa9G3mKkHq523uS5t5eYh` (labeled "x402 Payer" in `src/daily-digest.ts:24` — line number verified via `git grep -n "x402 Payer" -- src/daily-digest.ts`, matches). The payment confirms that the payment pipeline (proof → verify → settle) executes on a real transaction; this is **not** external revenue — sole known payment across all time, from the operator's own demo wallet (per project notes).
- (b) Upgrade authority of the Transfer Hook program on devnet (`4bDZPMF9j3Jm6rUVofT3be6JH67C1tRFBff9MnrsE2EY`) — regular key: `owner` = System Program, `space` = 0, no indication of multisig (Squads, etc.). Not re-verified in this session (network access was not performed in this stage) — source: report 11E.
- (c) Typo in address: `src/daily-digest.ts:24` contains `"3fNNuJcvV2bYmrh7XjTq7u22C7V6F2qXq8pE4jM5eYh"` — 43 characters. Directly verified in this session (base58 decoding): this string decodes to **31 bytes**, not 32 as required for a valid Solana address; the actual payer address (44 characters, decodes to 32 bytes) is `3fNNY9iEvzmfqt4gTdEmvRKNa9G3mKkHq523uS5t5eYh` (see item (a) above). The strings differ, though visually similar (shared prefix `3fNN`, shared suffix `5eYh`). The same invalid address in the `radar-watch` watchlist produces a Helius 400 error every 5 minutes (per report 11E, not reproduced in this session — network was not used).
- **Status:** fixed in branch fixes-a (commit 4478183), not deployed. Branch
  `fixes-b` (commit 295cb24) separately closes the general class of this bug:
  `isValidBase58` (the check used everywhere before `fixes-b`) only verified
  the base58 alphabet and a 32-44 character length range, so a 43-44
  character string with one dropped/substituted character — exactly this
  typo — would have passed it too, undetected, at every validation call
  site, not just this one hardcoded address. The new `isValidSolanaAddress`
  additionally decodes and requires exactly 32 bytes, and is now used at
  every wallet/mint validation point for `/trust`, `/batch`, `/scan`,
  `/simulate`, `/gate-copy`, `/watch`, `/unwatch`, `/defense`, and the
  matching MCP tools.

## BUG-1: Confirmation mismatch between x402 server and SDK

- Source: Stage 17D reproduction & Stage 15D issue C1.
- `src/x402server.ts`: `verifySolanaPaymentRpc` queried Solana RPC `getTransaction` without specifying a `commitment` level, defaulting on Solana nodes to `"finalized"`. Meanwhile, `src/sdk/index.ts` confirmed payment transactions at `"confirmed"` commitment and immediately retried the endpoint, causing the server to respond with 402 `"Transaction not found on-chain"`.
- Resolved in C1:
  - Server now reads `RADAR_X402_COMMITMENT` ("confirmed" or "finalized", default "confirmed"; invalid values logged with warning and fallback to "confirmed"), and passes `commitment` to `getTransaction`.
  - When RPC returns `null`, server retries up to 3 times with 1-second pause (only if signature matches 86-90 base58 characters; malformed signatures fail immediately without retries) before returning 402 with hint `"Transaction not found on-chain (retry in a few seconds if you just paid)"`.
  - SDK polls `getSignatureStatuses` for up to 20 seconds after transaction submission until desired `commitment` is reached, and retries 402 "not found" responses up to 3 times with 2-second delay.
- **Status:** fixed in branch fixes-c (commit f888112), not deployed. Verified in test suite (`test/x402.test.ts`, `test/sdk.test.ts`, `test/adversarial.test.ts`).

## POST /analyze and 500: Missing input validation prior to payment and internal error leakage

- Source: Stage 17D reproduction & Stage 15D issues C2 & C3.
- `src/x402server.ts` and `src/sdk/index.ts`: `POST /analyze` expected Helius Enhanced transaction objects with `signature` (string) and `timestamp` (number). When callers provided raw RPC transactions (`blockTime`, `transaction.signatures`), the server either returned 402 without validating body format, or verified payment and crashed inside `defaultAnalyzeHandler` with an unhandled exception, responding with HTTP 500 instead of HTTP 400.
- Resolved in C2 & C3:
  - `src/x402server.ts` validates `txs` format before checking payment and before returning 402. Invalid transaction items return HTTP 400 with `"txs[i] must be a Helius Enhanced transaction object with signature (string) and timestamp (number); got raw RPC format?"`.
  - `src/sdk/index.ts` (`client.analyze`) validates `txs` format prior to payment, throwing descriptive error without sending funds or invoking payment signers.
  - Handler input errors return HTTP 400; unexpected errors return HTTP 500 `"Internal server error"` without internal details. `isInputError` strictly classifies errors by `status === 400`, `statusCode === 400`, or `name === "ValidationError"` / `InputError"` (no message regex matching).
  - Responses with `"paymentVerified": true` and retry hint guarantee no `"api-key"` or `"http"` leakage.
  - If payment is verified but handler fails, response sets `"paymentVerified": true` and hint `"retry with the same signature within <secondsLeft>s"`, keeping the payment unspent (`settled_payments` not marked) so retrying with a corrected body succeeds without re-paying.
- **Status:** fixed in branch fixes-c (commit b2a85e1, commit 178ee43), not deployed. Verified in test suite (`test/x402.test.ts`, `test/sdk.test.ts`).

## /economics displays operator test payments rather than external protocol revenue

- Source: Stage 11E/17B verification & Stage 15D issue C4.
- `GET /economics` displays settled payment totals from `settled_payments`. Historical payments on record (e.g. 0.005 USDC) reflect operator test/pipeline confirmation transactions from the operator's own demo wallet (`3fNNY9iEvzmfqt4gTdEmvRKNa9G3mKkHq523uS5t5eYh`), rather than external commercial customer revenue.
- Status: documented, not a code change. /economics shows settled payments; the payments on record come from the operator's own wallet and are not external revenue.

## Dashboard redesigned in branch dashboard, not deployed; reads only existing fields; recorded replay is a historical window

- Source: stage 16A/16C dashboard redesign.
- Branch `dashboard` completely overhauls the HTML rendered by `GET /dashboard` (`src/dashboard.ts`, `src/dashboard-radar.ts`, `src/dashboard-fonts.ts`) into a high-contrast radar visualization using embedded Big Shoulders Display and JetBrains Mono fonts.
- The branch is isolated and not merged into `release` or `main` (held until after 2026-10-06 preregistration freeze concludes). Not deployed to production or Cloudflare.
- The dashboard strictly reads existing fields from the data model (no speculative or synthetic fields):
  - In live records without multi-layered consensus or liquidity data, missing fields are omitted or indicated gracefully without synthetic mocks. Base/Agent/Defense values are never calculated by the dashboard from risk scores.
  - Recorded replay (`docs/dashboard/replay-8XeK5m.json`) is explicitly presented as a historical window (`recordedAtUtc: 2026-10-01T20:29:39Z`), annotated with "historical replay, not a confirmed incident", and not represented as live telemetry.
  - Independent test status (`docs/dashboard/test-status.json`) displays `result: null` during collection without previewing or fabricating score numbers.
- **Status:** implemented in branch `dashboard`, awaiting deployment post-freeze.

# Security audit, branch `secaudit2` (code review + local tests only)

Scope reviewed: `src/http-server.ts`, `src/x402server.ts`, `src/sdk/`, `src/mcp*.ts`, `src/oracle/`, `src/hook/`,
`programs/` (Rust, read only, not compiled), `src/config.ts`, `src/dashboard*.ts`, `src/watch.ts`, `src/alerts.ts`,
`src/cli.ts`, `src/daily-digest.ts`, `docs/DEPLOY-CHECKLIST.md`. No network, no keys, no live server, no on-chain
verification: anything that depends on on-chain behaviour is marked НЕ ПРОВЕРЕНО. Only critical/high findings were
fixed (none critical, four high), plus two medium findings that were explicitly requested (M1, M2). Detection rules,
thresholds and verdicts were not changed. Regression tests are in `test/secaudit-*.test.ts`; unfixed gaps are
documented there as `todo` tests.

## Fixed in branch `secaudit2`

### H1 (high): the SDK paid whatever a 402 response asked for

- `src/sdk/index.ts` (`resolvePaymentProof`, every paid method: `scan`, `analyze`, `trust`, `batch`, `simulate`)
  signed and sent a payment for the amount, recipient and currency taken from the server's 402 headers/JSON.
- Reachable by default whenever the client talks to a malicious or compromised server, or to a plain-http server
  through a MITM.
- Fix: `assertPaymentTermsAcceptable` runs first in `resolvePaymentProof`: finite positive amount, at most
  `maxPaymentUsdc` (default 0.05), USDC only, recipient must equal the configured `recipient` when one is configured.
- **Note for operators:** a server price above 0.05 USDC (for example `RADAR_SCAN_PRICE_USDC` raised) is now refused
  by default; the client must pass a higher `maxPaymentUsdc`.
- **Status:** fixed in branch secaudit2 (commit 48e2a3f), not deployed. Test `test/secaudit-sdk-payment.test.ts`.

### H2 (high): unauthenticated `/dashboard` and `/api/ledger` caused unbounded upstream work and memory growth

- `src/dashboard.ts` passed the `wallet` query string, unvalidated, to the oracle reader; each distinct string cost
  up to about 20 upstream RPC calls and left a permanent entry in `LightZKOracleClient.anchorCache`
  (`src/oracle/ledger.ts`), keyed by an attacker-chosen string.
- Reachable by any HTTP client in the default configuration when the dashboard route is served.
- Fix: base58 validation (HTTP 400) before any query on both routes; `anchorCache` capped at 1000 entries.
- **Status:** fixed in branch secaudit2 (commit 0e38c15), not deployed. Test `test/secaudit-ledger-dos.test.ts`.

### H3 (high): mutating endpoints were open without `RADAR_API_TOKEN`

- `src/http-server.ts` `authorizeMutating`: with no token every route was authorized, including
  `POST /watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear`. Default bind is `0.0.0.0`, default CORS is `*`, and
  the body parser accepts `text/plain` JSON, so even a web page could send these requests.
- Fix: without a token those routes answer 403 unless `RADAR_ALLOW_UNAUTH_MUTATIONS=1` (or the
  `allowUnauthenticatedMutations` option) is set. With a token the behaviour is unchanged (401 without it, 200 with it).
- **Behaviour change:** a deployment with `RADAR_WATCH=1` and no token loses these routes until a token is set. See
  `docs/DEPLOY-CHECKLIST.md` section 2a for the callers found in this repository.
- Statements elsewhere in this file and in `README.md` that every route is authorized without a token are stale for
  these four routes.
- **Status:** fixed in branch secaudit2 (commit 306ab78), not deployed. Test `test/secaudit-mutating-auth.test.ts`.

### H4 (high, only with non-default configuration): anonymous `POST /scan` triggered operator-signed on-chain writes

- `src/http-server.ts` `toolScan`: when a hook bridge is configured (`RADAR_HOOK_MINT` + `RADAR_HOOK_KEYPAIR`) or
  `RADAR_ORACLE=1`, any caller could make the operator's key sign and pay for a hook-PDA update / oracle memo for an
  arbitrary wallet. Not reachable in a default configuration.
- Fix: the verdict is still returned to everyone; the on-chain writes happen only for requests with a valid API
  token, or when `RADAR_ALLOW_ANON_ONCHAIN_WRITES=1` / `allowAnonymousOnchainWrites` is set.
- The paid flow in `src/x402server.ts` is unchanged (the write follows a verified payment). The MCP server is
  stdio-only, so its caller is the local client.
- The oracle-memo branch shares the gate but has no test (it would need network); the hook-bridge branch is tested.
- **Status:** fixed in branch secaudit2 (commit 2229619), not deployed. Test `test/secaudit-onchain-gate.test.ts`.

### M1 (medium; high with `RADAR_WATCH=1`): `/scan` enrolled any wallet in the watch loop

- `saveBaseline` (`src/store.ts`) inserted into the same `wallets` table the watch loop iterates (`src/watch.ts`
  `listWallets()`), so an anonymous `/scan` (and the MCP `radar_scan`, the x402 `/scan`) put the scanned wallet on
  the poll list: unbounded table growth and upstream polling of attacker-chosen wallets. It bypassed the H3 control.
- Fix: column `wallets.watched INTEGER NOT NULL DEFAULT 0`. Only `addWallet` (`POST /watch`, `radar add`) sets 1;
  `listWallets()` returns only `watched=1`; `saveBaseline` still persists the scoring profile, so verdicts do not
  change (`scripts/audit/m1-scan-compare.mjs`: output of a fixed 8-scan sequence is byte-identical before and after,
  sha256 `a2af13b9b87f68561059e85a8636475274783995a15cf01b7c4c6827e46c84d4`). On open, an old database gets the
  column added and **every existing row is set to watched=1**, so the current watch list is preserved.
- **Behaviour change:** `radar scan <wallet>` (CLI) no longer adds the wallet to the watch list; use `radar add`.
  `hasWallet()` still means "a row exists" (used by `radar report` / `radar history`).
- **Status:** fixed in branch secaudit2 (commit 061d7c7), not deployed. Test `test/secaudit-watched.test.ts`.

### M2 (medium): Blink complete route could be replayed concurrently

- `src/x402server.ts` Blink `verifyPayment`: check (`hasSettledPayment`), then `await` verification, then
  `recordSettledPayment`, with no in-flight guard and the boolean result ignored. N concurrent requests with one
  payment signature could all pass the check and each receive a scan (value at risk: 0.005 USDC per extra scan).
- Fix: shares `inFlightPayments` with the main paid flow (released in `finally`) and rejects the loser of the INSERT
  race. Test: 5 concurrent requests with one signature give exactly one 200 (it returned five before the fix).
- The in-flight set is still per-process (see "x402 replay protection is per-process" above).
- **Status:** fixed in branch secaudit2 (commit a1dbeb6), not deployed. Test `test/secaudit-blink-replay.test.ts`.

## Found, not fixed

### D1 (medium, availability of a feature; НЕ ПРОВЕРЕНО on-chain): oracle memo anchors are binary, not UTF-8

- `src/oracle/ledger.ts` `sendMemoAnchor` (`:642`, `memoData` at `:683`) sends `RADAR_ORACLE:` + the RS01 binary record
  (header, risk byte, 8-byte timestamp, and a 96-byte Ed25519 signature trailer) as SPL Memo instruction data.
  `scripts/audit/oracle-memo-utf8.mjs`: 0 of 2000 realistic signed records are valid UTF-8. The SPL Memo program is
  documented to accept only UTF-8 data, so such a transaction would be rejected; if so, the verified-anchor read
  path (`:848` onward) would find nothing and clients fall back to the unverified lamports decode. This was not
  confirmed on a real cluster (no network in this audit); `SECURITY.md` and the class docs describe the memo path as
  working. **Needs a devnet check by the owner.**
- `test/secaudit-oracle-memo.test.ts` has a `todo` test for it.
- **Status:** not fixed (not critical/high), not verified on-chain.

### D2 (medium, latent): the attestation signature does not cover `topRules`, `txSignatures`, or a custom verdict

- `buildAttestationDigest` (`src/oracle/ledger.ts:116`) hashes wallet, risk, verdict code and timestamp only. The
  payload JSON (`topRules`, `txSignatures`, a verdict string when the code is 255) travels outside the signature.
  The anchor reader first reads transactions that merely list the wallet as an account (`:848`) and accepts any memo
  whose signature verifies, so a replayed genuine signed record with a different payload would be accepted as
  verified. Exploiting it needs a genuine signed memo on-chain, which D1 may make impossible today.
  `deserializeScanRecord` also passes a non-array `topRules` through (`:308`).
- **Status:** not fixed. Suggested: include a hash of the payload in the digest and type-check `topRules`.

### D3 (low, latent): `data-anomaly-text` attribute is not quote-escaped

- `src/dashboard.ts:1231` writes `escapeText(description)` into a double-quoted attribute; `escapeText` does not
  escape `"`. Reproduced offline: `x" onfocus="alert(1)" autofocus="` in a replay anomaly text yields a live
  `onfocus` attribute. Sources of that text today: the repo-controlled replay JSON, and ledger `topRules` (see D2).
  All other interpolations reviewed in `src/dashboard.ts` and `src/dashboard-radar.ts` are escaped, there is no JSON
  embedded in the inline `<script>` (it is static), and `/dashboard` rejects non-base58 wallets (H2).
- **Status:** not fixed. One-line fix: use `escapeHtml` for the attribute. `todo` test in
  `test/secaudit-dashboard-escaping.test.ts`.

### D4 (low): Telegram parse mode is auto-detected from unescaped text

- `src/alerts.ts:37`: a plain-text message containing `<b>` or `<code>` is sent with `parse_mode=HTML`;
  `formatAlert` does not escape anomaly text. Anomaly texts today embed numbers, base58 addresses and venue names,
  so hostile markup would have to come from upstream data. `WEBHOOK_URL`, `TG_BOT_TOKEN`, `TG_CHAT_ID` are read only
  from the operator environment (`grep` found no route or tool that sets them), so SSRF through them is not
  reachable from external input. Failed sends log status and response body only, never the token.
- **Status:** not fixed. `todo` test in `test/secaudit-alerts.test.ts`.

### L1 (low): heavy routes are unauthenticated by default

- `src/http-server.ts:131` (`isHeavy` is evaluated only when `authHeavy` is on). `/batch`, `/scan`, `/trust`,
  `/simulate`, `/gate-copy` cost Helius credits and are open by default; the per-IP limits
  (`RADAR_LIVE_RATE_LIMIT_PER_MIN`, default 30; `RADAR_RATE_LIMIT_PER_MIN`, default 120) are the only brake.
- **Status:** not fixed (intended for a public API). Set `RADAR_AUTH_HEAVY=1` with a token to gate them.

### L2 (low): CORS is `*` by default

- `src/config.ts:90`. No cookie authentication is used, so there is no credentialed cross-site read; before H3 it
  made the open mutating routes reachable from a web page. `RADAR_CORS_ORIGINS` restricts it.
- **Status:** not fixed.

### L3 (low): default bind address is `0.0.0.0`

- `src/http-server.ts:1502, 1524`, `src/x402server.ts:1498` (`HOST` overrides).
- **Status:** not fixed.

### L4 (low): `RADAR_PROTECT_READS=1` without a token protects nothing

- `authorizeMutating` (`src/http-server.ts:128`) returns "ok" for non-mutating routes when no token is configured, so
  an operator who sets `RADAR_PROTECT_READS=1` but forgets `RADAR_API_TOKEN` gets no protection and no warning
  (same for `RADAR_AUTH_HEAVY`).
- **Status:** not fixed.

### L5 (low): MCP `radar_analyze` does not validate `wallet` and does not bound `txs`

- `src/mcp.ts:164-196`: `wallet` is used unvalidated (only for a parameterized store lookup and echoed back);
  `txs` is an unbounded JSON string. The server is stdio-only, so the caller is the local client (an LLM agent that
  can be prompt-injected), and the effect is local CPU/memory. The other tools validate wallets
  (`isValidSolanaAddress`, and again inside `runTrustCheck` and the collector, which also URL-encodes the address);
  `test/secaudit-mcp-input.test.ts` shows hostile wallets/mints are refused before any network call.
- **Status:** not fixed.

### I1 (info): Blink routes on the plain HTTP server serve a trust check without payment

- `src/http-server.ts:1018` calls `handleBlinkHttpRequest` with a `scanHandler` that runs `toolTrust` and no
  `verifyPayment`; this equals the open `/trust` route. The paid Blink flow is in `src/x402server.ts`.
- **Status:** not fixed.

### I2 (info): upstream error text can reach API responses

- `TOKEN_CHECK_UNAVAILABLE` (`src/mcp.ts:446`, `src/http-server.ts`) includes `err.message` from the mint-metadata
  fetch. The messages built in `src/collector.ts`, `src/pricing.ts`, `src/trust.ts` carry status codes, not URLs or
  keys; RPC server error bodies are forwarded (`src/trust.ts:209`). Whether a third-party error body can echo an
  API key is НЕ ПРОВЕРЕНО.
- **Status:** not fixed.

### I3 (info): CLI and digest take operator input without validation

- `radar add` stores any string (`src/cli.ts:159`; the HTTP route validates base58), the default export file name is
  built from the first 8 characters of the wallet argument (`src/cli.ts:303`), and the daily digest writes
  `shortAddress` into Telegram HTML unescaped (`src/daily-digest.ts:294`). The CLI is run by the operator; env
  file contents are never printed (the MCP server logs only the file path). `radar history --export` HTML is escaped (tested).
- **Status:** not fixed.

### Not reviewed or not verified

- `programs/radar-transfer-hook` (Rust) was read, not compiled; no on-chain test.
- `npm audit` / dependency versions were not re-checked in this audit (no network); see the existing dependency entry above.
- Behaviour on a real cluster of the oracle memo path (D1/D2) and of the Light Protocol write path.
- The environment of the board's HTTP server process (its unit file is not in `deploy/`).
