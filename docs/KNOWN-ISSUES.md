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
