import fs from 'fs';
import path from 'path';

// Read API key safely without exposing it
let apiKey = '';
const envContent = fs.readFileSync('radar.env', 'utf8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.startsWith('HELIUS_API_KEY=')) {
    apiKey = trimmed.split('=')[1].trim().replace(/['"]/g, '');
  }
}
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const delay = attempt * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
}

async function runCensus() {
  const walletsRaw = fs.readFileSync('archive/exp1/large-wallets.json', 'utf8');
  const wallets = JSON.parse(walletsRaw);
  console.log(`Loaded ${wallets.length} wallets from archive/exp1/large-wallets.json`);

  // Get current slot
  const slotRes = await fetchWithRetry(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'slot', method: 'getSlot' })
  });
  const currentSlot = slotRes?.result ?? 451581108;
  console.log(`Current slot: ${currentSlot}`);

  const checkedAt = new Date().toISOString();
  const frozenRecords = [];
  let processedCount = 0;
  let errorsCount = 0;

  const concurrency = 15;
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < wallets.length) {
      const idx = currentIndex++;
      const w = wallets[idx];
      const address = w.address;

      try {
        const batchBody = [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]
          },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'getTokenAccountsByOwner',
            params: [address, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }]
          }
        ];

        const data = await fetchWithRetry(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batchBody)
        });

        if (Array.isArray(data)) {
          for (const item of data) {
            const accounts = item.result?.value || [];
            for (const acct of accounts) {
              const info = acct.account?.data?.parsed?.info;
              if (info?.state === 'frozen') {
                frozenRecords.push({
                  wallet: address,
                  mint: info.mint,
                  token_account: acct.pubkey,
                  state: 'frozen',
                  checked_at: checkedAt,
                  slot: currentSlot
                });
              }
            }
          }
        }
      } catch (err) {
        errorsCount++;
      } finally {
        processedCount++;
        if (processedCount % 100 === 0 || processedCount === wallets.length) {
          console.log(`Progress: ${processedCount}/${wallets.length} wallets processed... (found ${frozenRecords.length} frozen accounts)`);
        }
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`\nCensus finished:`);
  console.log(`Total wallets processed: ${processedCount}/${wallets.length}`);
  console.log(`Errors encountered: ${errorsCount}`);
  console.log(`Total frozen token accounts found: ${frozenRecords.length}`);

  const walletsWithFrozen = new Set(frozenRecords.map((r) => r.wallet));
  console.log(`Unique wallets with frozen accounts: ${walletsWithFrozen.size}`);

  fs.mkdirSync('ground-truth/outcomes', { recursive: true });
  const outPath = 'ground-truth/outcomes/frozen_census.jsonl';
  const lines = frozenRecords.map((r) => JSON.stringify(r)).join('\n') + (frozenRecords.length > 0 ? '\n' : '');
  fs.writeFileSync(outPath, lines, 'utf8');
  console.log(`Wrote ${frozenRecords.length} records to ${outPath}`);
}

runCensus().catch((err) => {
  console.error('Fatal error in census:', err);
  process.exit(1);
});
