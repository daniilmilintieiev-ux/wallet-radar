# Deploy Checklist (public-facing server)

Stage 15B, item B0c. Documentation only — no code in this repository was
changed by this file. Every claim below was checked by reading
`src/http-server.ts` on branch `fixes-b` (line numbers as of this commit;
they will drift as the file changes) or by running the exact command shown.
Default behavior (nothing set) is unchanged by this document.

> **Updated in branch `secaudit2` (not deployed).** That branch changes two
> defaults, so a redeploy of it is **not** behavior-neutral:
> (1) with no `RADAR_API_TOKEN`, the four mutating routes now answer **403**
> instead of being open (section 2a); (2) `POST /scan` no longer performs
> operator-signed on-chain writes for callers without a valid token (section
> 2a). Line numbers in rows that this update did not touch were **not**
> re-verified and may have drifted.

## 1. Environment variables for a public-facing deployment

| Variable | Effect | Code reference |
|---|---|---|
| `RADAR_API_TOKEN` | Shared bearer token (`Authorization: Bearer <token>` or `x-api-token`). With nothing else set, this alone gates the four "mutating" routes (see §2) and is what unlocks on-chain writes from `POST /scan` (§2a). **After secaudit2:** without it the four mutating routes answer 403 (they used to be open); heavy and protected-read routes are still open without it, as before. | `src/http-server.ts:116-150` (`authorizeMutating`, `hasValidApiToken`) |
| `RADAR_ALLOW_UNAUTH_MUTATIONS=1` | Explicit opt-in (secaudit2): serve `POST /watch`, `/unwatch`, `/poll`, `/defense/:wallet/clear` with **no** token set. Restores the old open behavior; only use on a closed network. Has no effect when `RADAR_API_TOKEN` is set. | `src/http-server.ts:980-981`, `:991-996` |
| `RADAR_ALLOW_ANON_ONCHAIN_WRITES=1` | Explicit opt-in (secaudit2): let callers **without** a valid token trigger the operator-signed on-chain writes of `POST /scan` (hook-bridge PDA update, and the oracle memo when `RADAR_ORACLE=1`). Default: those writes happen only for requests carrying a valid token. | `src/http-server.ts:1001-1003`, `:229-230`, `:257` |
| `RADAR_REQUIRE_AUTH=1` or `RADAR_AUTH_HEAVY=1` | Either one sets `authHeavy = true`, which additionally gates the five "heavy" POST routes (§2). Both env vars are read identically — there is no behavioral difference between them. | `src/http-server.ts:899-901` |
| `RADAR_PROTECT_READS=1` | Gates the five "protected read" GET routes (§2). | `src/http-server.ts:902-904` |
| `RADAR_TRUST_PROXY=1` | Makes the IP-based rate limiter trust the `CF-Connecting-IP` header (falling back to the first `X-Forwarded-For` entry) instead of the raw socket address. **Only set this when a real reverse proxy (Cloudflare, Nginx, Caddy) sits in front and strips/overwrites these headers from direct client connections** — otherwise any caller can spoof `CF-Connecting-IP` to defeat per-IP rate limiting. | `src/http-server.ts:1182-1203` |
| `RADAR_LIVE_RATE_LIMIT_PER_MIN` | Per-IP-per-minute cap on the Helius-cost-incurring routes listed in §3. Defaults to 30 and is independent of `RADAR_RATE_LIMIT_PER_MIN` (fixed in B0b — see below). | `src/http-server.ts:1298, 1307-1308` |
| `RADAR_RATE_LIMIT_PER_MIN` | General per-IP-per-minute cap applied to every route except `/health` and `OPTIONS`. Defaults to 120. Does **not** bound `RADAR_LIVE_RATE_LIMIT_PER_MIN` (B0b removed that coupling) — raising this does not raise the live limit, and vice versa. | `src/http-server.ts:1303, 1331-1343` |

## 2. What `authorizeMutating` actually gates

`authorizeMutating` (`src/http-server.ts:112-140`) only ever inspects three
fixed route sets, each independently toggled:

- **Mutating** (gated by `RADAR_API_TOKEN` alone, no other flag needed;
  with no token set they answer 403 unless
  `RADAR_ALLOW_UNAUTH_MUTATIONS=1`, see §2a):
  `POST /watch`, `POST /unwatch`, `POST /poll`, `POST /defense/:wallet/clear`.
- **Heavy** (needs `RADAR_API_TOKEN` **and** `RADAR_AUTH_HEAVY=1` /
  `RADAR_REQUIRE_AUTH=1`): `POST /batch`, `POST /scan`, `POST /trust`,
  `POST /simulate`, `POST /gate-copy`.
- **Protected read** (needs `RADAR_API_TOKEN` **and** `RADAR_PROTECT_READS=1`):
  `GET /watch`, `GET /alerts`, `GET /defense`, `GET /defense/:wallet`,
  `GET /poll`.

Every other route is **never** gated by any combination of these variables,
regardless of configuration. Verified by reading `authorizeMutating`'s own
condition (`src/http-server.ts:121-133`): a request is only subject to the
401 check at all if it matches one of the three sets above.

### Routes named in this task that stay open even with full auth enabled

With `RADAR_API_TOKEN`, `RADAR_AUTH_HEAVY=1` (or `RADAR_REQUIRE_AUTH=1`), and
`RADAR_PROTECT_READS=1` all set, these remain reachable **without** any
token, because none of them appear in any of the three sets in §2:

- `GET /dashboard` (`src/http-server.ts:910`) — reads the local store/ZK
  ledger. No Helius cost, but exposes wallet scan history to anyone.
- `GET /economics` (`src/http-server.ts:971-974`) — reads the local store.
  No Helius cost, but exposes revenue/cost/margin figures to anyone.
- `GET /trust-proof` (`src/http-server.ts:976-990`) **and** `POST
  /trust-proof` (reachable via the generic `TOOL_BY_PATH` dispatcher at
  `src/http-server.ts:1134-1141`, since `/trust-proof` is a key in that
  table — `src/http-server.ts:808`) — both do a real on-chain/oracle lookup
  per call and are not in `LIVE_HELIUS_PATHS` (§3), so they also bypass the
  live-route rate limiter, not just the auth gate.
- `GET /.well-known/agent.json` (`src/http-server.ts:1040`) — static A2A
  agent card, no cost either way.
- `POST /a2a` (`src/http-server.ts:1127`) — runs the same trust-gate check
  as `/trust` internally, but is **not** in `LIVE_HELIUS_PATHS` either
  (§3), so it incurs a real Helius call per request while being subject
  only to the *general* rate limiter (`RADAR_RATE_LIMIT_PER_MIN`, default
  120/min), not the lower, Helius-cost-aware
  `RADAR_LIVE_RATE_LIMIT_PER_MIN` (default 30/min). This is a real gap:
  an anonymous caller can drive up to 120 Helius-charged requests/min
  through `/a2a` even when every auth variable above is set.
- `POST /selftest` (`src/http-server.ts:574-582`, dispatched via
  `TOOL_BY_PATH["/selftest"]` at `src/http-server.ts:816`) — this is
  intentional, not a gap: `toolSelftest` is a fully offline smoke test over
  a hardcoded fixture (no network call, no cost), designed to work without
  any credentials. `scripts/canary-agent.ts` depends on this: it polls
  `POST {scanUrl}/selftest` every cycle, and `POST {x402Url}/selftest`
  every 5th cycle, with **no** `Authorization` header
  (`scripts/canary-agent.ts:207-214, 239-249`). **Enabling
  `RADAR_AUTH_HEAVY`/`RADAR_REQUIRE_AUTH`/`RADAR_PROTECT_READS` does not
  break the canary agent**, because `/selftest` was never in any of the
  three gated sets in the first place.

## 2a. Behavior added in branch `secaudit2` (not deployed)

| Situation | Before | After |
|---|---|---|
| No `RADAR_API_TOKEN`, `POST /watch` / `/unwatch` / `/poll` / `/defense/:wallet/clear` | 200 for any caller | **403** (`Forbidden: mutating endpoints are disabled because RADAR_API_TOKEN is not set...`). `GET /watch`, `/alerts`, `/defense...` unchanged. |
| Token set, wrong/missing token on those routes | 401 | 401 (unchanged) |
| `POST /scan` without a valid token, hook bridge or `RADAR_ORACLE=1` configured | verdict returned **and** on-chain write made with the operator key | verdict returned, **no** on-chain write (response has no `hookBridge` / `oracle` fields) |
| `POST /scan` with a valid token | as above | unchanged (write is made) |
| `POST /scan` for a wallet that is not on the watch list | wallet silently joined the poll list | stays out of the poll list; only `POST /watch` / `radar add` enrol it (`wallets.watched`; the migration marks all existing rows watched=1) |

**Who calls the gated routes on the board** (found by reading the code in this repository; the HTTP server's own
unit file is **not** in `deploy/`, so its environment is НЕ ПРОВЕРЕНО):

- `deploy/radar-watch.service` runs `node dist/src/cli.js watch`. That is the watch loop reading the SQLite store
  directly; it does **not** call the HTTP routes above, so it is unaffected by the 403 change. It polls only
  `watched=1` rows after the M1 change; the migration marks every existing row as watched on first open, so the
  current list is preserved.
- `deploy/canary-agent.service` runs `dist/scripts/canary-agent.js`, which calls only `POST {scanUrl}/selftest` and
  `POST {x402Url}/selftest` (`scripts/canary-agent.ts:207-214, 239-249`): `/selftest` is in none of the gated sets,
  so it is unaffected.
- `deploy/x402server.service` runs `dist/src/x402server.js`. `grep` finds no `authorizeMutating`, `/watch`, `/poll`
  or `/clear` handling in `src/x402server.ts`; its own paid `/scan` flow is unchanged (payment verified before the
  hook-bridge write).
- No script under `scripts/`, `deploy/` or `bin/` calls `/watch`, `/unwatch`, `/poll` or `/defense/:wallet/clear`
  (`grep -rn` over those directories). Any remaining caller is outside this repository (manual `curl`, an agent, an
  external integration): **before deploying, check the HTTP server's environment for `RADAR_API_TOKEN`; if it is
  not set and something calls these routes, they will start returning 403.**
- The README/KNOWN-ISSUES statements that "without `RADAR_API_TOKEN` every route is authorized" are stale for the
  mutating routes after this change (see `docs/KNOWN-ISSUES.md`).

## 3. `RADAR_LIVE_RATE_LIMIT_PER_MIN` coverage

`LIVE_HELIUS_PATHS` (`src/http-server.ts:823-834`) is the exact and only
set of paths subject to the live rate limiter:

```
/scan, /radar_scan, /trust, /radar_trust, /simulate, /radar_simulate,
/gate-copy, /radar_gate_copy, /batch, /radar_batch
```

`/trust-proof` and `/a2a` are **not** in this set despite doing real
network work per request (see §2) — `RADAR_LIVE_RATE_LIMIT_PER_MIN` gives
them no protection; only the general `RADAR_RATE_LIMIT_PER_MIN` applies.

As of B0b (this stage), `RADAR_LIVE_RATE_LIMIT_PER_MIN` and
`RADAR_RATE_LIMIT_PER_MIN` are fully independent: raising one has no effect
on the other's default. Before B0b, an unset `liveRateLimitPerMin` option
combined with a *set* `rateLimitPerMin` option silently raised the live
limit to `max(30, rateLimitPerMin)` — this only affected callers of the
`createServer()` function directly (e.g. embedding this server in another
process); it was never reachable through environment variables alone,
since `RADAR_LIVE_RATE_LIMIT_PER_MIN` and `RADAR_RATE_LIMIT_PER_MIN` were
always read independently of each other.

## 4. Verifying the configuration (no payments made)

Run against a deployed instance with `RADAR_API_TOKEN`, `RADAR_AUTH_HEAVY=1`,
and `RADAR_PROTECT_READS=1` set. None of these commands send a payment or
mutate state.

```bash
# 1. Heavy POST route rejects without a token (expect 401)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/scan" \
  -H "Content-Type: application/json" -d '{"wallet":"11111111111111111111111111111111"}'

# 2. Same route accepted with the token (expect not-401; 503 if HELIUS_API_KEY
#    is unset, which is a separate, expected failure)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/scan" \
  -H "Authorization: Bearer $RADAR_API_TOKEN" \
  -H "Content-Type: application/json" -d '{"wallet":"11111111111111111111111111111111"}'

# 3. Protected read rejects without a token (expect 401)
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/watch"

# 4. Confirm the routes in §2 that this configuration does NOT gate
#    (expect 200, not 401, on all four -- this is documenting the current
#    gap, not a desired outcome)
for p in /dashboard /economics /.well-known/agent.json; do
  echo "$p: $(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")"
done
curl -s -o /dev/null -w "/a2a: %{http_code}\n" -X POST "$BASE/a2a" \
  -H "Content-Type: application/json" -d '{"wallet":"11111111111111111111111111111111"}'

# 5. If behind Cloudflare with RADAR_TRUST_PROXY=1, confirm the rate limiter
#    is keying on CF-Connecting-IP, not a shared proxy IP: send requests
#    from two different source IPs (or vary the header through your proxy,
#    never directly from an untrusted client) and confirm they are limited
#    independently. There is no single curl command for this -- it requires
#    two distinct real client IPs through the actual proxy path.

# 6. POST /selftest remains free and unauthenticated by design (expect 200)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/selftest"

# 7. (secaudit2) Mutating route without a token (expect 403 if RADAR_API_TOKEN is NOT set on the server,
#    401 if it is set but the request has no token; 200 only with a valid token or RADAR_ALLOW_UNAUTH_MUTATIONS=1).
#    /unwatch of an address that is not watched is harmless.
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/unwatch" \
  -H "Content-Type: application/json" -d '{"wallet":"11111111111111111111111111111111"}'

# 8. (secaudit2) The same route with the token (expect 200)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/unwatch" \
  -H "Authorization: Bearer $RADAR_API_TOKEN" \
  -H "Content-Type: application/json" -d '{"wallet":"11111111111111111111111111111111"}'
```

## 5. Rollback order

If a configuration change causes an outage or locks out a legitimate
integration (e.g. the canary agent or an MCP client), unset in this order —
each step independently reduces what is gated, without needing to touch
the others:

1. `RADAR_PROTECT_READS` — restores anonymous access to `GET /watch`,
   `/alerts`, `/defense`, `/defense/:wallet`, `/poll`.
2. `RADAR_AUTH_HEAVY` / `RADAR_REQUIRE_AUTH` — restores anonymous access to
   `POST /batch`, `/scan`, `/trust`, `/simulate`, `/gate-copy`.
3. `RADAR_API_TOKEN` — last. **After secaudit2**, removing it does **not** reopen
   the four mutating routes: they answer 403 (and `POST /scan` stops doing
   on-chain writes) unless `RADAR_ALLOW_UNAUTH_MUTATIONS=1` /
   `RADAR_ALLOW_ANON_ONCHAIN_WRITES=1` are set. On a build without secaudit2,
   removing it makes `authorizeMutating` return `true` unconditionally and
   reopens the four mutating routes regardless of `RADAR_AUTH_HEAVY` /
   `RADAR_PROTECT_READS`.
4. `RADAR_TRUST_PROXY` — only unset this if the reverse proxy itself is
   being removed or reconfigured; leaving it set with no real proxy in
   front re-opens the IP-spoofing gap described in §1.
5. `RADAR_LIVE_RATE_LIMIT_PER_MIN` / `RADAR_RATE_LIMIT_PER_MIN` — unsetting
   these only returns their respective limits to the defaults (30 and 120);
   it does not affect auth at all (confirmed independent, §3).

Restart the server process after any of the above — these are all read
once at `createServer()`/process start (`src/http-server.ts:1302-1308,
898-904`), not re-read per request.
