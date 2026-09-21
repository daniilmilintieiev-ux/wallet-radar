#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./mcp.js";

export function getVersion(): string {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return String(pkg.version);
    }
  } catch {}
  return "0.1.0";
}

export interface McpHealth {
  ok: boolean;
  status: string;
  name: string;
  version: string;
  transport: string;
  tools: string[];
  env: {
    heliusConfigured: boolean;
    webhookConfigured: boolean;
    llmConfigured: boolean;
  };
}

export function loadEnv(envPath?: string): void {
  const candidates = [
    envPath,
    process.env.RADAR_ENV,
    path.resolve(process.cwd(), "radar.env"),
    path.resolve(process.cwd(), ".env"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
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
      console.warn(`[radar] loaded env file: ${candidate}`);
      break;
    }
  }
}

export function getHealth(): McpHealth {
  return {
    ok: true,
    status: "ok",
    name: "wallet-radar",
    version: getVersion(),
    transport: "stdio",
    tools: ["radar_scan", "radar_analyze", "radar_selftest", "radar_trust"],
    env: {
      heliusConfigured: Boolean(process.env.HELIUS_API_KEY),
      webhookConfigured: Boolean(process.env.WEBHOOK_URL),
      llmConfigured: Boolean(process.env.RADAR_LLM_KEY),
    },
  };
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--version") || args.includes("-v")) {
    console.log(getVersion());
    process.exit(0);
  }

  if (args.includes("--health")) {
    loadEnv();
    console.log(JSON.stringify(getHealth(), null, 2));
    process.exit(0);
  }

  loadEnv();
  serveStdio(() => buildServer());
}

const isDirectRun = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectRun) {
  runCli().catch((err) => {
    console.error("MCP server failed:", err);
    process.exit(1);
  });
}
