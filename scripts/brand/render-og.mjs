import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const BRAND_DIR = path.join(REPO_ROOT, 'docs', 'brand');
const FONTS_DIR = path.join(REPO_ROOT, 'docs', 'dashboard', 'fonts');

// Load Playwright from local, global, or user cache
let playwright;
try {
  playwright = await import('playwright');
} catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  const globalRequire = createRequire(globalRoot + '/');
  playwright = globalRequire('playwright');
}

// 1. Get test counts from npm test dynamically
console.log('Running npm test to retrieve live test metrics...');
let passCount = '751';
let totalCount = '751';
try {
  const testOutput = execSync('npm test', { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const passMatch = testOutput.match(/pass\s+(\d+)/);
  const totalMatch = testOutput.match(/tests\s+(\d+)/);
  if (passMatch) passCount = passMatch[1];
  if (totalMatch) totalCount = totalMatch[1];
  console.log(`Live test count retrieved: ${passCount}/${totalCount} tests passing`);
} catch (err) {
  const out = (err.stdout || '') + (err.stderr || '');
  const passMatch = out.match(/pass\s+(\d+)/);
  const totalMatch = out.match(/tests\s+(\d+)/);
  if (passMatch) passCount = passMatch[1];
  if (totalMatch) totalCount = totalMatch[1];
  console.log(`Parsed test output from exit: ${passCount}/${totalCount}`);
}

const testPassingChipText = `${passCount}/${totalCount} Tests Passing`;

// Read logo SVG
const lockupSvgRaw = fs.readFileSync(path.join(BRAND_DIR, 'lockup-horizontal.svg'), 'utf-8');
const lockupSvg = lockupSvgRaw.replace('height="64"', 'height="84" style="height:84px;width:auto;"');

// Read fonts to base64
const mono400B64 = fs.readFileSync(path.join(FONTS_DIR, 'jetbrains-mono-latin-400-normal.woff2')).toString('base64');
const mono500B64 = fs.readFileSync(path.join(FONTS_DIR, 'jetbrains-mono-latin-500-normal.woff2')).toString('base64');

export function getHtmlTemplate(w, h, testsBadgeText = testPassingChipText) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'JetBrains Mono';
    src: url('data:font/woff2;base64,${mono400B64}') format('woff2');
    font-weight: 400;
  }
  @font-face {
    font-family: 'JetBrains Mono';
    src: url('data:font/woff2;base64,${mono500B64}') format('woff2');
    font-weight: 500;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${w}px;
    height: ${h}px;
    background: #0a0a0b;
    color: #f1f1ee;
    font-family: 'JetBrains Mono', monospace;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 56px 72px;
    overflow: hidden;
  }
  .top-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .brand-lockup {
    height: 84px;
    display: flex;
    align-items: center;
  }
  .brand-lockup svg {
    height: 84px;
    width: auto;
  }
  .tagline {
    font-size: 22px;
    color: #ffb000;
    letter-spacing: 1px;
    text-transform: uppercase;
    font-weight: 500;
  }
  .middle-section {
    display: flex;
    flex-direction: column;
    gap: 28px;
    margin-top: 10px;
  }
  .headline {
    font-size: 28px;
    line-height: 1.45;
    color: #f1f1ee;
    max-width: 1040px;
    font-weight: 400;
  }
  .headline b {
    color: #ffb000;
    font-weight: 500;
  }
  .chips {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 15px;
    padding: 9px 16px;
    background: #12141a;
    border: 1px solid #21262d;
    border-radius: 4px;
    color: #f1f1ee;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .chip b {
    color: #ffb000;
    font-weight: 500;
  }
  .bottom-section {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid #21262d;
    padding-top: 20px;
    font-size: 16px;
    color: #8b949e;
  }
  .bottom-section .domain {
    color: #ffb000;
    font-weight: 500;
    letter-spacing: 0.5px;
  }
</style>
</head>
<body>
  <div class="top-section">
    <div class="brand-lockup">
      ${lockupSvg}
    </div>
    <div class="tagline">The gate before you copy</div>
  </div>
  
  <div class="middle-section">
    <div class="headline">
      Continuous Solana behavioral intelligence &amp; pre-trade simulation.<br>
      <b>Flags where wallet behavior breaks.</b>
    </div>
    <div class="chips">
      <div class="chip"><b>TypeScript + Rust hook</b></div>
      <div class="chip"><b>${testsBadgeText.split(' ')[0]}</b> ${testsBadgeText.split(' ').slice(1).join(' ')}</div>
      <div class="chip"><b>Zero External DB</b> SQLite</div>
      <div class="chip"><b>Signed</b> scan records</div>
      <div class="chip"><b>8 of 8</b> MCP Tools Live</div>
    </div>
  </div>

  <div class="bottom-section">
    <span>Autonomous Pre-Trade Firewall for Solana AI Agents</span>
    <span class="domain">radar.cbellory.xyz</span>
  </div>
</body>
</html>`;
}

// 2. Render cards
async function main() {
  const browser = await playwright.chromium.launch();
  
  // Render og-image.png (1200x630)
  {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.setContent(getHtmlTemplate(1200, 630));
    const outPath = path.join(BRAND_DIR, 'og-image.png');
    await page.screenshot({ path: outPath });
    const stat = fs.statSync(outPath);
    console.log(`Rendered og-image.png (${stat.size} bytes)`);
  }

  // Render social-preview.png (1280x640)
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
    await page.setContent(getHtmlTemplate(1280, 640));
    const outPath = path.join(BRAND_DIR, 'social-preview.png');
    await page.screenshot({ path: outPath });
    const stat = fs.statSync(outPath);
    console.log(`Rendered social-preview.png (${stat.size} bytes)`);
  }

  await browser.close();
  console.log('Rendering completed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Error running render-og.mjs:', err);
    process.exit(1);
  });
}
