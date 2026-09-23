import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CanaryAgent } from "../scripts/canary-agent.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(rootDir, "dist/scripts/canary-agent.js");

function createMockServer(options?: {
  healthStatus?: number;
  selftestStatus?: number;
  riskScore?: number;
  verdict?: string;
  heliusConfigured?: boolean;
}): Promise<{
  server: http.Server;
  url: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
    const healthStatus = options?.healthStatus ?? 200;
    const selftestStatus = options?.selftestStatus ?? 200;
    const riskScore = options?.riskScore ?? 12;
    const verdict = options?.verdict ?? "SAFE";
    const heliusConfigured = options?.heliusConfigured ?? true;

    const server = http.createServer((req, res) => {
      requests.push({
        method: req.method || "GET",
        url: req.url || "/",
        headers: req.headers,
      });

      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const pathname = parsedUrl.pathname;

      if (pathname === "/health") {
        if (healthStatus !== 200) {
          res.writeHead(healthStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "service unavailable" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            status: "ok",
            env: { heliusConfigured },
          }),
        );
        return;
      }

      if (pathname === "/selftest") {
        if (selftestStatus !== 200) {
          res.writeHead(selftestStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "selftest failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            riskScore,
            verdict,
            anomalies: [],
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      const close = () =>
        new Promise<void>((resClose) => {
          server.close(() => resClose());
        });
      resolve({ server, url, close, requests });
    });
  });
}

function makeTmpLog(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-"));
  return path.join(tmpDir, "canary.log");
}

describe("Canary Agent Integration Tests", () => {
  it("Run canary with --once flag, assert: log file has 1 entry with timestamp and riskScore", async () => {
    const mock = await createMockServer({ riskScore: 15, verdict: "SAFE" });
    const logFile = makeTmpLog();

    try {
      const spawnEnv = {
        ...process.env,
        // Pin a dummy key so the "no API key, using selftest only" warning line
        // (canary-agent.ts) is deterministic: the test asserts exactly 1 log line.
        // The missing-key warning itself is covered by the dedicated test below.
        HELIUS_API_KEY: "test-canary-key",
        CANARY_SCAN_URL: mock.url,
        CANARY_X402_URL: mock.url,
        CANARY_LOG: logFile,
        CANARY_WALLET: "TestCanaryWallet111111111111111111111111111",
      };
      // node spawning node on Windows can flakily crash during PE/DLL init with an
      // NT status code (0xC0000142 = 3221226505) before the child does any work — a
      // normal node exit is 0-255, so treat >255 as that crash and retry a couple of
      // times. windowsHide gives the child a hidden console (also required below for
      // clean SIGINT delivery on Windows). The CLI itself is fine when run standalone.
      let exitCode = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (fs.existsSync(logFile)) {
          try { fs.unlinkSync(logFile); } catch {}
        }
        exitCode = await new Promise<number>((resolve, reject) => {
          const proc = spawn("node", [scriptPath, "--once"], {
            cwd: rootDir,
            env: spawnEnv,
            windowsHide: true,
          });
          proc.on("error", reject);
          proc.on("close", (code) => resolve(code ?? 0));
        });
        if (exitCode <= 255) break;
      }

      assert.equal(exitCode, 0);

      // Verify log file exists and has 1 entry
      assert.ok(fs.existsSync(logFile), "Log file should exist");
      const lines = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);

      assert.equal(lines.length, 1, `Expected 1 log line, got: ${lines.length}`);
      const entry = lines[0];

      // Format: [2026-09-15T12:00:00Z] iter=42 scan=risk:12/100:SAFE x402=skip
      assert.match(entry, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "Must contain ISO timestamp");
      assert.match(entry, /iter=1\b/, "Must log iter=1");
      assert.match(entry, /scan=risk:15\/100:SAFE/, "Must report riskScore and verdict");
      assert.match(entry, /x402=skip/, "First iteration skips x402 dry-run");

      // Verify mock server received GET /health and POST /selftest
      assert.ok(mock.requests.some((r) => r.method === "GET" && r.url === "/health"));
      assert.ok(mock.requests.some((r) => r.method === "POST" && r.url === "/selftest"));
    } finally {
      await mock.close();
      try {
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
      } catch {}
    }
  });

  it("Assert: 3 consecutive failures trigger the 5-min backoff (mock fetch to fail 3x)", async () => {
    const logFile = makeTmpLog();
    let fetchCount = 0;

    const failingFetch = async () => {
      fetchCount++;
      throw new Error("Simulated network connection drop");
    };

    let fakeNow = 1_700_000_000_000;
    const agent = new CanaryAgent({
      scanUrl: "http://127.0.0.1:9999",
      x402Url: "http://127.0.0.1:9999",
      wallet: "TestCanaryWallet111111111111111111111111111",
      logFile,
      fetchFn: failingFetch as any,
      backoffMs: 300_000, // 5 minutes
      now: () => fakeNow,
    });

    try {
      assert.equal(agent.isBackingOff(), false, "Initial state should not be backing off");

      // Attempt 1: failure 1
      const res1 = await agent.step();
      assert.equal(res1.ok, false);
      assert.equal(agent.consecutiveFailures, 1);
      assert.equal(agent.isBackingOff(), false);

      // Attempt 2: failure 2
      const res2 = await agent.step();
      assert.equal(res2.ok, false);
      assert.equal(agent.consecutiveFailures, 2);
      assert.equal(agent.isBackingOff(), false);

      // Attempt 3: failure 3 -> triggers 5-min backoff
      const res3 = await agent.step();
      assert.equal(res3.ok, false);
      assert.equal(agent.consecutiveFailures, 3);
      assert.equal(agent.isBackingOff(), true);
      assert.equal(
        agent.backoffUntil,
        fakeNow + 300_000,
        "Backoff until should be scheduled exactly 5 min in the future",
      );

      // Attempt 4: while backing off, step returns backedOff=true without attempting fetch
      const beforeFetchCount = fetchCount;
      const res4 = await agent.step();
      assert.equal(res4.ok, false);
      assert.equal(res4.backedOff, true);
      assert.equal(fetchCount, beforeFetchCount, "Fetch should not be called while in backoff");

      // Verify log file records ERROR and 5 minutes backoff
      const logContent = fs.readFileSync(logFile, "utf8");
      assert.match(logContent, /ERROR: 3 consecutive failures/);
      assert.match(logContent, /backing off for 5 minutes/);
    } finally {
      try {
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
      } catch {}
    }
  });

  it("Assert: SIGINT during loop causes clean exit (code 0)", async () => {
    const mock = await createMockServer({ riskScore: 0, verdict: "SAFE" });
    const logFile = makeTmpLog();

    try {
      const spawnEnv = {
        ...process.env,
        CANARY_INTERVAL_SEC: "60",
        CANARY_SCAN_URL: mock.url,
        CANARY_X402_URL: mock.url,
        CANARY_LOG: logFile,
        CANARY_WALLET: "TestCanaryWallet111111111111111111111111111",
      };
      // On Windows, proc.kill("SIGINT") terminates a spawned node child *by signal*
      // without running its JS SIGINT handler (a console-signal limitation), so the
      // canary stops with signal==="SIGINT" (exit null) rather than a clean code 0.
      // On other platforms the handler runs: clean exit 0 and "canary stopped" logged.
      // windowsHide gives the child a hidden console (best-effort signal routing); a
      // Windows node-spawns-node PE/DLL init crash (0xC0000142) can also kill the child
      // before it writes "iter=1", so retry with a fresh log file on each attempt.
      const isWin = process.platform === "win32";
      let exitResult: { code: number | null; signal: NodeJS.Signals | null } = {
        code: null,
        signal: null,
      };
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          fs.rmSync(logFile, { force: true });
        } catch {}
        exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            const proc = spawn("node", [scriptPath], {
              cwd: rootDir,
              env: spawnEnv,
              windowsHide: true,
            });

            proc.on("error", reject);

            // Wait until the child process has executed its first step and written to log
            const interval = setInterval(() => {
              if (fs.existsSync(logFile)) {
                const content = fs.readFileSync(logFile, "utf8");
                if (content.includes("iter=1")) {
                  clearInterval(interval);
                  // Send SIGINT for clean shutdown
                  proc.kill("SIGINT");
                }
              }
            }, 50);

            proc.on("close", (code, signal) => {
              clearInterval(interval);
              resolve({ code, signal });
            });
          },
        );
        const stopped = isWin ? exitResult.signal === "SIGINT" : exitResult.code === 0;
        if (stopped) break;
      }

      if (isWin) {
        // The child was running its loop; SIGINT must be what stopped it.
        assert.equal(
          exitResult.signal,
          "SIGINT",
          "SIGINT should stop the canary (child terminated by the signal on Windows)",
        );
      } else {
        assert.equal(exitResult.code, 0, "SIGINT should trigger exit code 0");

        const finalLog = fs.readFileSync(logFile, "utf8");
        assert.ok(finalLog.includes("canary stopped"), "Log file should record 'canary stopped'");
      }
    } finally {
      await mock.close();
      try {
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
      } catch {}
    }
  });

  it("Every 5th iteration: triggers dry-run x402 payment intent and call", async () => {
    const mock = await createMockServer({ riskScore: 25, verdict: "LOW RISK" });
    const logFile = makeTmpLog();

    const agent = new CanaryAgent({
      scanUrl: mock.url,
      x402Url: mock.url,
      wallet: "TestCanaryWallet111111111111111111111111111",
      logFile,
    });

    try {
      // Steps 1 to 4: x402=skip
      for (let i = 1; i <= 4; i++) {
        const res = await agent.step();
        assert.equal(res.ok, true);
        assert.equal(res.iter, i);
        assert.equal(res.x402Status, "skip");
      }

      // Step 5: x402 dry-run triggered
      const res5 = await agent.step();
      assert.equal(res5.ok, true);
      assert.equal(res5.iter, 5);
      assert.equal(res5.x402Status, "dry-run");

      const logLines = fs.readFileSync(logFile, "utf8").trim().split("\n");
      // Assert payment intent log was written
      assert.ok(logLines.some((l) => l.includes("x402 payment intent (dry-run)")));
      // Assert step 5 recorded x402=dry-run
      assert.ok(logLines.some((l) => l.includes("iter=5") && l.includes("x402=dry-run")));

      // Assert x402 headers were sent
      const x402Req = mock.requests.find(
        (r) => r.headers["x-payment-dry-run"] === "true" && r.headers["x-payment-payer"],
      );
      assert.ok(x402Req, "x402 request should include mock payment headers");
    } finally {
      await mock.close();
      try {
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
      } catch {}
    }
  });

  it("Gracefully logs warning when HELIUS_API_KEY is not set", async () => {
    const mock = await createMockServer({ heliusConfigured: false });
    const logFile = makeTmpLog();

    const agent = new CanaryAgent({
      scanUrl: mock.url,
      x402Url: mock.url,
      wallet: "TestCanaryWallet111111111111111111111111111",
      logFile,
    });

    try {
      const res = await agent.step();
      assert.equal(res.ok, true);

      const log = fs.readFileSync(logFile, "utf8");
      assert.ok(
        log.includes("no API key, using selftest only"),
        "Should log warning about missing API key",
      );
    } finally {
      await mock.close();
      try {
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
      } catch {}
    }
  });
});
