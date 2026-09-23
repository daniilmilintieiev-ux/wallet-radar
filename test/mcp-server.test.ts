import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHealth, getVersion, loadEnv } from "../src/mcp-server.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverScript = path.join(rootDir, "dist/src/mcp-server.js");
const binScript = path.join(rootDir, "bin/mcp-server");

function runCommand(file: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: rootDir }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: err ? (err.code as number ?? 1) : 0,
      });
    });
  });
}

test("mcp-server CLI: --version prints version and exits 0", async () => {
  const res = await runCommand("node", [serverScript, "--version"]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), getVersion());

  // Also test short flag -v
  const resShort = await runCommand("node", [serverScript, "-v"]);
  assert.equal(resShort.code, 0);
  assert.equal(resShort.stdout.trim(), getVersion());
});

test("mcp-server CLI: --health outputs valid JSON health object and exits 0", async () => {
  const res = await runCommand("node", [serverScript, "--health"]);
  assert.equal(res.code, 0);

  const health = JSON.parse(res.stdout.trim());
  assert.equal(health.ok, true);
  assert.equal(health.status, "ok");
  assert.equal(health.name, "wallet-radar");
  assert.equal(health.version, getVersion());
  assert.equal(health.transport, "stdio");
  // audit 4.6: health must report ALL registered MCP tools, not a stale subset
  assert.deepEqual(health.tools, [
    "radar_scan",
    "radar_analyze",
    "radar_trust",
    "radar_batch",
    "radar_simulate",
    "radar_selftest",
    "radar_benchmark",
  ]);
  assert.equal(typeof health.env, "object");
});

test("mcp-server bin: bin/mcp-server is executable and supports --version and --health", async () => {
  const resVersion = await runCommand("node", [binScript, "--version"]);
  assert.equal(resVersion.code, 0);
  assert.equal(resVersion.stdout.trim(), getVersion());

  const resHealth = await runCommand("node", [binScript, "--health"]);
  assert.equal(resHealth.code, 0);
  const health = JSON.parse(resHealth.stdout.trim());
  assert.equal(health.ok, true);
  assert.equal(health.name, "wallet-radar");
});

test("mcp-server: loadEnv populates env variables without overwriting", () => {
  const tmpEnvFile = path.join(rootDir, "test-radar.env");
  fs.writeFileSync(tmpEnvFile, "TEST_CUSTOM_MCP_KEY=secret123\nTEST_OVERRIDE=from_file\n", "utf8");

  process.env.TEST_OVERRIDE = "existing";
  delete process.env.TEST_CUSTOM_MCP_KEY;

  try {
    loadEnv(tmpEnvFile);
    assert.equal(process.env.TEST_CUSTOM_MCP_KEY, "secret123");
    assert.equal(process.env.TEST_OVERRIDE, "existing");
  } finally {
    delete process.env.TEST_CUSTOM_MCP_KEY;
    delete process.env.TEST_OVERRIDE;
    if (fs.existsSync(tmpEnvFile)) fs.unlinkSync(tmpEnvFile);
  }
});

test("mcp-server: stdio JSON-RPC handshake and tools/list request", async () => {
  const child = spawn("node", [serverScript], {
    cwd: rootDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const responses: any[] = [];
    let buffer = "";

    const waitForMessage = (predicate: (msg: any) => boolean, timeoutMs = 4000): Promise<any> => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for JSON-RPC response; got: ${JSON.stringify(responses)}`));
        }, timeoutMs);

        const checkExisting = () => {
          const found = responses.find(predicate);
          if (found) {
            clearTimeout(timer);
            resolve(found);
            return true;
          }
          return false;
        };

        if (checkExisting()) return;

        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) {
              try {
                const msg = JSON.parse(line.trim());
                responses.push(msg);
                if (checkExisting()) {
                  child.stdout.off("data", onData);
                  return;
                }
              } catch {}
            }
          }
        };
        child.stdout.on("data", onData);
      });
    };

    // 1. Send initialize request
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }) + "\n",
    );

    const initRes = await waitForMessage((m) => m.id === 101);
    assert.equal(initRes.result?.serverInfo?.name, "wallet-radar");
    assert.equal(initRes.result?.serverInfo?.version, getVersion());
    assert.ok(initRes.result?.capabilities);

    // 2. Initialized notification
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n",
    );

    // 3. Send tools/list request
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/list",
        params: {},
      }) + "\n",
    );

    const toolsRes = await waitForMessage((m) => m.id === 102);
    assert.ok(Array.isArray(toolsRes.result?.tools));
    const toolNames = toolsRes.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("radar_scan"));
    assert.ok(toolNames.includes("radar_analyze"));
    assert.ok(toolNames.includes("radar_selftest"));
  } finally {
    child.kill();
  }
});
