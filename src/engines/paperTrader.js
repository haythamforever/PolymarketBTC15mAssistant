import fs from 'node:fs';
import path from 'node:path';
import {
  dbLoadPaperState, dbSavePaperState,
  dbGetJournal, dbInsertJournalEntry,
  dbInsertPaperTrade,
  dbLoadLearnings, dbSaveLearnings,
  dbGetConfig,
} from '../db/queries.js';

const STATE_FILE  = './logs/paper_trader_state.json';
const TRADES_CSV  = './logs/paper_trades.csv';
const JOURNAL_FILE = './logs/trade_journal.json';
const LEARN_FILE   = './logs/agent_learnings.json';

const MAX_JOURNAL = 200;   // keep last N trades in journal

const DEFAULT_CONFIG = {
  initialBalance: 100,
  positionSizePct: 0.03,       // 3% max risk per trade — protect capital
  minAiConfidence: 72,          // higher bar to enter — only high-conviction trades
  minEntryTimeLeft: 2,
  maxEntryTimeLeft: 13,
  learningWindow: 20,
  maxDrawdownHalt: 0.15,        // STOP trading if 15% of initial capital is lost
  martingale: {
    enabled: false,
    multiplier: 1.5,            // gentler martingale (was 2x)
    maxLevel: 3,                // max 3 levels (was 4)
    maxPositionPct: 0.10,       // hard cap 10% of balance (was 50%)
  },
};

let state = null;
let journal = [];        // detailed trade journal (full snapshots)
let learnings = null;    // computed learning insights

/* ── Utility ──────────────────────────────────────────── */

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/* ── State Persistence ────────────────────────────────── */

function createDefaultState() {
  return {
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    balance: DEFAULT_CONFIG.initialBalance,
    currentTrade: null,
    lastSettledSlug: null,
    lastPtbDelta: null,
    martingaleLevel: 0,
    history: [],
    stats: {
      totalTrades: 0, wins: 0, losses: 0,
      totalPnl: 0, peakBalance: DEFAULT_CONFIG.initialBalance, streak: 0,
    },
  };
}

async function loadState() {
  // Try DB first
  try {
    const dbState = await dbLoadPaperState();
    if (dbState && dbState !== undefined) {
      state = {
        ...createDefaultState(),
        balance: dbState.balance,
        currentTrade: dbState.currentTrade,
        lastSettledSlug: dbState.lastSettledSlug,
        lastPtbDelta: dbState.lastPtbDelta,
        martingaleLevel: dbState.martingaleLevel ?? 0,
        config: deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), dbState.config ?? {}),
        stats: { ...createDefaultState().stats, ...(dbState.stats ?? {}) },
        history: [], // history is in paper_trades table
      };
      console.log(`  [paper] loaded (DB): $${state.balance.toFixed(2)} | ${state.stats.totalTrades} trades | W${state.stats.wins}/L${state.stats.losses}`);
      return;
    }
  } catch (err) { console.error(`  [paper] DB load error, trying file: ${err.message}`); }

  // File-based fallback
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state = {
        ...createDefaultState(), ...loaded,
        config: deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), loaded.config ?? {}),
        stats: { ...createDefaultState().stats, ...(loaded.stats ?? {}) },
      };
      console.log(`  [paper] loaded (file): $${state.balance.toFixed(2)} | ${state.stats.totalTrades} trades | W${state.stats.wins}/L${state.stats.losses}`);
      return;
    }
  } catch (err) { console.error(`  [paper] load error: ${err.message}`); }
  state = createDefaultState();
  console.log(`  [paper] initialized: $${state.balance.toFixed(2)}`);
}

function saveState() {
  // Fire-and-forget DB save
  dbSavePaperState(state).catch(() => {});
  // File-based fallback (always keep as backup)
  try { ensureDir(STATE_FILE); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch { /* */ }
}

/* ── Trade Journal ────────────────────────────────────── */

async function loadJournal() {
  // Try DB first
  try {
    const dbJournal = await dbGetJournal(MAX_JOURNAL);
    if (dbJournal !== null) {
      journal = dbJournal;
      console.log(`  [paper] journal (DB): ${journal.length} entries loaded`);
      return;
    }
  } catch (err) { console.error(`  [paper] DB journal load error: ${err.message}`); }

  // File-based fallback
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
      if (!Array.isArray(journal)) journal = [];
      console.log(`  [paper] journal (file): ${journal.length} entries loaded`);
      return;
    }
  } catch { /* */ }
  journal = [];
}

function saveJournal() {
  try {
    ensureDir(JOURNAL_FILE);
    // Keep only last N entries
    if (journal.length > MAX_JOURNAL) journal = journal.slice(-MAX_JOURNAL);
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2), 'utf8');
  } catch { /* */ }
}

function appendJournalEntry(entry) {
  journal.push(entry);
  // Insert into DB (fire-and-forget)
  dbInsertJournalEntry(entry).catch(() => {});
  saveJournal();
}

/* ── CSV Log ──────────────────────────────────────────── */

function logTradeCsv(trade) {
  const header = 'timestamp,side,entry_price,shares,cost,outcome,pnl,balance_after,ai_confidence,time_left,mg_level,regime,signal_agreement,ai_reasoning';
  const reasoning = String(trade.aiReasoning || '').replace(/,/g, ';').replace(/\n/g, ' ').slice(0, 200);
  const row = [
    trade.settledAt, trade.side, trade.entryPrice.toFixed(4),
    trade.shares.toFixed(4), trade.cost.toFixed(2),
    trade.outcome, trade.pnl.toFixed(2), trade.balanceAfter.toFixed(2),
    trade.aiConfidence, trade.timeLeftAtEntry?.toFixed(1) ?? '',
    trade.martingaleLevel ?? 0,
    trade.entrySnapshot?.regime ?? '',
    trade.entrySnapshot?.signalAgreement?.direction ?? '',
    reasoning
  ].join(',');
  // Insert into DB (fire-and-forget)
  dbInsertPaperTrade(trade).catch(() => {});
  // File-based fallback
  try {
    ensureDir(TRADES_CSV);
    if (!fs.existsSync(TRADES_CSV)) fs.writeFileSync(TRADES_CSV, header + '\n' + row + '\n', 'utf8');
    else fs.appendFileSync(TRADES_CSV, row + '\n', 'utf8');
  } catch { /* */ }
}

/* ── Post-Trade Analysis ──────────────────────────────── */

function analyzeOutcome(trade) {
  const snap = trade.entrySnapshot;
  if (!snap) return null;

  // Determine what actually happened: UP won or DOWN won
  const upWon = trade.outcome === 'WIN' ? trade.side === 'UP' : trade.side === 'DOWN';

  // For each indicator, check if its signal at entry matched the outcome
  const indicators = {};

  // RSI
  if (snap.rsi != null) {
    const bullish = snap.rsi > 55;
    const bearish = snap.rsi < 45;
    const hadSignal = bullish || bearish;
    indicators.rsi = { value: snap.rsi, signal: bullish ? 'BULL' : bearish ? 'BEAR' : 'NEUTRAL', correct: hadSignal ? (bullish === upWon) : null };
  }

  // MACD
  if (snap.macdLabel) {
    const bullish = snap.macdLabel.includes('bullish');
    const bearish = snap.macdLabel.includes('bearish');
    indicators.macd = { signal: bullish ? 'BULL' : bearish ? 'BEAR' : 'NEUTRAL', correct: (bullish || bearish) ? (bullish === upWon) : null };
  }

  // VWAP distance
  if (snap.vwapDist != null) {
    const bullish = snap.vwapDist > 0.001;
    const bearish = snap.vwapDist < -0.001;
    indicators.vwap = { signal: bullish ? 'BULL' : bearish ? 'BEAR' : 'NEUTRAL', correct: (bullish || bearish) ? (bullish === upWon) : null };
  }

  // EMA Cross
  if (snap.emaCross) {
    const bullish = snap.emaCross.signal === 'BULLISH';
    indicators.emaCross = { signal: snap.emaCross.signal, correct: bullish === upWon };
  }

  // Bollinger %B
  if (snap.bollinger) {
    const bullish = snap.bollinger.pctB > 0.6;
    const bearish = snap.bollinger.pctB < 0.4;
    indicators.bollinger = { value: snap.bollinger.pctB, signal: bullish ? 'BULL' : bearish ? 'BEAR' : 'NEUTRAL', correct: (bullish || bearish) ? (bullish === upWon) : null };
  }

  // Stochastic
  if (snap.stochastic) {
    const bullish = snap.stochastic.k > 60;
    const bearish = snap.stochastic.k < 40;
    indicators.stochastic = { value: snap.stochastic.k, signal: bullish ? 'BULL' : bearish ? 'BEAR' : 'NEUTRAL', correct: (bullish || bearish) ? (bullish === upWon) : null };
  }

  // OBV
  if (snap.obvTrend) {
    const bullish = snap.obvTrend.trend === 'RISING';
    const bearish = snap.obvTrend.trend === 'FALLING';
    indicators.obv = { signal: snap.obvTrend.trend, correct: (bullish || bearish) ? (bullish === upWon) : null };
  }

  // Heiken Ashi
  if (snap.heikenColor) {
    const bullish = snap.heikenColor === 'green';
    indicators.heikenAshi = { signal: snap.heikenColor, correct: bullish === upWon };
  }

  // Signal Agreement
  const agreement = snap.signalAgreement;
  const agreementCorrect = agreement ? (agreement.direction === 'BULLISH') === upWon : null;

  return {
    indicators,
    signalAgreement: agreement,
    agreementCorrect,
    regime: snap.regime,
    timeLeftAtEntry: trade.timeLeftAtEntry,
    aiConfidence: trade.aiConfidence,
    aiDirection: trade.side,
    actualDirection: upWon ? 'UP' : 'DOWN',
    outcome: trade.outcome,
    pnl: trade.pnl,
  };
}

/* ── Learning Engine ──────────────────────────────────── */

function computeLearnings() {
  const analyzed = journal.filter(j => j.analysis && (j.outcome === 'WIN' || j.outcome === 'LOSS'));
  if (analyzed.length < 3) {
    learnings = { ready: false, totalAnalyzed: analyzed.length, message: 'Need at least 3 settled trades to generate insights' };
    saveLearnings();
    return;
  }

  const wins = analyzed.filter(j => j.outcome === 'WIN');
  const losses = analyzed.filter(j => j.outcome === 'LOSS');

  // ── Indicator accuracy ──
  const indStats = {};
  for (const entry of analyzed) {
    for (const [name, data] of Object.entries(entry.analysis.indicators || {})) {
      if (data.correct == null) continue;
      if (!indStats[name]) indStats[name] = { correct: 0, wrong: 0, total: 0 };
      indStats[name].total++;
      if (data.correct) indStats[name].correct++;
      else indStats[name].wrong++;
    }
  }
  const indicatorAccuracy = {};
  for (const [name, s] of Object.entries(indStats)) {
    indicatorAccuracy[name] = {
      accuracy: s.total > 0 ? +(s.correct / s.total).toFixed(3) : null,
      correct: s.correct, wrong: s.wrong, total: s.total,
    };
  }
  // Sort by accuracy
  const sortedIndicators = Object.entries(indicatorAccuracy)
    .filter(([, v]) => v.total >= 2)
    .sort((a, b) => (b[1].accuracy ?? 0) - (a[1].accuracy ?? 0));
  const bestIndicators = sortedIndicators.slice(0, 3).map(([n, v]) => ({ name: n, accuracy: v.accuracy }));
  const worstIndicators = sortedIndicators.slice(-3).reverse().map(([n, v]) => ({ name: n, accuracy: v.accuracy }));

  // ── Regime performance ──
  const regimeStats = {};
  for (const entry of analyzed) {
    const regime = entry.analysis.regime || 'UNKNOWN';
    if (!regimeStats[regime]) regimeStats[regime] = { wins: 0, losses: 0 };
    if (entry.outcome === 'WIN') regimeStats[regime].wins++;
    else regimeStats[regime].losses++;
  }
  const regimePerformance = {};
  for (const [regime, s] of Object.entries(regimeStats)) {
    const total = s.wins + s.losses;
    regimePerformance[regime] = { wins: s.wins, losses: s.losses, winRate: total > 0 ? +(s.wins / total).toFixed(2) : null };
  }

  // ── Confidence calibration ──
  const winConfidences = wins.map(w => w.analysis.aiConfidence).filter(c => c != null);
  const lossConfidences = losses.map(l => l.analysis.aiConfidence).filter(c => c != null);
  const avgWinConf = winConfidences.length > 0 ? +(winConfidences.reduce((a, b) => a + b, 0) / winConfidences.length).toFixed(1) : null;
  const avgLossConf = lossConfidences.length > 0 ? +(lossConfidences.reduce((a, b) => a + b, 0) / lossConfidences.length).toFixed(1) : null;

  // ── Time window analysis ──
  const timeStats = { early: { w: 0, l: 0 }, mid: { w: 0, l: 0 }, late: { w: 0, l: 0 } };
  for (const entry of analyzed) {
    const t = entry.analysis.timeLeftAtEntry;
    const bucket = t > 10 ? 'early' : t > 5 ? 'mid' : 'late';
    if (entry.outcome === 'WIN') timeStats[bucket].w++;
    else timeStats[bucket].l++;
  }
  const timePerformance = {};
  for (const [bucket, s] of Object.entries(timeStats)) {
    const total = s.w + s.l;
    timePerformance[bucket] = { wins: s.w, losses: s.l, winRate: total > 0 ? +(s.w / total).toFixed(2) : null, total };
  }

  // ── Signal agreement analysis ──
  const highAgreeTrades = analyzed.filter(e => e.analysis.signalAgreement?.strength >= 0.6);
  const lowAgreeTrades = analyzed.filter(e => e.analysis.signalAgreement?.strength < 0.5);
  const highAgreeWinRate = highAgreeTrades.length > 0
    ? +(highAgreeTrades.filter(e => e.outcome === 'WIN').length / highAgreeTrades.length).toFixed(2)
    : null;
  const lowAgreeWinRate = lowAgreeTrades.length > 0
    ? +(lowAgreeTrades.filter(e => e.outcome === 'WIN').length / lowAgreeTrades.length).toFixed(2)
    : null;

  // ── Recent performance (improvement tracking) ──
  const recent5 = analyzed.slice(-5);
  const recent5WinRate = recent5.length > 0
    ? +(recent5.filter(e => e.outcome === 'WIN').length / recent5.length).toFixed(2)
    : null;
  const older = analyzed.slice(0, -5);
  const olderWinRate = older.length > 0
    ? +(older.filter(e => e.outcome === 'WIN').length / older.length).toFixed(2)
    : null;

  // ── Auto-generate lessons ──
  const lessons = [];

  if (bestIndicators.length > 0 && bestIndicators[0].accuracy >= 0.6) {
    lessons.push(`Most reliable indicator: ${bestIndicators[0].name} (${(bestIndicators[0].accuracy * 100).toFixed(0)}% accuracy). Weight its signal heavily.`);
  }
  if (worstIndicators.length > 0 && worstIndicators[0].accuracy != null && worstIndicators[0].accuracy < 0.45) {
    lessons.push(`Least reliable: ${worstIndicators[0].name} (${(worstIndicators[0].accuracy * 100).toFixed(0)}%). Consider discounting this signal.`);
  }

  for (const [regime, perf] of Object.entries(regimePerformance)) {
    if (perf.winRate != null && perf.winRate < 0.35 && (perf.wins + perf.losses) >= 2) {
      lessons.push(`Avoid ${regime} regime — only ${(perf.winRate * 100).toFixed(0)}% win rate over ${perf.wins + perf.losses} trades.`);
    }
    if (perf.winRate != null && perf.winRate > 0.7 && (perf.wins + perf.losses) >= 2) {
      lessons.push(`${regime} regime is strong — ${(perf.winRate * 100).toFixed(0)}% win rate. Favor entries here.`);
    }
  }

  if (avgWinConf != null && avgLossConf != null && avgWinConf > avgLossConf + 5) {
    lessons.push(`Wins average ${avgWinConf}% confidence vs losses at ${avgLossConf}%. Higher confidence correlates with success.`);
  }

  if (highAgreeWinRate != null && highAgreeWinRate > 0.6) {
    lessons.push(`High signal agreement (>60%) trades have ${(highAgreeWinRate * 100).toFixed(0)}% win rate — prefer strong consensus.`);
  }
  if (lowAgreeWinRate != null && lowAgreeWinRate < 0.4) {
    lessons.push(`Low signal agreement (<50%) trades have only ${(lowAgreeWinRate * 100).toFixed(0)}% win rate — avoid mixed signals.`);
  }

  for (const [bucket, perf] of Object.entries(timePerformance)) {
    if (perf.total >= 2 && perf.winRate != null) {
      if (perf.winRate >= 0.7) lessons.push(`${bucket.toUpperCase()} window entries (${bucket === 'late' ? '<5min' : bucket === 'mid' ? '5-10min' : '>10min'}) perform well: ${(perf.winRate * 100).toFixed(0)}% win rate.`);
      if (perf.winRate < 0.35) lessons.push(`${bucket.toUpperCase()} window entries perform poorly: ${(perf.winRate * 100).toFixed(0)}% win rate. Adjust timing.`);
    }
  }

  if (recent5WinRate != null && olderWinRate != null) {
    if (recent5WinRate > olderWinRate + 0.1) lessons.push(`Improving: recent win rate ${(recent5WinRate * 100).toFixed(0)}% vs earlier ${(olderWinRate * 100).toFixed(0)}%.`);
    else if (recent5WinRate < olderWinRate - 0.1) lessons.push(`Performance declining: recent ${(recent5WinRate * 100).toFixed(0)}% vs earlier ${(olderWinRate * 100).toFixed(0)}%. Review strategy.`);
  }

  // ── Model comparison ──
  const modelStats = {};
  for (const entry of analyzed) {
    const preds = entry.allPredictions || {};
    const upWon = entry.outcome === 'WIN'
      ? entry.side === 'UP'
      : entry.side === 'DOWN';
    const actualDir = upWon ? 'UP' : 'DOWN';

    for (const [id, pred] of Object.entries(preds)) {
      if (!pred?.direction || pred.direction === 'UNKNOWN') continue;
      if (!modelStats[id]) modelStats[id] = { name: pred.providerName || id, model: pred.model || id, correct: 0, wrong: 0, total: 0, totalConf: 0, agree: 0 };
      modelStats[id].total++;
      modelStats[id].totalConf += pred.confidence || 0;
      if (pred.direction === actualDir) modelStats[id].correct++;
      else modelStats[id].wrong++;
    }
    // Also check inter-model agreement
    const predIds = Object.keys(preds).filter(id => preds[id]?.direction && preds[id].direction !== 'UNKNOWN');
    if (predIds.length >= 2) {
      const dirs = predIds.map(id => preds[id].direction);
      const allAgree = dirs.every(d => d === dirs[0]);
      for (const id of predIds) {
        if (modelStats[id]) modelStats[id].agree += allAgree ? 1 : 0;
      }
    }
  }
  const modelComparison = {};
  for (const [id, s] of Object.entries(modelStats)) {
    modelComparison[id] = {
      name: s.name, model: s.model,
      accuracy: s.total > 0 ? +(s.correct / s.total).toFixed(3) : null,
      correct: s.correct, wrong: s.wrong, total: s.total,
      avgConfidence: s.total > 0 ? +(s.totalConf / s.total).toFixed(1) : null,
      agreementRate: s.total > 0 ? +(s.agree / s.total).toFixed(2) : null,
    };
  }

  // ── Compile mistakes from recent losses ──
  const recentLosses = losses.slice(-3);
  const mistakes = recentLosses.map(l => {
    const a = l.analysis;
    const wrongInds = Object.entries(a.indicators || {}).filter(([, v]) => v.correct === false).map(([n]) => n);
    return {
      side: l.side,
      confidence: a.aiConfidence,
      regime: a.regime,
      wrongIndicators: wrongInds,
      timeLeft: a.timeLeftAtEntry?.toFixed(1),
      summary: `${l.side} @ ${a.aiConfidence}% conf in ${a.regime} — wrong indicators: ${wrongInds.join(', ') || 'none tracked'}`,
    };
  });

  learnings = {
    ready: true,
    totalAnalyzed: analyzed.length,
    overallWinRate: +((wins.length / analyzed.length) * 100).toFixed(1),
    indicatorAccuracy,
    bestIndicators,
    worstIndicators,
    regimePerformance,
    confidenceCalibration: { avgWinConf, avgLossConf },
    timePerformance,
    signalAgreementInsight: { highAgreeWinRate, lowAgreeWinRate },
    recentVsOlder: { recent5WinRate, olderWinRate },
    modelComparison,
    lessons,
    recentMistakes: mistakes,
    lastUpdated: new Date().toISOString(),
  };

  saveLearnings();
  console.log(`  [paper] LEARN: ${lessons.length} lessons from ${analyzed.length} trades (${wins.length}W/${losses.length}L)`);
}

function saveLearnings() {
  // Fire-and-forget DB save
  if (learnings) dbSaveLearnings(learnings).catch(() => {});
  try { ensureDir(LEARN_FILE); fs.writeFileSync(LEARN_FILE, JSON.stringify(learnings, null, 2), 'utf8'); } catch { /* */ }
}

async function loadLearnings() {
  // Try DB first
  try {
    const dbLearn = await dbLoadLearnings();
    if (dbLearn !== null && dbLearn !== undefined) {
      learnings = dbLearn;
      return;
    }
  } catch { /* fall through */ }

  // File-based fallback
  try {
    if (fs.existsSync(LEARN_FILE)) {
      learnings = JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8'));
      return;
    }
  } catch { /* */ }
  learnings = null;
}

/* ── Risk Metrics ─────────────────────────────────────── */

function computeRiskMetrics() {
  const trades = state.history.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  if (trades.length === 0) return null;

  const wins = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const totalGains = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = losses.reduce((s, t) => s + Math.abs(t.pnl), 0);
  const avgWin = wins.length > 0 ? totalGains / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;
  const riskReward = avgLoss > 0 ? avgWin / avgLoss : null;
  const profitFactor = totalLosses > 0 ? totalGains / totalLosses : null;
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const expectedValue = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  let peak = state.config.initialBalance, maxDrawdown = 0;
  for (const t of trades) { if (t.balanceAfter > peak) peak = t.balanceAfter; const dd = peak > 0 ? (peak - t.balanceAfter) / peak : 0; if (dd > maxDrawdown) maxDrawdown = dd; }
  const currentDrawdown = state.stats.peakBalance > 0 ? (state.stats.peakBalance - state.balance) / state.stats.peakBalance : 0;

  let maxConsecLoss = 0, curCL = 0, maxConsecWin = 0, curCW = 0;
  for (const t of trades) {
    if (t.outcome === 'LOSS') { curCL++; curCW = 0; maxConsecLoss = Math.max(maxConsecLoss, curCL); }
    else { curCW++; curCL = 0; maxConsecWin = Math.max(maxConsecWin, curCW); }
  }

  let sharpe = null;
  if (trades.length >= 3) {
    const returns = trades.map(t => t.pnl);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    sharpe = std > 0 ? mean / std : null;
  }

  let kelly = null;
  if (riskReward != null && riskReward > 0 && winRate > 0) {
    kelly = Math.max(0, Math.min(1, (riskReward * winRate - (1 - winRate)) / riskReward));
  }

  return { avgWin, avgLoss, riskReward, profitFactor, expectedValue, maxDrawdown, currentDrawdown, maxConsecLoss, maxConsecWin, totalGains, totalLosses, sharpe, kelly };
}

/* ── Martingale ───────────────────────────────────────── */

function getEffectivePositionPct() {
  const base = state.config.positionSizePct;
  if (!state.config.martingale.enabled) return base;
  const { multiplier, maxLevel, maxPositionPct } = state.config.martingale;
  return Math.min(base * Math.pow(multiplier, Math.min(state.martingaleLevel, maxLevel)), maxPositionPct);
}

/* ── Trade Execution ──────────────────────────────────── */

function enterTrade(side, price, data) {
  if (state.currentTrade || price <= 0 || price >= 1) return;

  const sizePct = getEffectivePositionPct();
  const maxSpend = state.balance * sizePct;
  if (maxSpend < 0.01) return;

  const shares = maxSpend / price;
  const cost = shares * price;

  state.currentTrade = {
    id: `t_${Date.now()}`,
    side,
    entryPrice: price,
    shares,
    cost,
    enteredAt: new Date().toISOString(),
    marketSlug: data.marketSlug,
    aiDirection: data.aiDirection,
    aiConfidence: data.aiConfidence,
    aiReasoning: data.aiReasoning,
    aiProviderId: data.aiProviderId ?? 'unknown',
    taAction: data.taAction,
    timeLeftAtEntry: data.timeLeft,
    priceToBeat: data.priceToBeat,
    martingaleLevel: state.martingaleLevel,
    positionSizePct: sizePct,
    // Full snapshot of all indicators at entry time
    entrySnapshot: data.snapshot ?? null,
    // All providers' predictions at entry time (for comparison)
    allPredictions: data.allPredictions ?? {},
  };

  state.balance -= cost;

  const mgTag = state.config.martingale.enabled ? ` [MG:${state.martingaleLevel}]` : '';
  console.log(`  [paper] ENTER ${side} | ${shares.toFixed(1)} shares @ ${(price * 100).toFixed(0)}¢ | cost $${cost.toFixed(2)} (${(sizePct * 100).toFixed(0)}%) | bal $${state.balance.toFixed(2)}${mgTag}`);
  saveState();
}

function settleTrade(outcome) {
  if (!state.currentTrade) return;
  const trade = state.currentTrade;

  let pnl = 0;
  if (outcome === 'WIN') {
    pnl = trade.shares * 1.0 - trade.cost;
    state.balance += trade.shares * 1.0;
  } else if (outcome === 'LOSS') {
    pnl = -trade.cost;
  } else {
    state.balance += trade.cost;
  }

  const settledTrade = {
    ...trade, outcome, pnl,
    settledAt: new Date().toISOString(),
    balanceAfter: state.balance,
  };

  state.history.push(settledTrade);

  // ── Post-trade analysis ──
  const analysis = analyzeOutcome(settledTrade);

  // ── Journal entry (detailed, with reasoning) ──
  appendJournalEntry({
    id: trade.id,
    side: trade.side,
    entryPrice: trade.entryPrice,
    cost: trade.cost,
    shares: trade.shares,
    aiConfidence: trade.aiConfidence,
    aiReasoning: trade.aiReasoning,
    aiProviderId: trade.aiProviderId ?? 'unknown',
    allPredictions: trade.allPredictions ?? {},
    timeLeftAtEntry: trade.timeLeftAtEntry,
    enteredAt: trade.enteredAt,
    settledAt: settledTrade.settledAt,
    outcome,
    pnl,
    balanceAfter: state.balance,
    martingaleLevel: trade.martingaleLevel,
    entrySnapshot: trade.entrySnapshot,
    analysis,
  });

  // ── Update stats ──
  if (outcome !== 'UNKNOWN') {
    state.stats.totalTrades += 1;
    if (outcome === 'WIN') {
      state.stats.wins += 1;
      state.stats.streak = state.stats.streak >= 0 ? state.stats.streak + 1 : 1;
      state.martingaleLevel = 0;
    } else {
      state.stats.losses += 1;
      state.stats.streak = state.stats.streak <= 0 ? state.stats.streak - 1 : -1;
      if (state.config.martingale.enabled) {
        state.martingaleLevel = Math.min(state.martingaleLevel + 1, state.config.martingale.maxLevel);
      }
    }
    state.stats.totalPnl += pnl;
    state.stats.peakBalance = Math.max(state.stats.peakBalance, state.balance);
  }

  state.currentTrade = null;

  const icon = outcome === 'WIN' ? '+' : outcome === 'LOSS' ? '-' : '~';
  console.log(`  [paper] SETTLE ${outcome} | ${icon}$${Math.abs(pnl).toFixed(2)} | bal $${state.balance.toFixed(2)} | W${state.stats.wins}/L${state.stats.losses}`);

  adjustLearning();
  computeLearnings(); // recompute insights after every trade
  logTradeCsv(settledTrade);
  saveState();
}

/* ── Adaptive Config ──────────────────────────────────── */

function adjustLearning() {
  const window = state.config.learningWindow;
  const recent = state.history.slice(-window).filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  if (recent.length < 5) return;

  const wins = recent.filter(t => t.outcome === 'WIN').length;
  const winRate = wins / recent.length;
  const old = state.config.minAiConfidence;

  // More aggressive tightening when losing — capital preservation first
  if (winRate < 0.30) state.config.minAiConfidence = Math.min(92, old + 8);
  else if (winRate < 0.40) state.config.minAiConfidence = Math.min(90, old + 5);
  else if (winRate < 0.50) state.config.minAiConfidence = Math.min(88, old + 3);
  else if (winRate > 0.65) state.config.minAiConfidence = Math.max(65, old - 2);

  // Never drop below initial minimum
  state.config.minAiConfidence = Math.max(state.config.minAiConfidence, 65);

  if (state.config.minAiConfidence !== old) {
    console.log(`  [paper] ADAPT: winRate ${(winRate * 100).toFixed(0)}% → confidence ${old}→${state.config.minAiConfidence}`);
  }
}

/* ── Settings (can be updated at runtime from settings page) ── */

export function applyPaperSettings(s) {
  if (!s || typeof s !== 'object' || !state) return;
  if (s.initialBalance != null) state.config.initialBalance = Number(s.initialBalance);
  if (s.positionSizePct != null) state.config.positionSizePct = Number(s.positionSizePct);
  if (s.minAiConfidence != null) state.config.minAiConfidence = Number(s.minAiConfidence);
  if (s.minEntryTimeLeft != null) state.config.minEntryTimeLeft = Number(s.minEntryTimeLeft);
  if (s.maxEntryTimeLeft != null) state.config.maxEntryTimeLeft = Number(s.maxEntryTimeLeft);
  if (s.learningWindow != null) state.config.learningWindow = Number(s.learningWindow);
  if (s.maxDrawdownHalt != null) state.config.maxDrawdownHalt = Number(s.maxDrawdownHalt);
  if (s.martingale && typeof s.martingale === 'object') {
    if (s.martingale.enabled != null) state.config.martingale.enabled = !!s.martingale.enabled;
    if (s.martingale.multiplier != null) state.config.martingale.multiplier = Number(s.martingale.multiplier);
    if (s.martingale.maxLevel != null) state.config.martingale.maxLevel = Number(s.martingale.maxLevel);
    if (s.martingale.maxPositionPct != null) state.config.martingale.maxPositionPct = Number(s.martingale.maxPositionPct);
  }
  saveState();
  console.log(`  [paper] config updated: posSz=${(state.config.positionSizePct * 100).toFixed(1)}% minConf=${state.config.minAiConfidence} MG=${state.config.martingale.enabled ? 'ON' : 'OFF'}`);
}

async function loadConfigFromDb() {
  try {
    const dbCfg = await dbGetConfig('paper_config');
    if (dbCfg && state) {
      applyPaperSettings(dbCfg);
    }
  } catch { /* ignore — use defaults */ }
}

/* ── Main Tick ────────────────────────────────────────── */

export async function initPaperTrader() {
  await loadState();
  await loadConfigFromDb();
  await loadJournal();
  await loadLearnings();
  if (journal.length >= 3) computeLearnings();
}

export function processTick(data) {
  if (!state) {
    // Synchronous file-based fallback for lazy init (async init should have been called already)
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const loaded = JSON.parse(raw);
        state = { ...createDefaultState(), ...loaded, config: deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), loaded.config ?? {}), stats: { ...createDefaultState().stats, ...(loaded.stats ?? {}) } };
      } else { state = createDefaultState(); }
    } catch { state = createDefaultState(); }
    try { if (fs.existsSync(JOURNAL_FILE)) { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); if (!Array.isArray(journal)) journal = []; } } catch { journal = []; }
    try { if (fs.existsSync(LEARN_FILE)) { learnings = JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8')); } } catch { learnings = null; }
  }

  const { ai, aiAll, poly, timeLeft, priceToBeat, ptbDelta, rec, snapshot } = data;
  const marketSlug = poly?.slug || '';

  if (ptbDelta != null) state.lastPtbDelta = ptbDelta;

  // ── Settlement ──
  if (state.currentTrade && marketSlug && state.currentTrade.marketSlug && state.currentTrade.marketSlug !== marketSlug) {
    const delta = state.lastPtbDelta;
    if (delta != null && delta !== 0) {
      const upWon = delta > 0;
      const outcome = (state.currentTrade.side === 'UP' && upWon) || (state.currentTrade.side === 'DOWN' && !upWon) ? 'WIN' : 'LOSS';
      settleTrade(outcome);
    } else { settleTrade('UNKNOWN'); }
    state.lastSettledSlug = state.currentTrade?.marketSlug ?? marketSlug;
    state.lastPtbDelta = null;
  }

  if (state.currentTrade && timeLeft != null && timeLeft <= 0.1 && ptbDelta != null && ptbDelta !== 0) {
    const upWon = ptbDelta > 0;
    const outcome = (state.currentTrade.side === 'UP' && upWon) || (state.currentTrade.side === 'DOWN' && !upWon) ? 'WIN' : 'LOSS';
    settleTrade(outcome);
  }

  // ── Collect all providers' predictions for comparison tracking ──
  const allPredictions = {};
  if (aiAll) {
    for (const [id, result] of Object.entries(aiAll)) {
      if (result?.analysis) {
        allPredictions[id] = {
          direction: result.analysis.direction,
          confidence: result.analysis.confidence,
          reasoning: (result.analysis.reasoning || '').slice(0, 150),
          model: result.model || result.analysis?.model || id,
          providerName: result.providerName || id,
        };
      }
    }
  }

  // ── Capital Protection: halt trading if drawdown exceeds threshold ──
  const drawdownPct = (state.config.initialBalance - state.balance) / state.config.initialBalance;
  const haltThreshold = state.config.maxDrawdownHalt || 0.15;
  const capitalProtected = drawdownPct >= haltThreshold;

  // ── Entry ──
  if (
    !state.currentTrade && state.balance > 0.5 && !capitalProtected &&
    ai?.enabled && ai?.analysis && poly?.ok && marketSlug && marketSlug !== state.lastSettledSlug
  ) {
    const analysis = ai.analysis;
    const confidence = analysis.confidence || 0;
    const direction = analysis.direction;

    // Scale position down if losing — protect remaining capital
    let dynamicSizePct = state.config.positionSizePct;
    if (drawdownPct > 0.05) {
      // Reduce position size proportionally when in drawdown
      dynamicSizePct = Math.max(0.01, state.config.positionSizePct * (1 - drawdownPct));
    }

    if (
      (direction === 'UP' || direction === 'DOWN') &&
      confidence >= state.config.minAiConfidence &&
      timeLeft != null && timeLeft >= state.config.minEntryTimeLeft && timeLeft <= state.config.maxEntryTimeLeft &&
      poly.upPrice != null && poly.downPrice != null
    ) {
      const price = direction === 'UP' ? poly.upPrice : poly.downPrice;
      if (price > 0 && price < 1) {
        // Temporarily override position size with dynamic risk-adjusted size
        const origSize = state.config.positionSizePct;
        state.config.positionSizePct = dynamicSizePct;

        enterTrade(direction, price, {
          marketSlug,
          aiDirection: direction,
          aiConfidence: confidence,
          aiReasoning: analysis.reasoning ?? '',
          aiProviderId: analysis.providerId ?? 'unknown',
          taAction: rec?.action ?? null,
          timeLeft,
          priceToBeat,
          snapshot: snapshot ?? null,
          allPredictions,
        });

        state.config.positionSizePct = origSize; // restore
      }
    }
  } else if (capitalProtected && !state.currentTrade) {
    // Log capital protection halt (once per cycle, throttle with timestamp)
    if (!state._lastHaltLog || Date.now() - state._lastHaltLog > 60000) {
      console.log(`  [paper] CAPITAL PROTECTION: Trading halted — drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds ${(haltThreshold * 100).toFixed(0)}% limit. Protecting remaining $${state.balance.toFixed(2)}`);
      state._lastHaltLog = Date.now();
    }
  }

  return getPublicState();
}

/* ── Public State ─────────────────────────────────────── */

function getPublicState() {
  if (!state) return null;
  const wc = state.stats.wins, lc = state.stats.losses;
  const winRate = (wc + lc) > 0 ? wc / (wc + lc) : null;

  const dd = (state.config.initialBalance - state.balance) / state.config.initialBalance;
  const haltTh = state.config.maxDrawdownHalt || 0.15;

  return {
    balance: state.balance,
    initialBalance: state.config.initialBalance,
    totalPnl: state.stats.totalPnl,
    pnlPct: ((state.balance - state.config.initialBalance) / state.config.initialBalance) * 100,
    capitalProtection: {
      active: dd >= haltTh,
      drawdownPct: +(dd * 100).toFixed(1),
      haltThresholdPct: +(haltTh * 100).toFixed(0),
      maxRiskPerTrade: +(state.config.positionSizePct * 100).toFixed(1),
    },
    currentTrade: state.currentTrade ? {
      side: state.currentTrade.side, entryPrice: state.currentTrade.entryPrice,
      shares: state.currentTrade.shares, cost: state.currentTrade.cost,
      aiConfidence: state.currentTrade.aiConfidence,
      aiReasoning: state.currentTrade.aiReasoning,
      aiProviderId: state.currentTrade.aiProviderId ?? 'unknown',
      enteredAt: state.currentTrade.enteredAt,
      timeLeftAtEntry: state.currentTrade.timeLeftAtEntry,
      martingaleLevel: state.currentTrade.martingaleLevel,
      positionSizePct: state.currentTrade.positionSizePct,
    } : null,
    stats: { totalTrades: state.stats.totalTrades, wins: wc, losses: lc, winRate, streak: state.stats.streak, peakBalance: state.stats.peakBalance },
    config: { minAiConfidence: state.config.minAiConfidence, positionSizePct: state.config.positionSizePct },
    martingale: {
      enabled: state.config.martingale.enabled, level: state.martingaleLevel,
      multiplier: state.config.martingale.multiplier, maxLevel: state.config.martingale.maxLevel,
      nextSizePct: getEffectivePositionPct(),
    },
    risk: computeRiskMetrics(),
    learnings: learnings ?? { ready: false },
    recentTrades: state.history.slice(-15).reverse().map(t => ({
      side: t.side, entryPrice: t.entryPrice, outcome: t.outcome, pnl: t.pnl,
      aiConfidence: t.aiConfidence, aiReasoning: (t.aiReasoning || '').slice(0, 80),
      aiProviderId: t.aiProviderId ?? 'unknown',
      settledAt: t.settledAt, balanceAfter: t.balanceAfter, martingaleLevel: t.martingaleLevel ?? 0,
    })),
  };
}

/* ── AI Learning Context ──────────────────────────────── */

export function getLearningsForAi() {
  if (!learnings || !learnings.ready) return null;
  const lines = [];

  // Capital preservation warning
  const dd = state ? (state.config.initialBalance - state.balance) / state.config.initialBalance : 0;
  if (dd > 0.05) {
    lines.push(`⚠️ CAPITAL ALERT: Portfolio is down ${(dd * 100).toFixed(1)}% from initial $${state.config.initialBalance}. PROTECT REMAINING CAPITAL. Only enter HIGH-CONVICTION trades.`);
    lines.push(``);
  }

  lines.push(`=== AGENT TRADE HISTORY & LESSONS ===`);
  lines.push(`Total trades: ${learnings.totalAnalyzed} | Win rate: ${learnings.overallWinRate}%`);

  if (learnings.bestIndicators.length > 0) {
    lines.push(`Most reliable indicators: ${learnings.bestIndicators.map(i => `${i.name} (${(i.accuracy * 100).toFixed(0)}%)`).join(', ')}`);
  }
  if (learnings.worstIndicators.length > 0) {
    lines.push(`Least reliable: ${learnings.worstIndicators.map(i => `${i.name} (${(i.accuracy * 100).toFixed(0)}%)`).join(', ')}`);
  }

  const cal = learnings.confidenceCalibration;
  if (cal.avgWinConf != null) lines.push(`Avg confidence — wins: ${cal.avgWinConf}% | losses: ${cal.avgLossConf}%`);

  for (const [regime, p] of Object.entries(learnings.regimePerformance || {})) {
    lines.push(`  ${regime}: ${p.wins}W/${p.losses}L (${p.winRate != null ? (p.winRate * 100).toFixed(0) + '%' : 'n/a'})`);
  }

  if (learnings.lessons.length > 0) {
    lines.push(``);
    lines.push(`LESSONS LEARNED (apply these to current analysis):`);
    learnings.lessons.forEach((l, i) => lines.push(`  ${i + 1}. ${l}`));
  }

  if (learnings.recentMistakes.length > 0) {
    lines.push(``);
    lines.push(`RECENT MISTAKES (avoid repeating):`);
    learnings.recentMistakes.forEach(m => lines.push(`  - ${m.summary}`));
  }

  return lines.join('\n');
}

/* ── Controls ─────────────────────────────────────────── */

export function resetPaperTrader() {
  state = createDefaultState();
  journal = [];
  learnings = null;
  saveState(); saveJournal(); saveLearnings();
  console.log('  [paper] RESET to $100.00');
  return getPublicState();
}

export function toggleMartingale() {
  if (!state) return getPublicState();
  state.config.martingale.enabled = !state.config.martingale.enabled;
  if (!state.config.martingale.enabled) state.martingaleLevel = 0;
  saveState();
  console.log(`  [paper] martingale ${state.config.martingale.enabled ? 'ENABLED' : 'DISABLED'}`);
  return getPublicState();
}
