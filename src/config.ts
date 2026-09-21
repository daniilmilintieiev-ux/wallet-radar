/**
 * Startup configuration validation.
 *
 * Fails fast with clear, actionable error messages if required environment
 * variables are missing or invalid for the requested runtime mode.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ConfigValidationOptions {
  /**
   * Expected RPC mode:
   *  - "live": requires HELIUS_API_KEY for live network requests.
   *  - "mock" | "offline": does not require external RPC keys.
   * Defaults to reading env.RADAR_RPC_MODE.
   */
  rpcMode?: "live" | "mock" | "offline";
  /**
   * Whether x402 paywall is enabled.
   * Requires X402_SECRET or RADAR_X402_SECRET, and valid recipient if provided.
   */
  paywall?: boolean;
  /**
   * Whether in-process continuous watch monitoring is active.
   * Requires HELIUS_API_KEY.
   */
  watch?: boolean;
}

export interface ConfigValidationResult {
  valid: true;
  warnings: string[];
}

/**
 * Strict base58 check for Solana addresses/mints: the base58 alphabet excludes
 * 0, O, I, l, so those characters always mark an invalid address. Shared by all
 * API surfaces (collector, http, x402, trust, mint) so validation is consistent.
 */
export function isValidBase58(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr.trim());
}

/**
 * Validate configuration environment variables against requested runtime mode.
 * Throws a descriptive ConfigError on invalid or missing required variables.
 */
export function validateConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ConfigValidationOptions = {},
): ConfigValidationResult {
  const warnings: string[] = [];

  const rpcMode =
    options.rpcMode ??
    (env.RADAR_RPC_MODE === "live"
      ? "live"
      : env.RADAR_RPC_MODE === "mock" || env.RADAR_RPC_MODE === "offline"
        ? (env.RADAR_RPC_MODE as "mock" | "offline")
        : undefined);

  // 1. Live RPC mode requires HELIUS_API_KEY
  if (rpcMode === "live") {
    const heliusKey = env.HELIUS_API_KEY?.trim();
    if (!heliusKey) {
      throw new ConfigError(
        "HELIUS_API_KEY is required when RPC mode is live (or set RADAR_RPC_MODE=mock/offline)",
      );
    }
  }

  // 2. Watch monitoring mode requires HELIUS_API_KEY
  const watchEnabled = options.watch ?? (env.RADAR_WATCH === "1");
  if (watchEnabled) {
    const heliusKey = env.HELIUS_API_KEY?.trim();
    if (!heliusKey) {
      throw new ConfigError(
        "HELIUS_API_KEY is required when RADAR_WATCH=1 is enabled for live monitoring",
      );
    }
  }

  // 3. Paywall mode requires secret and valid recipient
  const paywallEnabled =
    options.paywall ??
    (env.RADAR_PAYWALL === "1" || env.RADAR_X402_PAYWALL === "1");

  if (paywallEnabled) {
    const secret = (env.X402_SECRET || env.RADAR_X402_SECRET)?.trim();
    if (!secret) {
      throw new ConfigError(
        "x402 secret is required when paywall is enabled (set X402_SECRET or RADAR_X402_SECRET)",
      );
    }

    const recipient = env.RADAR_X402_RECIPIENT?.trim();
    if (recipient && !isValidBase58(recipient)) {
      throw new ConfigError(
        `RADAR_X402_RECIPIENT is invalid: "${recipient}" must be a valid Solana base58 address`,
      );
    }
  }

  // 4. Telegram alerts validation: TG_BOT_TOKEN requires TG_CHAT_ID
  if (env.TG_BOT_TOKEN?.trim()) {
    const chatId = env.TG_CHAT_ID?.trim();
    if (!chatId) {
      throw new ConfigError(
        "TG_CHAT_ID is required when TG_BOT_TOKEN is set for Telegram alerts",
      );
    }
  }

  // 5. RADAR_THRESHOLD_SCALE validation
  if (env.RADAR_THRESHOLD_SCALE !== undefined && env.RADAR_THRESHOLD_SCALE !== "") {
    const scale = Number(env.RADAR_THRESHOLD_SCALE);
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new ConfigError(
        `RADAR_THRESHOLD_SCALE must be a positive finite number, got "${env.RADAR_THRESHOLD_SCALE}"`,
      );
    }
  }

  // 6. PORT validation
  for (const [key, val] of [
    ["PORT", env.PORT],
    ["RADAR_X402_PORT", env.RADAR_X402_PORT],
  ] as const) {
    if (val !== undefined && val !== "") {
      const port = Number(val);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(
          `${key} must be an integer between 1 and 65535, got "${val}"`,
        );
      }
    }
  }

  // 7. Warnings: configurations that work but are likely incomplete
  if (env.RADAR_ORACLE === "1" && !env.RADAR_ORACLE_PAYER?.trim()) {
    warnings.push(
      "RADAR_ORACLE=1 is set but RADAR_ORACLE_PAYER is missing — on-chain scan commits will fail until a payer keypair is configured",
    );
  }
  if (watchEnabled && !env.TG_BOT_TOKEN?.trim() && !env.WEBHOOK_URL?.trim()) {
    warnings.push(
      "RADAR_WATCH=1 is enabled but neither TG_BOT_TOKEN nor WEBHOOK_URL is set — alerts will only be logged to the console",
    );
  }
  if (env.TG_CHAT_ID?.trim() && !env.TG_BOT_TOKEN?.trim()) {
    warnings.push(
      "TG_CHAT_ID is set but TG_BOT_TOKEN is missing — Telegram alerts will not be sent",
    );
  }
  if (paywallEnabled && !env.RADAR_X402_RECIPIENT?.trim()) {
    warnings.push(
      "Paywall is enabled but RADAR_X402_RECIPIENT is not set — x402 challenges will use the built-in fallback recipient",
    );
  }

  return { valid: true, warnings };
}
