import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (pkg.name === "wallet-radar" && pkg.version) {
          cachedVersion = String(pkg.version);
          return cachedVersion;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return "1.0.0";
}
