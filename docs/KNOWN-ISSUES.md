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
- **Status:** not fixed this stage (`src/` out of scope for stage 9D). The
  A2A card's `version` field should either track `package.json`'s version or
  be documented as an independent protocol-card version number, whichever is
  intended.

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
- **Status:** not fixed this stage. Synchronizing the count (updating
  `src/http-server.ts`, `src/mcp.ts`, and `test/regime.test.ts` to say "10"
  and re-verifying README.md/docs/index.html can then also say "10"
  consistently) requires editing `src/` and `test/`, both out of scope for
  stage 9D (`src/` per the branch's explicit restriction; the shadow
  collector's live run is preregistered and locked until it stops on
  2026-10-06 18:00 UTC per `docs/PREREGISTRATION.md`, section 15g) —
  synchronize after that date.

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
- **Status:** not fixed this stage (`src/` out of scope). Needs confirmation
  against real, live wallet data — safe to attempt only after the shadow
  collector's data collection stops (2026-10-06 18:00 UTC,
  `docs/PREREGISTRATION.md` section 15g), so as not to interfere with the
  live run.

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
- **Status:** not fixed this stage (`src/` out of scope) — behavior is
  recorded as a documented limitation, not changed.

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
- **Status:** finding, fix planned after 2026-10-06 (`src/`
  is out of scope for this stage).

## `fetchMintMetadata`/`getTokenLargestAccounts` failure silently skips TOXIC_MINT for that mint (fails open)

- Source: report 11A, item 1(a).
- `src/mint.ts:496-524` (`fetchSwapMintRisk`): a per-mint fetch failure is
  caught (`:516-518`) and that mint is simply omitted from the returned
  `MintRiskMap` — not recorded as `null`, just absent.
- `src/analyzer.ts:780`: `const meta = mintRisk[m]; if (!meta) continue;
  // Fetch failed or no metadata: skip rule for this mint` — a mint whose
  metadata fetch failed receives no TOXIC_MINT evaluation at all,
  regardless of its actual risk.
- **Status:** finding, fix planned after 2026-10-06.

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
- **Status:** finding, fix planned after 2026-10-06.

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
- **Status:** finding, fix planned after 2026-10-06.

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
- **Status:** finding, fix planned after 2026-10-06.

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
- **Status:** finding, fix planned after 2026-10-06.

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
- **Status:** finding, fix planned after 2026-10-06 (`test/`
  is out of scope for this stage).

## `npm audit`: 12 known vulnerabilities in the dependency tree (9 moderate, 3 high)

- Source: report 11B.
- Reported packages: `bigint-buffer`, `@solana/buffer-layout-utils`,
  `@solana/spl-token` — all reachable through `@solana/spl-token@0.4.15`'s
  own dependency tree, not a direct top-level choice.
- Impact on this project's actual usage was not assessed this stage (no
  exploitability analysis of which code paths touch the vulnerable
  functions).
- **Status:** finding, fix planned after 2026-10-06.

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
- **Status:** finding, fix planned after 2026-10-06.

## Sole x402 payment: confirms pipeline, not revenue; typo in payer address in daily-digest.ts

- Source: report 11E.
- (a) Sole payment in the recipient history of `F6wWPy4c3fXTJDqU19Nax8FhQumeMcsSVpD2YwxLpBNR`: 0.005 USDC, 2026-09-18, payer `3fNNY9iEvzmfqt4gTdEmvRKNa9G3mKkHq523uS5t5eYh` (labeled "x402 Payer" in `src/daily-digest.ts:24` — line number verified via `git grep -n "x402 Payer" -- src/daily-digest.ts`, matches). The payment confirms that the payment pipeline (proof → verify → settle) executes on a real transaction; this is **not** external revenue — sole known payment across all time, from the operator's own demo wallet (per project notes).
- (b) Upgrade authority of the Transfer Hook program on devnet (`4bDZPMF9j3Jm6rUVofT3be6JH67C1tRFBff9MnrsE2EY`) — regular key: `owner` = System Program, `space` = 0, no indication of multisig (Squads, etc.). Not re-verified in this session (network access was not performed in this stage) — source: report 11E.
- (c) Typo in address: `src/daily-digest.ts:24` contains `"3fNNuJcvV2bYmrh7XjTq7u22C7V6F2qXq8pE4jM5eYh"` — 43 characters. Directly verified in this session (base58 decoding): this string decodes to **31 bytes**, not 32 as required for a valid Solana address; the actual payer address (44 characters, decodes to 32 bytes) is `3fNNY9iEvzmfqt4gTdEmvRKNa9G3mKkHq523uS5t5eYh` (see item (a) above). The strings differ, though visually similar (shared prefix `3fNN`, shared suffix `5eYh`). The same invalid address in the `radar-watch` watchlist produces a Helius 400 error every 5 minutes (per report 11E, not reproduced in this session — network was not used).
- **Status:** finding, fix planned after 2026-10-06 (`src/` is out of scope for this stage).

## Dashboard redesigned in branch dashboard, not deployed; reads only existing fields; recorded replay is a historical window

- Source: stage 16A/16C dashboard redesign.
- Branch `dashboard` completely overhauls the HTML rendered by `GET /dashboard` (`src/dashboard.ts`, `src/dashboard-radar.ts`, `src/dashboard-fonts.ts`) into a high-contrast radar visualization using embedded Big Shoulders Display and JetBrains Mono fonts.
- The branch is isolated and not merged into `release` or `main` (held until after 2026-10-06 preregistration freeze concludes). Not deployed to production or Cloudflare.
- The dashboard strictly reads existing fields from the data model (no speculative or synthetic fields):
  - In live records without multi-layered consensus or liquidity data, missing fields are omitted or indicated gracefully without synthetic mocks. Base/Agent/Defense values are never calculated by the dashboard from risk scores.
  - Recorded replay (`docs/dashboard/replay-8XeK5m.json`) is explicitly presented as a historical window (`recordedAtUtc: 2026-10-01T20:29:39Z`), annotated with "historical replay, not a confirmed incident", and not represented as live telemetry.
  - Independent test status (`docs/dashboard/test-status.json`) displays `result: null` during collection without previewing or fabricating score numbers.
- **Status:** implemented in branch `dashboard`, awaiting deployment post-freeze.
