/**
 * Real Polymarket Trading Engine
 * Mirrors paperTrader.js but executes real orders via the CLOB API.
 * Has strict safety controls — will NOT trade unless explicitly enabled.
 * Supports martingale position sizing (optional).
 * Config can be updated at runtime via the settings page (DB).
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
import { dbLoadRealState, dbSaveRealState, dbInsertRealTrade, dbGetConfig } from '../db/queries.js';

/* ── Config (mutable — can be updated from settings page) ── */

const STATE_FILE     = './logs/real_trader_state.json';
const TRADES_CSV     = './logs/real_trades.csv';

let config = {
  enabled:        (process.env.REAL_TRADING_ENABLED || 'false').toLowerCase() === 'true',
  maxPositionUsd: Number(process.env.REAL_MAX_POSITION_USD) || 5.00,
  maxDailyLossUsd: Number(process.env.REAL_MAX_DAILY_LOSS_USD) || 10.00,
  maxOpenOrders:  Number(process.env.REAL_MAX_OPEN_ORDERS) || 1,
  minConfidence:  80,
  martingale: {
    enabled: false,
    multiplier: 1.5,
    maxLevel: 3,
    maxPositionUsd: 10.00, // hard cap USD per trade
  },
};

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
    enabled: config.enabled,
    currentOrder: null,
    lastSettledSlug: null,
    lastPtbDelta: null,
    dailyLoss: 0,
    dailyLossDate: new Date().toISOString().slice(0, 10),
    martingaleLevel: 0,
    history: [],
    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      peakBalance: 0,
    },
  };
}

/* ── State Persistence ────────────────────────────────── */

async function loadState() {
  // Try DB first
  try {
    const dbState = await dbLoadRealState();
    if (dbState && dbState !== undefined) {
      state = {
        ...createDefaultState(),
        currentOrder: dbState.currentOrder,
        lastSettledSlug: dbState.lastSettledSlug,
        lastPtbDelta: dbState.lastPtbDelta,
        dailyLoss: dbState.dailyLoss ?? 0,
        dailyLossDate: dbState.dailyLossDate ?? new Date().toISOString().slice(0, 10),
        martingaleLevel: dbState.stats?.martingaleLevel ?? 0,
        stats: { ...createDefaultState().stats, ...(dbState.stats ?? {}) },
        history: [],
      };
      console.log(`  [real] loaded (DB): ${state.stats.totalTrades} trades | W${state.stats.wins}/L${state.stats.losses}`);
      return;
    }
  } catch (err) { console.error(`  [real] DB load error, trying file: ${err.message}`); }

  // File-based fallback
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state = { ...createDefaultState(), ...loaded, stats: { ...createDefaultState().stats, ...(loaded.stats ?? {}) } };
      console.log(`  [real] loaded (file): ${state.stats.totalTrades} trades | W${state.stats.wins}/L${state.stats.losses}`);
      return;
    }
  } catch (err) { console.error(`  [real] load error: ${err.message}`); }
  state = createDefaultState();
  console.log(`  [real] initialized (enabled: ${config.enabled})`);
}

function saveState() {
  // Include martingaleLevel in stats for DB persistence
  const stateForDb = {
    ...state,
    stats: { ...state.stats, martingaleLevel: state.martingaleLevel },
  };
  dbSaveRealState(stateForDb).catch(() => {});
  try { ensureDir(STATE_FILE); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch { /* */ }
}

/* ── CSV Log ─────────────────────────────────────────── */

function logTradeCsv(trade) {
  dbInsertRealTrade(trade).catch(() => {});

  const header = 'timestamp,side,entry_price,shares,cost,outcome,pnl,ai_confidence,time_left,mg_level,reasoning';
  const reasoning = String(trade.aiReasoning || '').replace(/,/g, ';').replace(/\n/g, ' ').slice(0, 200);
  const row = [
    trade.settledAt, trade.side, trade.entryPrice?.toFixed(4),
    trade.shares?.toFixed(4), trade.cost?.toFixed(2),
    trade.outcome, trade.pnl?.toFixed(2),
    trade.aiConfidence, trade.timeLeftAtEntry?.toFixed(1) ?? '',
    trade.martingaleLevel ?? 0,
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
    if (haltReason === 'daily_loss_limit') {
      halted = false;
      haltReason = '';
    }
    saveState();
  }
}

/* ── Safety Checks ───────────────────────────────────── */

function canTrade() {
  if (!config.enabled) return { ok: false, reason: 'REAL_TRADING_ENABLED is false' };
  if (!sessionConfirmed) return { ok: false, reason: 'Session not confirmed from UI' };
  if (!isClobReady()) return { ok: false, reason: 'CLOB client not initialized' };
  if (halted) return { ok: false, reason: `Trading halted: ${haltReason}` };

  checkDailyReset();
  if (state.dailyLoss >= config.maxDailyLossUsd) {
    halted = true;
    haltReason = 'daily_loss_limit';
    return { ok: false, reason: `Daily loss limit reached ($${state.dailyLoss.toFixed(2)} >= $${config.maxDailyLossUsd.toFixed(2)})` };
  }

  return { ok: true };
}

/* ── Martingale ─────────────────────────────────────── */

function getEffectiveMaxSpend() {
  let base = config.maxPositionUsd;
  if (!config.martingale.enabled) return base;
  const { multiplier, maxLevel, maxPositionUsd: cap } = config.martingale;
  const level = Math.min(state.martingaleLevel ?? 0, maxLevel);
  return Math.min(base * Math.pow(multiplier, level), cap);
}

/* ── Trade Execution ─────────────────────────────────── */

async function enterTrade(side, price, tokenId, data) {
  if (state.currentOrder) return;
  if (price <= 0 || price >= 1) return;

  const maxSpend = getEffectiveMaxSpend();
  const shares = Math.floor(maxSpend / price);
  if (shares < 1) return;
  const cost = shares * price;

  const mgTag = config.martingale.enabled ? ` [MG:${state.martingaleLevel}]` : '';
  console.log(`  [REAL TRADE] ENTERING ${side} | ${shares} shares @ ${(price * 100).toFixed(0)}¢ | cost $${cost.toFixed(2)}${mgTag}`);

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
    martingaleLevel: state.martingaleLevel,
  };

  saveState();
}

function settleTrade(outcome) {
  if (!state.currentOrder) return;
  const trade = state.currentOrder;

  let pnl = 0;
  if (outcome === 'WIN') {
    pnl = trade.shares * 1.0 - trade.cost;
  } else if (outcome === 'LOSS') {
    pnl = -trade.cost;
  }

  const settledTrade = {
    ...trade,
    outcome,
    pnl,
    settledAt: new Date().toISOString(),
  };

  state.history.push(settledTrade);

  if (outcome !== 'UNKNOWN') {
    state.stats.totalTrades += 1;
    if (outcome === 'WIN') {
      state.stats.wins += 1;
      // Martingale: reset on win
      state.martingaleLevel = 0;
    } else {
      state.stats.losses += 1;
      state.dailyLoss += Math.abs(pnl);
      // Martingale: increase level on loss
      if (config.martingale.enabled) {
        state.martingaleLevel = Math.min(
          (state.martingaleLevel ?? 0) + 1,
          config.martingale.maxLevel
        );
      }
    }
    state.stats.totalPnl += pnl;
  }

  state.currentOrder = null;

  const icon = outcome === 'WIN' ? '+' : outcome === 'LOSS' ? '-' : '~';
  const mgTag = config.martingale.enabled ? ` | MG→${state.martingaleLevel}` : '';
  console.log(`  [REAL TRADE] SETTLE ${outcome} | ${icon}$${Math.abs(pnl).toFixed(2)} | total P&L: $${state.stats.totalPnl.toFixed(2)}${mgTag}`);

  logTradeCsv(settledTrade);
  saveState();

  if (state.dailyLoss >= config.maxDailyLossUsd) {
    halted = true;
    haltReason = 'daily_loss_limit';
    console.log(`  [REAL TRADE] HALTED — daily loss $${state.dailyLoss.toFixed(2)} exceeds limit $${config.maxDailyLossUsd.toFixed(2)}`);
  }
}

/* ── Settings (can be called at runtime from settings page) ── */

export function applyRealSettings(s) {
  if (!s || typeof s !== 'object') return;
  if (s.enabled != null) config.enabled = !!s.enabled;
  if (s.maxPositionUsd != null) config.maxPositionUsd = Number(s.maxPositionUsd);
  if (s.maxDailyLossUsd != null) config.maxDailyLossUsd = Number(s.maxDailyLossUsd);
  if (s.maxOpenOrders != null) config.maxOpenOrders = Number(s.maxOpenOrders);
  if (s.minConfidence != null) config.minConfidence = Number(s.minConfidence);
  if (s.martingale && typeof s.martingale === 'object') {
    if (s.martingale.enabled != null) config.martingale.enabled = !!s.martingale.enabled;
    if (s.martingale.multiplier != null) config.martingale.multiplier = Number(s.martingale.multiplier);
    if (s.martingale.maxLevel != null) config.martingale.maxLevel = Number(s.martingale.maxLevel);
    if (s.martingale.maxPositionUsd != null) config.martingale.maxPositionUsd = Number(s.martingale.maxPositionUsd);
  }
  console.log(`  [real] config updated: maxPos=$${config.maxPositionUsd} maxLoss=$${config.maxDailyLossUsd} minConf=${config.minConfidence}% MG=${config.martingale.enabled ? 'ON' : 'OFF'}`);
}

async function loadConfigFromDb() {
  try {
    const dbCfg = await dbGetConfig('real_config');
    if (dbCfg) {
      applyRealSettings(dbCfg);
    }
  } catch { /* ignore — use env defaults */ }
}

export function toggleRealMartingale() {
  config.martingale.enabled = !config.martingale.enabled;
  if (!config.martingale.enabled && state) state.martingaleLevel = 0;
  console.log(`  [real] martingale ${config.martingale.enabled ? 'ENABLED' : 'DISABLED'}`);
  if (state) saveState();
  return getPublicState();
}

/* ── Main Tick ───────────────────────────────────────── */

export async function initRealTrader() {
  await loadConfigFromDb();
  await loadState();

  if (!config.enabled) {
    console.log(`  [real] DISABLED (set REAL_TRADING_ENABLED=true in .env to enable)`);
    return;
  }

  initClobClient().then(ok => {
    if (ok) console.log(`  [real] CLOB client initialized — waiting for UI session confirmation`);
    else console.log(`  [real] CLOB client failed to initialize — real trading unavailable`);
  }).catch(err => {
    console.error(`  [real] CLOB init error: ${err?.message}`);
  });
}

export async function processRealTick(data) {
  if (!state) {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const loaded = JSON.parse(raw);
        state = { ...createDefaultState(), ...loaded, stats: { ...createDefaultState().stats, ...(loaded.stats ?? {}) } };
      } else { state = createDefaultState(); }
    } catch { state = createDefaultState(); }
  }
  if (!config.enabled) return getPublicState();

  if (isClobReady()) {
    fetchWalletBalance().catch(() => {});
  }

  // Auto-clean phantom orders
  if (state.currentOrder && !state.currentOrder.orderId) {
    console.log(`  [real] clearing phantom order (no orderId)`);
    state.currentOrder = null;
    saveState();
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
      confidence >= config.minConfidence &&
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
    enabled: config.enabled,
    clobReady: isClobReady(),
    clobStatus,
    walletAddress: clobStatus.walletAddress,
    funderAddress: clobStatus.funderAddress,
    usdcBalance: clobStatus.usdcBalance,
    sessionConfirmed,
    halted,
    haltReason,
    status: !config.enabled ? 'DISABLED' : !isClobReady() ? 'CLOB_ERROR' : !sessionConfirmed ? 'AWAITING_CONFIRM' : halted ? 'HALTED' : 'ACTIVE',
    minConfidence: config.minConfidence,
    maxPositionUsd: config.maxPositionUsd,
    maxDailyLossUsd: config.maxDailyLossUsd,
    dailyLoss: state.dailyLoss,
    dailyLossRemaining: Math.max(0, config.maxDailyLossUsd - state.dailyLoss),
    martingale: {
      enabled: config.martingale.enabled,
      level: state.martingaleLevel ?? 0,
      multiplier: config.martingale.multiplier,
      maxLevel: config.martingale.maxLevel,
      maxPositionUsd: config.martingale.maxPositionUsd,
      effectiveMaxSpend: getEffectiveMaxSpend(),
    },
    currentOrder: state.currentOrder ? {
      side: state.currentOrder.side,
      entryPrice: state.currentOrder.entryPrice,
      shares: state.currentOrder.shares,
      cost: state.currentOrder.cost,
      aiConfidence: state.currentOrder.aiConfidence,
      enteredAt: state.currentOrder.enteredAt,
      orderId: state.currentOrder.orderId,
      martingaleLevel: state.currentOrder.martingaleLevel,
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
      martingaleLevel: t.martingaleLevel ?? 0,
    })),
  };
}

/* ── Controls ────────────────────────────────────────── */

export function confirmRealSession() {
  if (!config.enabled) return { ok: false, error: 'Real trading not enabled' };
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

  if (isClobReady()) {
    await cancelAllOrders();
  }

  state.currentOrder = null;
  saveState();
  return getPublicState();
}

export function getRealTraderEnabled() {
  return config.enabled;
}

export function getRealState() {
  return getPublicState();
}
