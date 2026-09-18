#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface CanaryConfig {
  intervalSec: number;
  scanUrl: string;
  x402Url: string;
  wallet: string;
  logFile: string;
  backoffMs?: number;
  dryRun?: boolean;
  once?: boolean;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface CanaryStepResult {
  ok: boolean;
  iter: number;
  riskScore?: number;
  verdict?: string;
  x402Status?: string;
  error?: string;
  backedOff?: boolean;
}

export function loadEnvFile(envPath?: string): void {
  const candidates = [
    envPath,
    process.env.RADAR_ENV,
    path.resolve(process.cwd(), "radar.env"),
    path.resolve(process.cwd(), ".env"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const fileContent = fs.readFileSync(candidate, "utf8");
        for (const line of fileContent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            if (!(key in process.env)) {
              process.env[key] = val;
            }
          }
        }
      } catch {}
      break;
    }
  }
}

export function computeVerdict(score: number): string {
  if (score <= 0) return "SAFE";
  if (score <= 30) return "LOW RISK";
  if (score <= 60) return "SUSPICIOUS";
  return "HIGH RISK";
}

export function appendLog(logFile: string, message: string): void {
  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(logFile, message + "\n", "utf8");
  } catch (err) {
    console.error(`Failed to write to log file ${logFile}:`, err);
  }
  console.log(message);
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): CanaryConfig {
  loadEnvFile();

  const intervalSec = parseInt(env.CANARY_INTERVAL_SEC || "60", 10);
  const scanUrl = (env.CANARY_SCAN_URL || "http://127.0.0.1:7690").replace(/\/+$/, "");
  const x402Url = (env.CANARY_X402_URL || "http://127.0.0.1:4020").replace(/\/+$/, "");
  const wallet =
    env.CANARY_WALLET ||
    env.RADAR_CANARY_WALLET ||
    env.RADAR_X402_RECIPIENT ||
    "11111111111111111111111111111111";
  const logFile = env.CANARY_LOG || "/tmp/canary.log";
  const backoffMs = env.CANARY_BACKOFF_MS
    ? parseInt(env.CANARY_BACKOFF_MS, 10)
    : 5 * 60 * 1000;

  return {
    intervalSec: isNaN(intervalSec) || intervalSec <= 0 ? 60 : intervalSec,
    scanUrl,
    x402Url,
    wallet,
    logFile,
    backoffMs: isNaN(backoffMs) || backoffMs <= 0 ? 5 * 60 * 1000 : backoffMs,
  };
}

export class CanaryAgent {
  public config: CanaryConfig;
  public fetchFn: typeof fetch;
  public iteration = 0;
  public consecutiveFailures = 0;
  public backoffUntil = 0;
  public timer: NodeJS.Timeout | null = null;
  public running = false;
  public apiKeyWarningLogged = false;

  constructor(config?: Partial<CanaryConfig>) {
    const base = loadEnvConfig();
    this.config = {
      ...base,
      ...config,
    };
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
  }

  public now(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  public isBackingOff(now = this.now()): boolean {
    return now < this.backoffUntil;
  }

  public async step(dryRunOverride?: boolean): Promise<CanaryStepResult> {
    const nowMs = this.now();
    if (this.isBackingOff(nowMs)) {
      const remainingSec = Math.ceil((this.backoffUntil - nowMs) / 1000);
      return {
        ok: false,
        iter: this.iteration,
        backedOff: true,
        error: `In backoff (${remainingSec}s remaining)`,
      };
    }

    this.iteration++;
    const iter = this.iteration;
    const nowIso = new Date(nowMs).toISOString();

    // 1. Check API key status / log warning if missing
    if (!process.env.HELIUS_API_KEY && !this.apiKeyWarningLogged) {
      this.apiKeyWarningLogged = true;
      appendLog(this.config.logFile, `[${nowIso}] no API key, using selftest only`);
    }

    // 2. Call GET {SCAN_URL}/health — if non-200, log and skip
    let healthOk = false;
    let healthError = "";
    try {
      const healthRes = await this.fetchFn(`${this.config.scanUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (healthRes.ok) {
        healthOk = true;
        const data: any = await healthRes.json().catch(() => ({}));
        if (
          data &&
          data.env &&
          data.env.heliusConfigured === false &&
          !this.apiKeyWarningLogged
        ) {
          this.apiKeyWarningLogged = true;
          appendLog(this.config.logFile, `[${nowIso}] no API key, using selftest only`);
        }
      } else {
        healthError = `status ${healthRes.status}`;
      }
    } catch (err: any) {
      healthError = err?.message || "connection failed";
    }

    if (!healthOk) {
      this.consecutiveFailures++;
      const failMsg = `health check failed (${this.config.scanUrl}/health: ${healthError})`;
      appendLog(this.config.logFile, `[${nowIso}] iter=${iter} ${failMsg}`);

      if (this.consecutiveFailures >= 3) {
        appendLog(
          this.config.logFile,
          `[${nowIso}] ERROR: 3 consecutive failures (${failMsg}), backing off for 5 minutes`,
        );
        this.backoffUntil = nowMs + (this.config.backoffMs ?? 5 * 60 * 1000);
      }
      return { ok: false, iter, error: failMsg };
    }

    // 3. Call POST {SCAN_URL}/selftest — free scan (no x402 needed)
    let riskScore = 0;
    let verdict = "SAFE";
    try {
      const scanRes = await this.fetchFn(`${this.config.scanUrl}/selftest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10000),
      });
      if (!scanRes.ok) {
        throw new Error(`selftest returned status ${scanRes.status}`);
      }
      const scanData: any = await scanRes.json();
      riskScore = typeof scanData?.riskScore === "number" ? scanData.riskScore : 0;
      const rawVerdict =
        typeof scanData?.verdict === "string" ? scanData.verdict : computeVerdict(riskScore);
      verdict = rawVerdict.toUpperCase();
    } catch (err: any) {
      this.consecutiveFailures++;
      const failMsg = `scan selftest failed: ${err?.message || "unknown error"}`;
      appendLog(this.config.logFile, `[${nowIso}] iter=${iter} ${failMsg}`);

      if (this.consecutiveFailures >= 3) {
        appendLog(
          this.config.logFile,
          `[${nowIso}] ERROR: 3 consecutive failures (${failMsg}), backing off for 5 minutes`,
        );
        this.backoffUntil = nowMs + (this.config.backoffMs ?? 5 * 60 * 1000);
      }
      return { ok: false, iter, error: failMsg };
    }

    // Scan succeeded, reset consecutive failures
    this.consecutiveFailures = 0;

    // 4. Every 5th iteration: call POST {X402_URL}/selftest with mock x402 payment header (dry-run)
    let x402Status = "skip";
    const shouldX402 = iter % 5 === 0 || Boolean(dryRunOverride);

    if (shouldX402) {
      appendLog(
        this.config.logFile,
        `[${nowIso}] x402 payment intent (dry-run): payer=${this.config.wallet} endpoint=${this.config.x402Url}/selftest`,
      );
      try {
        const x402Res = await this.fetchFn(`${this.config.x402Url}/selftest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Payment-Payer": this.config.wallet,
            "X-Payment-Signature": `dryrun_${Date.now()}_iter_${iter}`,
            "X-Payment-Dry-Run": "true",
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10000),
        });
        if (x402Res.ok) {
          x402Status = "dry-run";
        } else {
          x402Status = `status:${x402Res.status}`;
        }
      } catch (err: any) {
        x402Status = `error:${err?.message || "failed"}`;
      }
    }

    // 5. Log iteration in required format: [2026-09-15T12:00:00Z] iter=42 scan=risk:12/100:SAFE x402=skip
    const logLine = `[${nowIso}] iter=${iter} scan=risk:${riskScore}/100:${verdict} x402=${x402Status}`;
    appendLog(this.config.logFile, logLine);

    return {
      ok: true,
      iter,
      riskScore,
      verdict,
      x402Status,
    };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    // Immediate first iteration
    this.step().catch((err) => {
      appendLog(
        this.config.logFile,
        `[${new Date().toISOString()}] Unhandled error in canary step: ${err?.message}`,
      );
    });

    // Scheduled interval loop
    this.timer = setInterval(() => {
      if (!this.running) return;
      this.step().catch((err) => {
        appendLog(
          this.config.logFile,
          `[${new Date().toISOString()}] Unhandled error in canary step: ${err?.message}`,
        );
      });
    }, this.config.intervalSec * 1000);
  }

  public stop(signal?: string): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const nowIso = new Date().toISOString();
    appendLog(this.config.logFile, `[${nowIso}] canary stopped`);
  }
}

// Windows / Node 24: undici (the engine behind global fetch) keeps its keep-alive
// sockets open, and a hard process.exit() right after a successful scan double-closes
// one of them, tripping a libuv assertion (UV_HANDLE_CLOSING) that aborts the process
// with exit code 0xC0000142 (3221226505). A short drain lets libuv finish closing the
// sockets before the hard exit. Measured on the failing setup: 0-10ms always crashed,
// 30ms was flaky, >=50ms was clean — 150ms leaves comfortable margin for loaded hosts.
const EXIT_DRAIN_MS = 150;
async function drainBeforeExit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, EXIT_DRAIN_MS));
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const config = loadEnvConfig();
  const dryRun = args.includes("--dry-run");
  const once = args.includes("--once") || dryRun;

  const agent = new CanaryAgent(config);
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    agent.stop(signal);
    void drainBeforeExit().then(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (once) {
    const res = await agent.step(dryRun);
    await drainBeforeExit();
    process.exit(res.ok ? 0 : 1);
  }

  agent.start();
}

const isDirectRun = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith("canary-agent.js") ||
      process.argv[1].endsWith("canary-agent.ts")),
);

if (isDirectRun) {
  runCli().catch((err) => {
    console.error("Canary agent failed:", err);
    process.exit(1);
  });
}
