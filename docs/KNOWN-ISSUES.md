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
  2026-10-06 18:00 UTC per `docs/PREREGISTRATION.md`, section 15zh) —
  synchronize after that date.

## DORMANT_ACTIVE observation: the default 7-day trust window may itself manufacture the "dormancy" gap

- **Naблюдение из офлайн-воспроизведения (stage 9E task 3), нужна проверка на живых данных после остановки сбора.**
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
  `docs/PREREGISTRATION.md` section 15zh), so as not to interfere with the
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
