import fs from 'fs';
import { PublicKey } from '@solana/web3.js';

let apiKey = '';
const envContent = fs.readFileSync('radar.env', 'utf8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.startsWith('HELIUS_API_KEY=')) {
    apiKey = trimmed.split('=')[1].trim().replace(/['"]/g, '');
  }
}
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

function getPumpCurvePda(mintStr) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve', 'utf8'), new PublicKey(mintStr).toBuffer()],
    PUMP_PROGRAM
  );
  return pda.toBase58();
}

const mints = [
  '7ktc9XbVMcShzkpV7gofTEBCqvSVTvw66MCvFCYDpump',
  'Ew2gmuMt4W5tjqoc4bUdWrcPBgBp6MYXUBFiD1TTpump'
];

async function checkPump() {
  for (const mint of mints) {
    const curvePda = getPumpCurvePda(mint);
    console.log(`\n============================================================`);
    console.log(`Mint: ${mint}`);
    console.log(`Pump.fun Bonding Curve PDA: ${curvePda}`);
    console.log(`============================================================`);

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [mint]
      })
    });
    const d = await res.json();
    const topAccounts = (d.result?.value || []).slice(0, 5);

    console.log(`Top 5 Token Accounts from getTokenLargestAccounts:`);
    for (let i = 0; i < topAccounts.length; i++) {
      const ta = topAccounts[i];
      // Get holder (owner of the token account)
      const accRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [ta.address, { encoding: 'jsonParsed' }]
        })
      });
      const accData = await accRes.json();
      const holder = accData.result?.value?.data?.parsed?.info?.owner || 'UNKNOWN';
      const isBondingCurve = holder === curvePda;
      console.log(`  #${i + 1} TokenAccount: ${ta.address}`);
      console.log(`     Holder (Owner): ${holder}`);
      console.log(`     Amount: ${ta.uiAmountString}`);
      console.log(`     Is Bonding Curve PDA: ${isBondingCurve ? 'ДА (ХОЛДЕР = BONDING CURVE)' : 'НЕТ'}`);
    }
  }
}

checkPump();
