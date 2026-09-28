import * as fs from "node:fs";
import * as path from "node:path";
import { fetchMintMetadata } from "../src/mint.js";

function loadEnv(): string {
  const candidates = [
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
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!(key in process.env)) process.env[key] = val;
          }
        }
      } catch {}
      break;
    }
  }
  return process.env.HELIUS_API_KEY || "";
}

async function main() {
  const apiKey = loadEnv();
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const cachePath = path.resolve(process.cwd(), "benchmarks/mint-cache.json");

  if (!fs.existsSync(cachePath)) {
    console.error("mint-cache.json not found");
    process.exit(1);
  }

  const mintCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const candidateMints = Object.entries(mintCache).filter(
    ([_m, info]: any) => info && info.top10Pct >= 80 && !info.freezeAuthority,
  );

  console.log("================================================================================");
  console.log("  REFRESHING MINT CACHE: ACCURATE AMM POOL FILTERING");
  console.log(`  Total Mints to re-evaluate: ${candidateMints.length} of ${Object.keys(mintCache).length}`);
  console.log("================================================================================\n");

  const CONCURRENCY = 10;
  let updatedCount = 0;
  let dropBelow80Count = 0;

  for (let i = 0; i < candidateMints.length; i += CONCURRENCY) {
    const chunk = candidateMints.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async ([mint, oldInfo]: [string, any]) => {
        try {
          const newInfo = await fetchMintMetadata(mint, { apiKey, rpcUrl });
          if (newInfo && typeof newInfo.top10Pct === "number") {
            const oldVal = oldInfo.top10Pct;
            mintCache[mint] = newInfo;
            updatedCount++;
            if (newInfo.top10Pct < 80) {
              dropBelow80Count++;
            }
          }
        } catch {}
      }),
    );
    process.stdout.write(
      `\rProgress: [${Math.min(i + CONCURRENCY, candidateMints.length)}/${candidateMints.length}] | Dropped below 80% (false positives resolved): ${dropBelow80Count}`,
    );
    await new Promise((r) => setTimeout(r, 120));
  }

  fs.writeFileSync(cachePath, JSON.stringify(mintCache, null, 2), "utf8");
  console.log("\n\n✔ Mint cache refresh complete!");
  console.log(`  • Updated mints: ${updatedCount}`);
  console.log(`  • Mints where concentration dropped below 80% (DEX pools excluded): ${dropBelow80Count}`);
  console.log(`  • Mints genuinely concentrated >= 80% (true risk): ${candidateMints.length - dropBelow80Count}`);
}

main().catch(console.error);
