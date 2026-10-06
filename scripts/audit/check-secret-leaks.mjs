import fs from 'node:fs';
import cp from 'node:child_process';

const envPath = 'c:/Users/cbell/Documents/antigravity/kind-darwin/radar.env';
const content = fs.readFileSync(envPath, 'utf8');
const keys = ['HELIUS_API_KEY', 'GEMINI_API_KEY', 'TG_BOT_TOKEN', 'JUPITER_API_KEY'];
const vals = {};

for (const rawLine of content.split('\n')) {
  const line = rawLine.trim();
  for (const k of keys) {
    const prefix = k + '=';
    if (line.startsWith(prefix)) {
      const v = line.slice(prefix.length).trim().replace(/^["']|["']$/g, '');
      if (v) vals[k] = v;
    }
  }
}

const logOutput = cp.execSync('git log -p origin/main..HEAD', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

for (const k of keys) {
  const v = vals[k];
  if (!v) {
    console.log(`${k}: not set in radar.env`);
    continue;
  }
  let headMatches = 0;
  try {
    const grepOut = cp.execFileSync('git', ['grep', '-F', v, 'HEAD'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    headMatches = grepOut.trim().split('\n').filter(Boolean).length;
  } catch {
    headMatches = 0;
  }
  let logMatches = 0;
  let idx = 0;
  while ((idx = logOutput.indexOf(v, idx)) !== -1) {
    logMatches++;
    idx += v.length;
  }
  console.log(`${k}: HEAD matches = ${headMatches}, log matches = ${logMatches}`);
}
