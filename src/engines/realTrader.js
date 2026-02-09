/**
 * Real Polymarket Trading Engine
 * Mirrors paperTrader.js but executes real orders via the CLOB API.
 * Has strict safety controls — will NOT trade unless explicitly enabled.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  initClobClient,
  isClobReady,
  getClobStatus,
  placeBuyOrder,
  cancelAllOrders,
  getOpenOrders,
  fetchWalletBalance,
} from '../data/polymarketClob.js';

/* ── Config ──────────────────────────────────────────── */

const STATE_FILE     = './logs/real_trader_state.json';
const TRADES_CSV     = './logs/real_trades.csv';

const REAL_ENABLED   = (process.env.REAL_TRADING_ENABLED || 'false').toLowerCase() === 'true';
const MAX_POS_USD    = Number(process.env.REAL_MAX_POSITION_USD) || 5.00;
const MAX_DAILY_LOSS = Number(process.env.REAL_MAX_DAILY_LOSS_USD) || 10.00;
const MAX_OPEN       = Number(process.env.REAL_MAX_OPEN_ORDERS) || 1;
const MIN_CONFIDENCE = 80; // Higher bar than paper (72%)

/* ── State ───────────────────────────────────────────── */

let state = null;
let sessionConfirmed = false; // UI must confirm each session
let halted = false;
let haltReason = '';

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createDefaultState() {
  return {
    enabled: REAL_ENABLED,
    currentOrder: null,        // { id, side, tokenId, price, size, cost, marketSlug, ... }
    lastSettledSlug: null,
    lastPtbDelta: null,
    dailyLoss: 0,
    dailyLossDate: new Date().toISOString().slice(0, 10),
    history: [],               // settled trades
    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      peakBalance: 0,
    },
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state = { ...createDefaultState(), ...loaded, stats: { ...createDefaultState().stats, ...(loaded.stats ?? {}) } };
      console.log(`  [real] loaded: ${state.stats.totalTrades} trades | W${state.stats.wins}/L${state.stats.losses}`);
      return;
    }
  } catch (err) { console.error(`  [real] load error: ${err.message}`); }
  state = createDefaultState();
  console.log(`  [real] initialized (enabled: ${REAL_ENABLED})`);
}

function saveState() {
  try { ensureDir(STATE_FILE); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch { /* */ }
}

/* ── CSV Log ─────────────────────────────────────────── */

function logTradeCsv(trade) {
  const header = 'timestamp,side,entry_price,shares,cost,outcome,pnl,ai_confidence,time_left,reasoning';
  const reasoning = String(trade.aiReasoning || '').replace(/,/g, ';').replace(/\n/g, ' ').slice(0, 200);
  const row = [
    trade.settledAt, trade.side, trade.entryPrice?.toFixed(4),
    trade.shares?.toFixed(4), trade.cost?.toFixed(2),
    trade.outcome, trade.pnl?.toFixed(2),
    trade.aiConfidence, trade.timeLeftAtEntry?.toFixed(1) ?? '',
    reasoning
  ].join(',');
  try {
    ensureDir(TRADES_CSV);
    if (!fs.existsSync(TRADES_CSV)) fs.writeFileSync(TRADES_CSV, header + '\n' + row + '\n', 'utf8');
    else fs.appendFileSync(TRADES_CSV, row + '\n', 'utf8');
  } catch { /* */ }
}

/* ── Daily Loss Reset ────────────────────────────────── */

function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyLossDate !== today) {
    state.dailyLoss = 0;
    state.dailyLossDate = today;
    // Un-halt if it was daily-loss related
    if (haltReason === 'daily_loss_limit') {
      halted = false;
      haltReason = '';
    }
    saveState();
  }
}

/* ── Safety Checks ───────────────────────────────────── */

function canTrade() {
  if (!REAL_ENABLED) return { ok: false, reason: 'REAL_TRADING_ENABLED is false in .env' };
  if (!sessionConfirmed) return { ok: false, reason: 'Session not confirmed from UI' };
  if (!isClobReady()) return { ok: false, reason: 'CLOB client not initialized' };
  if (halted) return { ok: false, reason: `Trading halted: ${haltReason}` };

  checkDailyReset();
  if (state.dailyLoss >= MAX_DAILY_LOSS) {
    halted = true;
    haltReason = 'daily_loss_limit';
    return { ok: false, reason: `Daily loss limit reached ($${state.dailyLoss.toFixed(2)} >= $${MAX_DAILY_LOSS.toFixed(2)})` };
  }

  return { ok: true };
}

/* ── Trade Execution ─────────────────────────────────── */

async function enterTrade(side, price, tokenId, data) {
  if (state.currentOrder) return; // already in a trade
  if (price <= 0 || price >= 1) return;

  // Cap position size
  const maxSpend = Math.min(MAX_POS_USD, price < 0.5 ? MAX_POS_USD : MAX_POS_USD * 0.5);
  const shares = Math.floor(maxSpend / price); // whole shares only for safety
  if (shares < 1) return;
  const cost = shares * price;

  console.log(`  [REAL TRADE] ENTERING ${side} | ${shares} shares @ ${(price * 100).toFixed(0)}¢ | cost $${cost.toFixed(2)}`);

  // Place the actual order
  const result = await placeBuyOrder(tokenId, price, shares, {
    tickSize: '0.01',
    negRisk: false,
  });

  if (!result.ok) {
    console.error(`  [REAL TRADE] ORDER FAILED: ${result.error}`);
    return;
  }

  state.currentOrder = {
    orderId: result.orderId,
    side,
    tokenId,
    entryPrice: price,
    shares,
    cost,
    enteredAt: new Date().toISOString(),
    marketSlug: data.marketSlug,
    aiDirection: data.aiDirection,
    aiConfidence: data.aiConfidence,
    aiReasoning: data.aiReasoning || '',
    timeLeftAtEntry: data.timeLeft,
  };

  saveState();
}

function settleTrade(outcome) {
  if (!state.currentOrder) return;
  const trade = state.currentOrder;

  let pnl = 0;
  if (outcome === 'WIN') {
    // Shares pay out $1 each on win
    pnl = trade.shares * 1.0 - trade.cost;
  } else if (outcome === 'LOSS') {
    pnl = -trade.cost;
  }
  // UNKNOWN = refund (pnl stays 0)

  const settledTrade = {
    ...trade,
    outcome,
    pnl,
    settledAt: new Date().toISOString(),
  };

  state.history.push(settledTrade);

  // Update stats
  if (outcome !== 'UNKNOWN') {
    state.stats.totalTrades += 1;
    if (outcome === 'WIN') {
      state.stats.wins += 1;
    } else {
      state.stats.losses += 1;
      state.dailyLoss += Math.abs(pnl);
    }
    state.stats.totalPnl += pnl;
  }

  state.currentOrder = null;

  const icon = outcome === 'WIN' ? '+' : outcome === 'LOSS' ? '-' : '~';
  console.log(`  [REAL TRADE] SETTLE ${outcome} | ${icon}$${Math.abs(pnl).toFixed(2)} | total P&L: $${state.stats.totalPnl.toFixed(2)}`);

  logTradeCsv(settledTrade);
  saveState();

  // Check daily loss
  if (state.dailyLoss >= MAX_DAILY_LOSS) {
    halted = true;
    haltReason = 'daily_loss_limit';
    console.log(`  [REAL TRADE] HALTED — daily loss $${state.dailyLoss.toFixed(2)} exceeds limit $${MAX_DAILY_LOSS.toFixed(2)}`);
  }
}

/* ── Main Tick ───────────────────────────────────────── */

export function initRealTrader() {
  loadState();

  if (!REAL_ENABLED) {
    console.log(`  [real] DISABLED (set REAL_TRADING_ENABLED=true in .env to enable)`);
    return;
  }

  // Start CLOB client initialization (async, non-blocking)
  initClobClient().then(ok => {
    if (ok) console.log(`  [real] CLOB client initialized — waiting for UI session confirmation`);
    else console.log(`  [real] CLOB client failed to initialize — real trading unavailable`);
  }).catch(err => {
    console.error(`  [real] CLOB init error: ${err?.message}`);
  });
}

export async function processRealTick(data) {
  if (!state) loadState();
  if (!REAL_ENABLED) return getPublicState();

  // Periodically refresh wallet balance (non-blocking)
  if (isClobReady()) {
    fetchWalletBalance().catch(() => {});
  }

  const { ai, poly, timeLeft, priceToBeat, ptbDelta, rec } = data;
  const marketSlug = poly?.slug || '';

  if (ptbDelta != null) state.lastPtbDelta = ptbDelta;

  // ── Settlement ──
  if (state.currentOrder && marketSlug && state.currentOrder.marketSlug && state.currentOrder.marketSlug !== marketSlug) {
    const delta = state.lastPtbDelta;
    if (delta != null && delta !== 0) {
      const upWon = delta > 0;
      const outcome = (state.currentOrder.side === 'UP' && upWon) || (state.currentOrder.side === 'DOWN' && !upWon) ? 'WIN' : 'LOSS';
      settleTrade(outcome);
    } else {
      settleTrade('UNKNOWN');
    }
    state.lastSettledSlug = state.currentOrder?.marketSlug ?? marketSlug;
    state.lastPtbDelta = null;
  }

  // Settle at expiry
  if (state.currentOrder && timeLeft != null && timeLeft <= 0.1 && ptbDelta != null && ptbDelta !== 0) {
    const upWon = ptbDelta > 0;
    const outcome = (state.currentOrder.side === 'UP' && upWon) || (state.currentOrder.side === 'DOWN' && !upWon) ? 'WIN' : 'LOSS';
    settleTrade(outcome);
  }

  // ── Entry ──
  const tradingCheck = canTrade();
  if (
    tradingCheck.ok &&
    !state.currentOrder &&
    ai?.enabled && ai?.analysis && poly?.ok && marketSlug && marketSlug !== state.lastSettledSlug
  ) {
    const analysis = ai.analysis;
    const confidence = analysis.confidence || 0;
    const direction = analysis.direction;

    if (
      (direction === 'UP' || direction === 'DOWN') &&
      confidence >= MIN_CONFIDENCE &&
      timeLeft != null && timeLeft >= 2 && timeLeft <= 13 &&
      poly.upPrice != null && poly.downPrice != null
    ) {
      const tokenId = direction === 'UP' ? data.tokens?.upTokenId : data.tokens?.downTokenId;
      const price = direction === 'UP' ? poly.upPrice : poly.downPrice;

      if (tokenId && price > 0 && price < 1) {
        await enterTrade(direction, price, tokenId, {
          marketSlug,
          aiDirection: direction,
          aiConfidence: confidence,
          aiReasoning: analysis.reasoning ?? '',
          timeLeft,
        });
      }
    }
  }

  return getPublicState();
}

/* ── Public State ────────────────────────────────────── */

function getPublicState() {
  if (!state) return { enabled: false, status: 'disabled' };

  const wc = state.stats.wins, lc = state.stats.losses;
  const winRate = (wc + lc) > 0 ? wc / (wc + lc) : null;

  checkDailyReset();

  const clobStatus = getClobStatus();
  return {
    enabled: REAL_ENABLED,
    clobReady: isClobReady(),
    clobStatus,
    walletAddress: clobStatus.walletAddress,
    funderAddress: clobStatus.funderAddress,
    usdcBalance: clobStatus.usdcBalance,
    sessionConfirmed,
    halted,
    haltReason,
    status: !REAL_ENABLED ? 'DISABLED' : !isClobReady() ? 'CLOB_ERROR' : !sessionConfirmed ? 'AWAITING_CONFIRM' : halted ? 'HALTED' : 'ACTIVE',
    minConfidence: MIN_CONFIDENCE,
    maxPositionUsd: MAX_POS_USD,
    maxDailyLossUsd: MAX_DAILY_LOSS,
    dailyLoss: state.dailyLoss,
    dailyLossRemaining: Math.max(0, MAX_DAILY_LOSS - state.dailyLoss),
    currentOrder: state.currentOrder ? {
      side: state.currentOrder.side,
      entryPrice: state.currentOrder.entryPrice,
      shares: state.currentOrder.shares,
      cost: state.currentOrder.cost,
      aiConfidence: state.currentOrder.aiConfidence,
      enteredAt: state.currentOrder.enteredAt,
      orderId: state.currentOrder.orderId,
    } : null,
    stats: {
      totalTrades: state.stats.totalTrades,
      wins: wc,
      losses: lc,
      winRate,
      totalPnl: state.stats.totalPnl,
    },
    recentTrades: state.history.slice(-10).reverse().map(t => ({
      side: t.side,
      entryPrice: t.entryPrice,
      outcome: t.outcome,
      pnl: t.pnl,
      aiConfidence: t.aiConfidence,
      settledAt: t.settledAt,
      cost: t.cost,
      shares: t.shares,
    })),
  };
}

/* ── Controls ────────────────────────────────────────── */

export function confirmRealSession() {
  if (!REAL_ENABLED) return { ok: false, error: 'Real trading not enabled in .env' };
  if (!isClobReady()) return { ok: false, error: 'CLOB client not ready' };
  sessionConfirmed = true;
  console.log(`  [REAL TRADE] Session CONFIRMED — real trading is now ACTIVE`);
  return { ok: true };
}

export async function killSwitch() {
  console.log(`  [REAL TRADE] KILL SWITCH activated`);
  halted = true;
  haltReason = 'kill_switch';
  sessionConfirmed = false;

  // Cancel all open orders on Polymarket
  if (isClobReady()) {
    await cancelAllOrders();
  }

  state.currentOrder = null;
  saveState();
  return getPublicState();
}

export function getRealTraderEnabled() {
  return REAL_ENABLED;
}

export function getRealState() {
  return getPublicState();
}
