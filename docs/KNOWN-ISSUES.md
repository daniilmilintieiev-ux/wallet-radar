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
