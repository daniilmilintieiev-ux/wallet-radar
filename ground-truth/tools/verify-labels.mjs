import fs from 'fs';
import path from 'path';

// Read API key safely without exposing it
let apiKey = '';
if (fs.existsSync('radar.env')) {
  const envContent = fs.readFileSync('radar.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('HELIUS_API_KEY=')) {
      apiKey = trimmed.split('=')[1].trim().replace(/['"]/g, '');
    }
  }
}
const rpcUrl = apiKey
  ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
  : 'https://api.mainnet-beta.solana.com';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

// Load exp1 large-wallets.json for contamination check
let exp1Addresses = new Set();
const exp1Path = path.resolve('archive/exp1/large-wallets.json');
if (fs.existsSync(exp1Path)) {
  try {
    const exp1Data = JSON.parse(fs.readFileSync(exp1Path, 'utf8'));
    for (const item of exp1Data) {
      if (item && item.address) {
        exp1Addresses.add(item.address);
      }
    }
  } catch (err) {
    console.error(`Warning: Failed to load ${exp1Path}:`, err.message);
  }
}

async function verifyRecord(record, index, seenAddresses) {
  const errors = [];
  const warnings = [];

  const address = record.address;
  const label = record.label;
  const sourceUrl = record.source_url;
  const cutoffDate = record.cutoff_date;
  const eventDate = record.event_date;
  const evidenceQuote = record.evidence_quote;

  // 1. Address syntax & duplicate check
  if (!address || typeof address !== 'string') {
    errors.push('Missing or invalid address field');
    return { pass: false, errors, warnings };
  }

  if (seenAddresses.has(address)) {
    errors.push(`Duplicate address in dataset: ${address}`);
  }
  seenAddresses.add(address);

  // 2. Overlap with experiment 1
  if (exp1Addresses.has(address)) {
    errors.push(`Contamination: address is present in archive/exp1/large-wallets.json`);
  }

  // 3. Temporal consistency
  if (label === 'DANGEROUS') {
    if (!cutoffDate || !eventDate) {
      errors.push('DANGEROUS label requires both cutoff_date and event_date');
    } else {
      const cDate = new Date(cutoffDate);
      const eDate = new Date(eventDate);
      if (isNaN(cDate.getTime()) || isNaN(eDate.getTime())) {
        errors.push(`Invalid date format (cutoff: ${cutoffDate}, event: ${eventDate})`);
      } else if (eDate <= cDate) {
        errors.push(`Lookahead violation: event_date (${eventDate}) <= cutoff_date (${cutoffDate})`);
      }
    }

    if (!evidenceQuote || typeof evidenceQuote !== 'string' || evidenceQuote.trim().length === 0) {
      errors.push('DANGEROUS label requires evidence_quote (verbatim excerpt up to 15 words)');
    } else {
      const words = evidenceQuote.trim().split(/\s+/);
      if (words.length > 15) {
        errors.push(`evidence_quote exceeds 15 words limit (got ${words.length} words: "${evidenceQuote}")`);
      }
    }
  }

  // 4. Source URL check
  let pageText = null;
  if (!sourceUrl || typeof sourceUrl !== 'string') {
    errors.push('Missing or invalid source_url');
  } else {
    try {
      const res = await fetch(sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (res.status !== 200) {
        errors.push(`source_url returned HTTP ${res.status} (expected 200)`);
      } else {
        pageText = await res.text();
        if (!pageText.includes(address)) {
          errors.push(`Address "${address}" not found verbatim in raw HTTP response`);
        }
        if (label === 'DANGEROUS' && evidenceQuote) {
          if (!pageText.includes(evidenceQuote.trim())) {
            errors.push(`evidence_quote "${evidenceQuote}" not found verbatim in raw HTTP response`);
          }
        }
      }
    } catch (fetchErr) {
      errors.push(`source_url fetch failed: ${fetchErr.message}`);
    }
  }

  // 5. RPC Account check: must be System-owned and non-executable for wallets
  try {
    const rpcRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [address, { encoding: 'jsonParsed' }]
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!rpcRes.ok) {
      errors.push(`RPC getAccountInfo returned HTTP ${rpcRes.status}`);
    } else {
      const rpcData = await rpcRes.json();
      const val = rpcData.result?.value;
      if (val === null) {
        // Account uninitialized on-chain (has 0 lamports and no data)
        // System owned default
      } else if (val && typeof val === 'object') {
        const owner = val.owner;
        const executable = Boolean(val.executable);
        if (executable) {
          errors.push(`Account is executable (smart contract / program), not a wallet`);
        }
        if (owner !== SYSTEM_PROGRAM_ID) {
          errors.push(`Account owner is "${owner}" (expected System Program ${SYSTEM_PROGRAM_ID})`);
        }
      }
    }
  } catch (rpcErr) {
    errors.push(`RPC getAccountInfo failed: ${rpcErr.message}`);
  }

  return {
    pass: errors.length === 0,
    errors,
    warnings
  };
}

async function main() {
  const targetFile = process.argv[2] || 'ground-truth/labels.jsonl';
  console.log(`============================================================`);
  console.log(`LABEL VERIFIER: ${targetFile}`);
  console.log(`Loaded ${exp1Addresses.size} exp1 addresses for contamination checks`);
  console.log(`============================================================\n`);

  if (!fs.existsSync(targetFile)) {
    console.error(`Target file not found: ${targetFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(targetFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  console.log(`Found ${lines.length} records to verify.\n`);

  const seenAddresses = new Set();
  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < lines.length; i++) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch (parseErr) {
      console.log(`[RECORD ${i + 1}] FAIL - Invalid JSON: ${parseErr.message}`);
      failCount++;
      continue;
    }

    const res = await verifyRecord(record, i, seenAddresses);
    const addr = record.address || 'UNKNOWN';
    const label = record.label || 'UNKNOWN';

    if (res.pass) {
      console.log(`[RECORD ${i + 1}] PASS | Address: ${addr} | Label: ${label}`);
      passCount++;
    } else {
      console.log(`[RECORD ${i + 1}] FAIL | Address: ${addr} | Label: ${label}`);
      for (const err of res.errors) {
        console.log(`   - REASON: ${err}`);
      }
      failCount++;
    }
  }

  console.log(`\n============================================================`);
  console.log(`VERIFICATION SUMMARY:`);
  console.log(`Total records: ${lines.length}`);
  console.log(`PASS: ${passCount}`);
  console.log(`FAIL: ${failCount}`);
  console.log(`============================================================`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal verifier error:', err);
  process.exit(1);
});
