/**
 * Polymarket CLOB Client Wrapper
 * Handles authentication, order placement, cancellation, and balance checks.
 * Uses @polymarket/clob-client (ethers v5 internally).
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import fs from 'node:fs';
import path from 'node:path';

/* ── Config ──────────────────────────────────────────── */

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

const PRIVATE_KEY       = process.env.POLYMARKET_PRIVATE_KEY || '';
const FUNDER_ADDRESS    = process.env.POLYMARKET_FUNDER_ADDRESS || '';
const SIGNATURE_TYPE    = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 0);

/* ── State ───────────────────────────────────────────── */

let client = null;
let initialized = false;
let initError = null;
let apiCreds = null;

/* ── Logging ─────────────────────────────────────────── */

function logOrder(entry) {
  try {
    const dir = './logs';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'real_trades.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* */ }
    if (!Array.isArray(existing)) existing = [];
    existing.push(entry);
    // Keep last 500
    if (existing.length > 500) existing = existing.slice(-500);
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/* ── Initialization ──────────────────────────────────── */

export async function initClobClient() {
  if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith('0x')) {
    initError = 'POLYMARKET_PRIVATE_KEY not set or invalid (must start with 0x)';
    console.log(`  [clob] ${initError}`);
    return false;
  }

  try {
    const signer = new Wallet(PRIVATE_KEY);
    const signerAddress = await signer.getAddress();
    console.log(`  [clob] signer address: ${signerAddress}`);

    // Step 1: Create temp client to derive API creds (L1 auth)
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
    apiCreds = await tempClient.createOrDeriveApiKey();
    console.log(`  [clob] API credentials derived successfully`);

    // Step 2: Create full trading client with L2 auth
    const funder = FUNDER_ADDRESS || signerAddress;
    client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      signer,
      apiCreds,
      SIGNATURE_TYPE,
      funder
    );

    initialized = true;
    initError = null;
    console.log(`  [clob] client ready (funder: ${funder}, sigType: ${SIGNATURE_TYPE})`);
    return true;
  } catch (err) {
    initError = err?.message ?? String(err);
    console.error(`  [clob] init error: ${initError}`);
    return false;
  }
}

export function isClobReady() {
  return initialized && client !== null;
}

export function getClobStatus() {
  return {
    ready: initialized && client !== null,
    error: initError,
    hasKey: !!PRIVATE_KEY,
    hasFunder: !!FUNDER_ADDRESS,
  };
}

/* ── Order Placement ─────────────────────────────────── */

/**
 * Place a limit buy order on Polymarket.
 * @param {string} tokenId - The CLOB token ID (UP or DOWN)
 * @param {number} price - Price per share (0.01 to 0.99)
 * @param {number} size - Number of shares
 * @param {object} opts - { tickSize, negRisk }
 * @returns {{ ok, orderId, error }}
 */
export async function placeBuyOrder(tokenId, price, size, opts = {}) {
  if (!isClobReady()) return { ok: false, error: 'CLOB client not initialized' };

  const tickSize = opts.tickSize || '0.01';
  const negRisk = opts.negRisk ?? false;

  const entry = {
    action: 'PLACE_BUY',
    tokenId,
    price,
    size,
    tickSize,
    negRisk,
    timestamp: new Date().toISOString(),
    orderId: null,
    error: null,
  };

  try {
    console.log(`  [REAL TRADE] placing BUY: ${size} shares @ ${price} (token: ${tokenId.slice(0, 12)}...)`);

    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.BUY,
      },
      {
        tickSize,
        negRisk,
      },
      OrderType.GTC
    );

    const orderId = response?.orderID || response?.id || null;
    entry.orderId = orderId;
    entry.response = response;
    logOrder(entry);

    console.log(`  [REAL TRADE] order placed: ${orderId}`);
    return { ok: true, orderId, response };
  } catch (err) {
    entry.error = err?.message ?? String(err);
    logOrder(entry);
    console.error(`  [REAL TRADE] order FAILED: ${entry.error}`);
    return { ok: false, error: entry.error };
  }
}

/* ── Order Cancellation ──────────────────────────────── */

export async function cancelOrder(orderId) {
  if (!isClobReady()) return { ok: false, error: 'CLOB client not initialized' };

  try {
    console.log(`  [REAL TRADE] cancelling order: ${orderId}`);
    const response = await client.cancelOrder(orderId);
    logOrder({ action: 'CANCEL', orderId, timestamp: new Date().toISOString(), response });
    console.log(`  [REAL TRADE] order cancelled: ${orderId}`);
    return { ok: true, response };
  } catch (err) {
    const error = err?.message ?? String(err);
    logOrder({ action: 'CANCEL_FAILED', orderId, timestamp: new Date().toISOString(), error });
    console.error(`  [REAL TRADE] cancel FAILED: ${error}`);
    return { ok: false, error };
  }
}

export async function cancelAllOrders() {
  if (!isClobReady()) return { ok: false, error: 'CLOB client not initialized' };

  try {
    console.log(`  [REAL TRADE] cancelling ALL open orders`);
    const response = await client.cancelAll();
    logOrder({ action: 'CANCEL_ALL', timestamp: new Date().toISOString(), response });
    console.log(`  [REAL TRADE] all orders cancelled`);
    return { ok: true, response };
  } catch (err) {
    const error = err?.message ?? String(err);
    console.error(`  [REAL TRADE] cancel all FAILED: ${error}`);
    return { ok: false, error };
  }
}

/* ── Open Orders ─────────────────────────────────────── */

export async function getOpenOrders() {
  if (!isClobReady()) return [];
  try {
    const orders = await client.getOpenOrders();
    return Array.isArray(orders) ? orders : [];
  } catch (err) {
    console.error(`  [clob] getOpenOrders error: ${err?.message}`);
    return [];
  }
}

/* ── Trades ──────────────────────────────────────────── */

export async function getRecentTrades() {
  if (!isClobReady()) return [];
  try {
    const trades = await client.getTrades();
    return Array.isArray(trades) ? trades : [];
  } catch (err) {
    console.error(`  [clob] getTrades error: ${err?.message}`);
    return [];
  }
}
