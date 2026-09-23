import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, ConfigError } from "../src/config.js";
import { loadConfig, DEFAULT_CONFIG } from "../src/types.js";

describe("startup config validation", () => {
  it("passes default offline environment", () => {
    const res = validateConfig({});
    assert.equal(res.valid, true);
  });

  it("fails fast when live RPC mode is requested without HELIUS_API_KEY", () => {
    assert.throws(
      () => validateConfig({}, { rpcMode: "live" }),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /HELIUS_API_KEY is required when RPC mode is live/);
        return true;
      },
    );

    assert.throws(
      () => validateConfig({ RADAR_RPC_MODE: "live", HELIUS_API_KEY: "   " }),
      ConfigError,
    );
  });

  it("passes live RPC mode when HELIUS_API_KEY is provided", () => {
    const res = validateConfig({ HELIUS_API_KEY: "dummy-helius-key" }, { rpcMode: "live" });
    assert.equal(res.valid, true);

    const res2 = validateConfig({ RADAR_RPC_MODE: "live", HELIUS_API_KEY: "dummy-key" });
    assert.equal(res2.valid, true);
  });

  it("fails fast when RADAR_WATCH=1 is enabled without HELIUS_API_KEY", () => {
    assert.throws(
      () => validateConfig({ RADAR_WATCH: "1" }),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /HELIUS_API_KEY is required when RADAR_WATCH=1/);
        return true;
      },
    );

    assert.throws(
      () => validateConfig({}, { watch: true }),
      ConfigError,
    );
  });

  it("passes watch monitoring when HELIUS_API_KEY is present", () => {
    const res = validateConfig({ RADAR_WATCH: "1", HELIUS_API_KEY: "key123" });
    assert.equal(res.valid, true);
  });

  it("fails fast when paywall is enabled without a secret", () => {
    assert.throws(
      () => validateConfig({}, { paywall: true }),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /x402 secret is required when paywall is enabled/);
        return true;
      },
    );

    assert.throws(
      () => validateConfig({ RADAR_PAYWALL: "1", X402_SECRET: "" }),
      ConfigError,
    );
  });

  it("passes paywall mode when secret is provided (X402_SECRET or RADAR_X402_SECRET)", () => {
    const res1 = validateConfig({ X402_SECRET: "secret1" }, { paywall: true });
    assert.equal(res1.valid, true);

    const res2 = validateConfig({ RADAR_X402_PAYWALL: "1", RADAR_X402_SECRET: "secret2" });
    assert.equal(res2.valid, true);
  });

  it("fails fast when paywall recipient is not a valid Solana base58 address", () => {
    assert.throws(
      () =>
        validateConfig({
          X402_SECRET: "secret",
          RADAR_X402_RECIPIENT: "not-a-valid-solana-address",
        }, { paywall: true }),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /RADAR_X402_RECIPIENT is invalid/);
        return true;
      },
    );
  });

  it("passes paywall with valid Solana base58 recipient", () => {
    const res = validateConfig({
      X402_SECRET: "secret",
      RADAR_X402_RECIPIENT: "11111111111111111111111111111111",
    }, { paywall: true });
    assert.equal(res.valid, true);
  });

  it("fails fast when TG_BOT_TOKEN is set without TG_CHAT_ID", () => {
    assert.throws(
      () => validateConfig({ TG_BOT_TOKEN: "bot123:token" }),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /TG_CHAT_ID is required when TG_BOT_TOKEN is set/);
        return true;
      },
    );

    const ok = validateConfig({ TG_BOT_TOKEN: "bot123:token", TG_CHAT_ID: "123456" });
    assert.equal(ok.valid, true);
  });

  it("validates RADAR_THRESHOLD_SCALE if provided", () => {
    assert.throws(
      () => validateConfig({ RADAR_THRESHOLD_SCALE: "invalid" }),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /RADAR_THRESHOLD_SCALE must be a positive finite number/);
        return true;
      },
    );

    assert.throws(
      () => validateConfig({ RADAR_THRESHOLD_SCALE: "-0.5" }),
      ConfigError,
    );

    assert.throws(
      () => validateConfig({ RADAR_THRESHOLD_SCALE: "0" }),
      ConfigError,
    );

    const ok = validateConfig({ RADAR_THRESHOLD_SCALE: "1.5" });
    assert.equal(ok.valid, true);
  });

  it("validates PORT and RADAR_X402_PORT integers", () => {
    assert.throws(
      () => validateConfig({ PORT: "abc" }),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /PORT must be an integer between 1 and 65535/);
        return true;
      },
    );

    assert.throws(
      () => validateConfig({ PORT: "70000" }),
      ConfigError,
    );

    assert.throws(
      () => validateConfig({ RADAR_X402_PORT: "0" }),
      ConfigError,
    );

    const ok = validateConfig({ PORT: "7690", RADAR_X402_PORT: "4020" });
    assert.equal(ok.valid, true);
  });
});

describe("RADAR_THRESHOLD_SCALE direction (audit 4.5)", () => {
  const prevScale = process.env.RADAR_THRESHOLD_SCALE;
  afterEach(() => {
    if (prevScale === undefined) delete process.env.RADAR_THRESHOLD_SCALE;
    else process.env.RADAR_THRESHOLD_SCALE = prevScale;
  });

  it("scale=0.5 makes every threshold STRICTER, including dormantDays", () => {
    process.env.RADAR_THRESHOLD_SCALE = "0.5";
    const c = loadConfig();
    // dormantDays must DOUBLE (wallet must be dormant longer) — was 7*0.5=4.
    assert.equal(c.dormantDays, DEFAULT_CONFIG.dormantDays * 2);
    assert.ok(c.dormantDays > DEFAULT_CONFIG.dormantDays);
    // The other thresholds scale in the strict direction too.
    assert.equal(c.burstThreshold, DEFAULT_CONFIG.burstThreshold * 2);
    assert.equal(c.burstWindowMin, DEFAULT_CONFIG.burstWindowMin * 2);
    assert.ok(c.largeSwapMultiplier > DEFAULT_CONFIG.largeSwapMultiplier);
  });

  it("scale=2.0 makes every threshold LOOSER, including dormantDays", () => {
    process.env.RADAR_THRESHOLD_SCALE = "2.0";
    const c = loadConfig();
    assert.ok(c.dormantDays < DEFAULT_CONFIG.dormantDays);
    assert.equal(c.dormantDays, Math.round(DEFAULT_CONFIG.dormantDays / 2));
    assert.ok(c.burstThreshold < DEFAULT_CONFIG.burstThreshold);
  });

  it("scale=1.0 returns the defaults unchanged", () => {
    process.env.RADAR_THRESHOLD_SCALE = "1.0";
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  });
});
