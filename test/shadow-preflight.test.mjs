import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkRadarHealth,
  checkGateCopy,
  checkClockSkew,
  runPreflight,
  formatReport,
} from "../scripts/shadow/preflight.mjs";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("Shadow Preflight Unit Tests (Offline / Mocked, fetch injected)", () => {
  // --- GET /health ---

  test("checkRadarHealth: PASS when HTTP 200 and env.heliusConfigured=true", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true, env: { heliusConfigured: true } }, 200);
    const res = await checkRadarHealth("http://fake-radar", fetchImpl);
    assert.equal(res.pass, true);
    assert.match(res.detail, /heliusConfigured=true/);
  });

  test("checkRadarHealth: FAIL when env.heliusConfigured=false even though HTTP 200", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true, env: { heliusConfigured: false } }, 200);
    const res = await checkRadarHealth("http://fake-radar", fetchImpl);
    assert.equal(res.pass, false);
    assert.match(res.detail, /heliusConfigured=false/);
  });

  test("checkRadarHealth: FAIL when radar is unreachable (network error), no throw", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await checkRadarHealth("http://fake-radar", fetchImpl);
    assert.equal(res.pass, false);
    assert.match(res.detail, /unreachable/);
  });

  // --- POST /gate-copy ---

  test("checkGateCopy: PASS when HTTP 200, reports action and mintRiskFetched", async () => {
    const fetchImpl = async () =>
      jsonResponse(
        {
          action: "allow",
          details: { simulation: { wouldTrigger: ["TOXIC_MINT"] } },
        },
        200
      );
    const res = await checkGateCopy("http://fake-radar", fetchImpl);
    assert.equal(res.pass, true);
    assert.equal(res.status, 200);
    assert.equal(res.action, "allow");
    assert.equal(res.mintRiskFetched, true);
    assert.match(res.detail, /status=200/);
    assert.match(res.detail, /action="allow"/);
    assert.match(res.detail, /mintRiskFetched=true/);
  });

  test("checkGateCopy: FAIL on HTTP 503 (HELIUS_API_KEY not set on server), never mistaken for a verdict", async () => {
    const fetchImpl = async () => jsonResponse({ error: "HELIUS_API_KEY is not set on the server." }, 503);
    const res = await checkGateCopy("http://fake-radar", fetchImpl);
    assert.equal(res.pass, false);
    assert.equal(res.status, 503);
    assert.equal(res.action, null);
    assert.match(res.detail, /status=503/);
  });

  // --- Clock skew ---

  test("checkClockSkew: PASS when server Date header is within the allowed skew", async () => {
    const fetchImpl = async () => jsonResponse({}, 200, { date: new Date().toUTCString() });
    const res = await checkClockSkew("http://fake-clock-source", fetchImpl, 5);
    assert.equal(res.pass, true);
    assert.ok(res.skewSeconds < 5);
  });

  test("checkClockSkew: FAIL when server Date header is far off (> 5s)", async () => {
    const skewedDate = new Date(Date.now() - 60_000).toUTCString(); // 60s in the past
    const fetchImpl = async () => jsonResponse({}, 200, { date: skewedDate });
    const res = await checkClockSkew("http://fake-clock-source", fetchImpl, 5);
    assert.equal(res.pass, false);
    assert.ok(res.skewSeconds > 5);
  });

  test("checkClockSkew: FAIL (not throw) when there is no Date header at all", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
    const res = await checkClockSkew("http://fake-clock-source", fetchImpl, 5);
    assert.equal(res.pass, false);
    assert.match(res.detail, /no Date header/);
  });

  test("checkClockSkew: FAIL (not throw) on network error", async () => {
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };
    const res = await checkClockSkew("http://fake-clock-source", fetchImpl, 5);
    assert.equal(res.pass, false);
    assert.match(res.detail, /unreachable/);
  });

  // --- Whole-run integration: never throws even with zero network ---

  test("runPreflight: never throws when every network call fails, and reports FAIL everywhere it should", async () => {
    const fetchImpl = async () => {
      throw new Error("simulated total network outage");
    };
    const { results, allPass } = await runPreflight({
      fetchImpl,
      radarUrl: "http://fake-radar",
      shadowDir: undefined, // still uses real shadow dir -- filesystem check is independent of network
      env: { HELIUS_API_KEY: undefined },
    });
    assert.equal(allPass, false);
    assert.ok(results.length >= 8);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId.rpc_public.pass, false);
    assert.equal(byId.radar_health.pass, false);
    assert.equal(byId.radar_gate_copy.pass, false);
    assert.equal(byId.pool_source.pass, false);
    assert.equal(byId.clock_skew.pass, false);
    assert.equal(byId.helius_key_env.pass, false);
    // formatReport must render without throwing
    const report = formatReport(results);
    assert.match(report, /FAIL/);
  });

  test("runPreflight: helius_key_env and rpc_helius PASS when a key is present and RPC answers", async () => {
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes("helius-rpc.com")) return jsonResponse({ jsonrpc: "2.0", id: 1, result: 12345 }, 200);
      if (u.includes("mainnet-beta.solana.com")) return jsonResponse({ jsonrpc: "2.0", id: 1, result: 12345 }, 200, { date: new Date().toUTCString() });
      if (u.includes("/health")) return jsonResponse({ env: { heliusConfigured: true } }, 200);
      if (u.includes("/gate-copy")) return jsonResponse({ action: "allow" }, 200);
      if (u.includes("geckoterminal")) return jsonResponse({ data: [] }, 200);
      return jsonResponse({}, 200);
    };
    const { results } = await runPreflight({
      fetchImpl,
      radarUrl: "http://fake-radar",
      env: { HELIUS_API_KEY: "fake-key-not-a-real-secret" },
      heliusRpcUrl: "https://mainnet.helius-rpc.com/?api-key=fake-key-not-a-real-secret",
    });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId.helius_key_env.pass, true);
    assert.doesNotMatch(byId.helius_key_env.detail, /fake-key-not-a-real-secret/);
    assert.equal(byId.rpc_helius.pass, true);
  });
});
