/**
 * Polymarket CLOB Diagnostic Script
 * Run: node diagnose.mjs
 */
import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import { formatUnits } from '@ethersproject/units';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || '';
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS || '';
const SIG_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 0);

console.log('\n═══════════════════════════════════════');
console.log('  Polymarket CLOB Diagnostic');
console.log('═══════════════════════════════════════\n');

// ── Step 1: Check env vars
console.log('1. Environment Variables');
console.log('   POLYMARKET_PRIVATE_KEY:', PRIVATE_KEY ? `set (${PRIVATE_KEY.slice(0, 6)}...${PRIVATE_KEY.slice(-4)})` : '❌ NOT SET');
console.log('   POLYMARKET_FUNDER_ADDRESS:', FUNDER_ADDRESS || '❌ NOT SET');
console.log('   POLYMARKET_SIGNATURE_TYPE:', SIG_TYPE);

if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith('0x')) {
  console.log('\n❌ PRIVATE_KEY is missing or invalid. Must start with 0x.');
  process.exit(1);
}

// ── Step 2: Derive signer address
const signer = new Wallet(PRIVATE_KEY);
const signerAddress = await signer.getAddress();
console.log('\n2. Wallet');
console.log('   Signer address (from private key):', signerAddress);
console.log('   Funder address (from env):', FUNDER_ADDRESS || '(not set — will use signer)');

// ── Step 3: Check USDC balance for both addresses
console.log('\n3. USDC Balances on Polygon');
const provider = new JsonRpcProvider('https://polygon-rpc.com');
const usdc = new Contract(USDC_ADDRESS, USDC_ABI, provider);

try {
  const signerBal = await usdc.balanceOf(signerAddress);
  console.log(`   Signer (${signerAddress}): $${formatUnits(signerBal, 6)} USDC`);
} catch (e) { console.log('   Signer balance check failed:', e.message); }

if (FUNDER_ADDRESS && FUNDER_ADDRESS !== signerAddress) {
  try {
    const funderBal = await usdc.balanceOf(FUNDER_ADDRESS);
    console.log(`   Funder (${FUNDER_ADDRESS}): $${formatUnits(funderBal, 6)} USDC`);
  } catch (e) { console.log('   Funder balance check failed:', e.message); }
}

// ── Step 4: Try API key derivation
console.log('\n4. CLOB API Key Derivation');
let apiCreds = null;
try {
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  apiCreds = await tempClient.createOrDeriveApiKey();
  console.log('   ✅ API Key:', apiCreds?.key || '(empty!)');
  console.log('   Secret:', apiCreds?.secret ? `${apiCreds.secret.slice(0, 8)}...` : '(empty!)');
  console.log('   Passphrase:', apiCreds?.passphrase ? `${apiCreds.passphrase.slice(0, 8)}...` : '(empty!)');
} catch (e) {
  console.log('   ❌ API key derivation FAILED:', e.message);
  console.log('\n   This usually means:');
  console.log('   - Your wallet has never been used on polymarket.com');
  console.log('   - You need to log in at polymarket.com with this wallet first');
  process.exit(1);
}

if (!apiCreds?.key) {
  console.log('   ❌ No API key returned. The wallet may not be registered on Polymarket.');
  process.exit(1);
}

// ── Step 5: Try creating full client and check open orders (read-only test)
console.log('\n5. Full Client (Trading) Setup');

// Try with funder
const funder = FUNDER_ADDRESS || signerAddress;
console.log(`   Creating client with funder=${funder}, sigType=${SIG_TYPE}`);

const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, apiCreds, SIG_TYPE, funder);

// Test: get open orders (read-only, should work if auth is correct)
try {
  const orders = await client.getOpenOrders();
  console.log('   ✅ getOpenOrders works! Count:', Array.isArray(orders) ? orders.length : 'unknown');
} catch (e) {
  console.log('   ❌ getOpenOrders FAILED:', e.message);
}

// ── Step 6: Try DIFFERENT signature types to see which works
console.log('\n6. Testing Signature Types');
for (const testSigType of [0, 1, 2]) {
  try {
    const testClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, apiCreds, testSigType, funder);
    const orders = await testClient.getOpenOrders();
    console.log(`   sigType=${testSigType}: ✅ works (${Array.isArray(orders) ? orders.length : '?'} orders)`);
  } catch (e) {
    console.log(`   sigType=${testSigType}: ❌ ${e.message?.slice(0, 80)}`);
  }
}

// ── Step 7: Try without funder (use signer as funder)
if (FUNDER_ADDRESS && FUNDER_ADDRESS !== signerAddress) {
  console.log('\n7. Testing WITHOUT funder (signer as its own funder)');
  for (const testSigType of [0, 1, 2]) {
    try {
      const testClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, apiCreds, testSigType, signerAddress);
      const orders = await testClient.getOpenOrders();
      console.log(`   sigType=${testSigType}, funder=signer: ✅ works`);
    } catch (e) {
      console.log(`   sigType=${testSigType}, funder=signer: ❌ ${e.message?.slice(0, 80)}`);
    }
  }
}

// ── Step 8: Try a dry-run order creation (create but DON'T post)
console.log('\n8. Dry-Run Order Creation');
try {
  // Use a dummy token ID — we're just testing if the signing works
  // We'll use createOrder (creates but doesn't post) to avoid spending money
  const dummyTokenId = '71321045679252212594626385532706912750332728571942532289631379312455583992563';
  const order = await client.createOrder({
    tokenID: dummyTokenId,
    price: 0.01,
    size: 1,
    side: Side.BUY,
  }, { tickSize: '0.01', negRisk: false });
  console.log('   ✅ Order creation (local signing) works');
  console.log('   Order signature type:', order?.signatureType ?? 'unknown');
  console.log('   Order maker:', order?.maker ?? 'unknown');
  console.log('   Order signer:', order?.signer ?? 'unknown');
} catch (e) {
  console.log('   ❌ Order creation failed:', e.message);
}

console.log('\n═══════════════════════════════════════');
console.log('  Diagnostic complete');
console.log('═══════════════════════════════════════\n');

process.exit(0);
