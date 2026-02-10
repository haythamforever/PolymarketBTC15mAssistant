/**
 * Database query functions with file-based fallback.
 * Every function checks isDbAvailable() first; if no DB, returns null/undefined
 * so callers can fall back to their existing file-based code.
 */

import { query, isDbAvailable } from './pool.js';

/* ══════════════════════════════════════════════════════════
   USERS (replaces data/users.json)
   ══════════════════════════════════════════════════════════ */

export async function dbGetAllUsers() {
  if (!isDbAvailable()) return null;
  const { rows } = await query('SELECT id, username, hash, role, created_at FROM users ORDER BY id');
  return rows;
}

export async function dbGetUserByUsername(username) {
  if (!isDbAvailable()) return null; // null means "fallback to file"
  const { rows } = await query('SELECT id, username, hash, role FROM users WHERE username = $1', [username]);
  return rows[0] || undefined; // undefined = not found, null = no DB
}

export async function dbCreateUser(username, hash, role = 'admin') {
  if (!isDbAvailable()) return null;
  const { rows } = await query(
    'INSERT INTO users (username, hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
    [username, hash, role]
  );
  return rows[0];
}

export async function dbHasAnyUsers() {
  if (!isDbAvailable()) return null;
  const { rows } = await query('SELECT 1 FROM users LIMIT 1');
  return rows.length > 0;
}

/* ══════════════════════════════════════════════════════════
   APP CONFIG (key-value store for settings)
   ══════════════════════════════════════════════════════════ */

export async function dbGetConfig(key) {
  if (!isDbAvailable()) return null;
  const { rows } = await query('SELECT value FROM app_config WHERE key = $1', [key]);
  return rows[0]?.value ?? undefined;
}

export async function dbSetConfig(key, value) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
  return true;
}

export async function dbGetAllConfig() {
  if (!isDbAvailable()) return null;
  const { rows } = await query('SELECT key, value, updated_at FROM app_config ORDER BY key');
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

/* ══════════════════════════════════════════════════════════
   SESSION SECRET
   ══════════════════════════════════════════════════════════ */

export async function dbGetSessionSecret() {
  if (!isDbAvailable()) return null;
  const val = await dbGetConfig('session_secret');
  return typeof val === 'string' ? val : val?.secret ?? null;
}

export async function dbSetSessionSecret(secret) {
  if (!isDbAvailable()) return null;
  return dbSetConfig('session_secret', { secret });
}

/* ══════════════════════════════════════════════════════════
   PAPER STATE (singleton row, id=1)
   ══════════════════════════════════════════════════════════ */

export async function dbLoadPaperState() {
  if (!isDbAvailable()) return null;
  const { rows } = await query('SELECT * FROM paper_state WHERE id = 1');
  if (rows.length === 0) return undefined; // no state yet
  const r = rows[0];
  return {
    balance: parseFloat(r.balance),
    currentTrade: r.current_trade,
    lastSettledSlug: r.last_settled_slug,
    lastPtbDelta: r.last_ptb_delta != null ? parseFloat(r.last_ptb_delta) : null,
    martingaleLevel: r.martingale_level,
    config: r.config,
    stats: r.stats,
  };
}

export async function dbSavePaperState(state) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO paper_state (id, balance, current_trade, last_settled_slug, last_ptb_delta, martingale_level, config, stats, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       balance = $1, current_trade = $2, last_settled_slug = $3,
       last_ptb_delta = $4, martingale_level = $5, config = $6, stats = $7, updated_at = NOW()`,
    [
      state.balance,
      JSON.stringify(state.currentTrade),
      state.lastSettledSlug,
      state.lastPtbDelta,
      state.martingaleLevel,
      JSON.stringify(state.config),
      JSON.stringify(state.stats),
    ]
  );
  return true;
}

/* ══════════════════════════════════════════════════════════
   PAPER TRADES
   ══════════════════════════════════════════════════════════ */

export async function dbInsertPaperTrade(trade) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO paper_trades (
      trade_id, side, entry_price, shares, cost, outcome, pnl, balance_after,
      ai_confidence, ai_reasoning, ai_provider_id, all_predictions,
      time_left_at_entry, martingale_level, entry_snapshot, regime, signal_agreement,
      entered_at, settled_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      trade.id || trade.trade_id,
      trade.side,
      trade.entryPrice ?? trade.entry_price,
      trade.shares,
      trade.cost,
      trade.outcome,
      trade.pnl,
      trade.balanceAfter ?? trade.balance_after,
      trade.aiConfidence ?? trade.ai_confidence,
      trade.aiReasoning ?? trade.ai_reasoning,
      trade.aiProviderId ?? trade.ai_provider_id ?? 'unknown',
      JSON.stringify(trade.allPredictions ?? trade.all_predictions ?? {}),
      trade.timeLeftAtEntry ?? trade.time_left_at_entry,
      trade.martingaleLevel ?? trade.martingale_level ?? 0,
      JSON.stringify(trade.entrySnapshot ?? trade.entry_snapshot ?? null),
      trade.entrySnapshot?.regime ?? trade.regime ?? null,
      JSON.stringify(trade.entrySnapshot?.signalAgreement ?? trade.signal_agreement ?? null),
      trade.enteredAt ?? trade.entered_at,
      trade.settledAt ?? trade.settled_at ?? new Date().toISOString(),
    ]
  );
  return true;
}

export async function dbGetRecentPaperTrades(limit = 50) {
  if (!isDbAvailable()) return null;
  const { rows } = await query(
    'SELECT * FROM paper_trades ORDER BY id DESC LIMIT $1',
    [limit]
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════
   TRADE JOURNAL
   ══════════════════════════════════════════════════════════ */

export async function dbInsertJournalEntry(entry) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO trade_journal (
      trade_id, side, entry_price, cost, shares, ai_confidence, ai_reasoning,
      ai_provider_id, all_predictions, time_left_at_entry, entered_at, settled_at,
      outcome, pnl, balance_after, martingale_level, entry_snapshot, analysis
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      entry.id || entry.trade_id,
      entry.side,
      entry.entryPrice ?? entry.entry_price,
      entry.cost,
      entry.shares,
      entry.aiConfidence ?? entry.ai_confidence,
      entry.aiReasoning ?? entry.ai_reasoning,
      entry.aiProviderId ?? entry.ai_provider_id ?? 'unknown',
      JSON.stringify(entry.allPredictions ?? entry.all_predictions ?? {}),
      entry.timeLeftAtEntry ?? entry.time_left_at_entry,
      entry.enteredAt ?? entry.entered_at,
      entry.settledAt ?? entry.settled_at,
      entry.outcome,
      entry.pnl,
      entry.balanceAfter ?? entry.balance_after,
      entry.martingaleLevel ?? entry.martingale_level,
      JSON.stringify(entry.entrySnapshot ?? entry.entry_snapshot ?? null),
      JSON.stringify(entry.analysis ?? null),
    ]
  );
  return true;
}

export async function dbGetJournal(limit = 200) {
  if (!isDbAvailable()) return null;
  const { rows } = await query(
    'SELECT * FROM trade_journal ORDER BY id DESC LIMIT $1',
    [limit]
  );
  // Return in chronological order (oldest first) like the file-based journal
  return rows.reverse().map(r => ({
    id: r.trade_id,
    side: r.side,
    entryPrice: r.entry_price != null ? parseFloat(r.entry_price) : null,
    cost: r.cost != null ? parseFloat(r.cost) : null,
    shares: r.shares != null ? parseFloat(r.shares) : null,
    aiConfidence: r.ai_confidence != null ? parseFloat(r.ai_confidence) : null,
    aiReasoning: r.ai_reasoning,
    aiProviderId: r.ai_provider_id,
    allPredictions: r.all_predictions,
    timeLeftAtEntry: r.time_left_at_entry != null ? parseFloat(r.time_left_at_entry) : null,
    enteredAt: r.entered_at,
    settledAt: r.settled_at,
    outcome: r.outcome,
    pnl: r.pnl != null ? parseFloat(r.pnl) : null,
    balanceAfter: r.balance_after != null ? parseFloat(r.balance_after) : null,
    martingaleLevel: r.martingale_level,
    entrySnapshot: r.entry_snapshot,
    analysis: r.analysis,
  }));
}

/* ══════════════════════════════════════════════════════════
   AGENT LEARNINGS (singleton row, id=1)
   ══════════════════════════════════════════════════════════ */

export async function dbLoadLearnings() {
  if (!isDbAvailable()) return null;
  const { rows } = await query('SELECT data FROM agent_learnings WHERE id = 1');
  return rows.length > 0 ? rows[0].data : undefined;
}

export async function dbSaveLearnings(data) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO agent_learnings (id, data, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
    [JSON.stringify(data)]
  );
  return true;
}

/* ══════════════════════════════════════════════════════════
   REAL STATE (singleton row, id=1)
   ══════════════════════════════════════════════════════════ */

export async function dbLoadRealState() {
  if (!isDbAvailable()) return null;
  const { rows } = await query('SELECT * FROM real_state WHERE id = 1');
  if (rows.length === 0) return undefined;
  const r = rows[0];
  return {
    currentOrder: r.current_order,
    lastSettledSlug: r.last_settled_slug,
    lastPtbDelta: r.last_ptb_delta != null ? parseFloat(r.last_ptb_delta) : null,
    dailyLoss: r.daily_loss != null ? parseFloat(r.daily_loss) : 0,
    dailyLossDate: r.daily_loss_date,
    stats: r.stats || {},
  };
}

export async function dbSaveRealState(state) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO real_state (id, current_order, last_settled_slug, last_ptb_delta, daily_loss, daily_loss_date, stats, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       current_order = $1, last_settled_slug = $2, last_ptb_delta = $3,
       daily_loss = $4, daily_loss_date = $5, stats = $6, updated_at = NOW()`,
    [
      JSON.stringify(state.currentOrder),
      state.lastSettledSlug,
      state.lastPtbDelta,
      state.dailyLoss,
      state.dailyLossDate,
      JSON.stringify(state.stats),
    ]
  );
  return true;
}

/* ══════════════════════════════════════════════════════════
   REAL TRADES
   ══════════════════════════════════════════════════════════ */

export async function dbInsertRealTrade(trade) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO real_trades (
      order_id, side, token_id, entry_price, shares, cost, outcome, pnl,
      ai_confidence, ai_reasoning, market_slug, time_left_at_entry,
      entered_at, settled_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      trade.orderId ?? trade.order_id,
      trade.side,
      trade.tokenId ?? trade.token_id,
      trade.entryPrice ?? trade.entry_price,
      trade.shares,
      trade.cost,
      trade.outcome,
      trade.pnl,
      trade.aiConfidence ?? trade.ai_confidence,
      trade.aiReasoning ?? trade.ai_reasoning,
      trade.marketSlug ?? trade.market_slug,
      trade.timeLeftAtEntry ?? trade.time_left_at_entry,
      trade.enteredAt ?? trade.entered_at,
      trade.settledAt ?? trade.settled_at ?? new Date().toISOString(),
    ]
  );
  return true;
}

export async function dbGetRecentRealTrades(limit = 50) {
  if (!isDbAvailable()) return null;
  const { rows } = await query(
    'SELECT * FROM real_trades ORDER BY id DESC LIMIT $1',
    [limit]
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════
   SIGNALS
   ══════════════════════════════════════════════════════════ */

export async function dbInsertSignal(sig) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO signals (regime, signal, model_up, model_down, mkt_up, mkt_down, edge_up, edge_down, recommendation, time_left_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      sig.regime, sig.signal,
      sig.modelUp, sig.modelDown,
      sig.mktUp, sig.mktDown,
      sig.edgeUp, sig.edgeDown,
      sig.recommendation,
      sig.timeLeftMin,
    ]
  );
  return true;
}

/* ══════════════════════════════════════════════════════════
   CLOB ORDERS
   ══════════════════════════════════════════════════════════ */

export async function dbInsertClobOrder(entry) {
  if (!isDbAvailable()) return null;
  await query(
    `INSERT INTO clob_orders (action, token_id, price, size, order_id, error, response)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.action,
      entry.tokenId ?? entry.token_id,
      entry.price,
      entry.size,
      entry.orderId ?? entry.order_id ?? entry.orderId,
      entry.error,
      JSON.stringify(entry.response ?? null),
    ]
  );
  return true;
}

/* ══════════════════════════════════════════════════════════
   SETTINGS (for the UI settings page)
   ══════════════════════════════════════════════════════════ */

export async function dbGetSettings() {
  if (!isDbAvailable()) return null;
  return dbGetAllConfig();
}

export async function dbSaveSettings(settings) {
  if (!isDbAvailable()) return null;
  for (const [key, value] of Object.entries(settings)) {
    await dbSetConfig(key, value);
  }
  return true;
}
