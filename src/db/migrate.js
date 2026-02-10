/**
 * Auto-migration: creates tables if they don't exist.
 * Run on startup after pool is initialized.
 */

import { query, isDbAvailable } from './pool.js';

const MIGRATIONS = [
  // Users
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    role VARCHAR(20) DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // App config (key-value JSONB store)
  `CREATE TABLE IF NOT EXISTS app_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Paper trades
  `CREATE TABLE IF NOT EXISTS paper_trades (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(50),
    side VARCHAR(10) NOT NULL,
    entry_price NUMERIC(10,6),
    shares NUMERIC(10,4),
    cost NUMERIC(10,4),
    outcome VARCHAR(10),
    pnl NUMERIC(10,4),
    balance_after NUMERIC(10,4),
    ai_confidence NUMERIC(5,1),
    ai_reasoning TEXT,
    ai_provider_id VARCHAR(50),
    all_predictions JSONB,
    time_left_at_entry NUMERIC(6,2),
    martingale_level INT DEFAULT 0,
    entry_snapshot JSONB,
    regime VARCHAR(50),
    signal_agreement JSONB,
    entered_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Paper trader state (singleton row)
  `CREATE TABLE IF NOT EXISTS paper_state (
    id INT PRIMARY KEY DEFAULT 1,
    balance NUMERIC(10,4) DEFAULT 100,
    current_trade JSONB,
    last_settled_slug TEXT,
    last_ptb_delta NUMERIC(12,4),
    martingale_level INT DEFAULT 0,
    config JSONB NOT NULL DEFAULT '{}',
    stats JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Trade journal (detailed entries with analysis)
  `CREATE TABLE IF NOT EXISTS trade_journal (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(50),
    side VARCHAR(10),
    entry_price NUMERIC(10,6),
    cost NUMERIC(10,4),
    shares NUMERIC(10,4),
    ai_confidence NUMERIC(5,1),
    ai_reasoning TEXT,
    ai_provider_id VARCHAR(50),
    all_predictions JSONB,
    time_left_at_entry NUMERIC(6,2),
    entered_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    outcome VARCHAR(10),
    pnl NUMERIC(10,4),
    balance_after NUMERIC(10,4),
    martingale_level INT,
    entry_snapshot JSONB,
    analysis JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Agent learnings (singleton row with JSONB blob)
  `CREATE TABLE IF NOT EXISTS agent_learnings (
    id INT PRIMARY KEY DEFAULT 1,
    data JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Real trades
  `CREATE TABLE IF NOT EXISTS real_trades (
    id SERIAL PRIMARY KEY,
    order_id TEXT,
    side VARCHAR(10) NOT NULL,
    token_id TEXT,
    entry_price NUMERIC(10,6),
    shares NUMERIC(10,4),
    cost NUMERIC(10,4),
    outcome VARCHAR(10),
    pnl NUMERIC(10,4),
    ai_confidence NUMERIC(5,1),
    ai_reasoning TEXT,
    market_slug TEXT,
    time_left_at_entry NUMERIC(6,2),
    entered_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Real trader state (singleton row)
  `CREATE TABLE IF NOT EXISTS real_state (
    id INT PRIMARY KEY DEFAULT 1,
    current_order JSONB,
    last_settled_slug TEXT,
    last_ptb_delta NUMERIC(12,4),
    daily_loss NUMERIC(10,4) DEFAULT 0,
    daily_loss_date DATE DEFAULT CURRENT_DATE,
    stats JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Signals log
  `CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    regime VARCHAR(50),
    signal VARCHAR(20),
    model_up NUMERIC(6,4),
    model_down NUMERIC(6,4),
    mkt_up NUMERIC(6,4),
    mkt_down NUMERIC(6,4),
    edge_up NUMERIC(6,4),
    edge_down NUMERIC(6,4),
    recommendation TEXT,
    time_left_min NUMERIC(6,3),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // CLOB order log
  `CREATE TABLE IF NOT EXISTS clob_orders (
    id SERIAL PRIMARY KEY,
    action VARCHAR(20),
    token_id TEXT,
    price NUMERIC(10,6),
    size NUMERIC(10,4),
    order_id TEXT,
    error TEXT,
    response JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // connect-pg-simple session table
  `CREATE TABLE IF NOT EXISTS session (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire)`,
];

export async function runMigrations() {
  if (!isDbAvailable()) return;

  console.log('  [db] running migrations...');
  for (const sql of MIGRATIONS) {
    try {
      await query(sql);
    } catch (err) {
      console.error(`  [db] migration error: ${err.message}`);
      console.error(`  [db] SQL: ${sql.slice(0, 80)}...`);
    }
  }
  console.log(`  [db] ${MIGRATIONS.length} migrations complete`);
}
