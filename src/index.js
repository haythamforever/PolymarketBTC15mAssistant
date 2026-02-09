import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { CONFIG } from './config.js';
import { fetchKlines, fetchLastPrice } from './data/binance.js';
import { fetchChainlinkBtcUsd } from './data/chainlink.js';
import { startChainlinkPriceStream } from './data/chainlinkWs.js';
import { startPolymarketChainlinkPriceStream } from './data/polymarketLiveWs.js';
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from './data/polymarket.js';
import { computeSessionVwap, computeVwapSeries } from './indicators/vwap.js';
import { computeRsi, sma, slopeLast } from './indicators/rsi.js';
import { computeMacd } from './indicators/macd.js';
import { computeHeikenAshi, countConsecutive } from './indicators/heikenAshi.js';
import { computeBollingerBands, computeEmaCrossover, computeAtr, computeStochastic, computeObvTrend, computeSignalAgreement } from './indicators/extra.js';
import { detectRegime } from './engines/regime.js';
import { scoreDirection, applyTimeAwareness } from './engines/probability.js';
import { computeEdge, decide } from './engines/edge.js';
import { appendCsvRow, getCandleWindowTiming, sleep } from './utils.js';
import { startBinanceTradeStream } from './data/binanceWs.js';
import { applyGlobalProxyFromEnv } from './net/proxy.js';
import { getAllAiAnalyses, isAiEnabled, forceNextRefresh, setActiveProvider, getActiveProviderId, getProviderInfo, getModelStats } from './engines/aiAnalysis.js';
import { initPaperTrader, processTick as paperTick, resetPaperTrader, toggleMartingale, getLearningsForAi } from './engines/paperTrader.js';
import { initRealTrader, processRealTick, confirmRealSession, killSwitch, getRealTraderEnabled, getRealState } from './engines/realTrader.js';
import { getSessionSecret, hasAnyUsers, createUser, authenticateUser } from './auth.js';

/* ── Setup ────────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

applyGlobalProxyFromEnv();

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

/* ── Session & Auth ───────────────────────────────────── */
app.use(express.json());

const sessionMiddleware = session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ── Public routes (no auth) ──
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

app.get('/api/status', (req, res) => {
  res.json({ needsSetup: !hasAnyUsers(), loggedIn: !!req.session?.user, user: req.session?.user?.username ?? null });
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
    const user = await authenticateUser(username, password);
    if (user) {
      req.session.user = user;
      return res.json({ ok: true });
    }
    res.json({ ok: false, error: 'Invalid username or password' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/setup', async (req, res) => {
  try {
    if (hasAnyUsers()) return res.json({ ok: false, error: 'Admin account already exists' });
    const { username, password, confirm } = req.body || {};
    if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
    if (password.length < 4) return res.json({ ok: false, error: 'Password must be at least 4 characters' });
    if (password !== confirm) return res.json({ ok: false, error: 'Passwords do not match' });
    const user = await createUser(username, password, 'admin');
    req.session.user = user;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => { res.redirect('/login'); });
});

// ── Auth middleware (protects everything below) ──
app.use((req, res, next) => {
  if (req.session?.user) return next();
  res.redirect('/login');
});

// ── Protected routes ──
app.get('/trades', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'trades.html')));
app.get('/models', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'models.html')));

// ── Protected static files ──
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ── Helper Functions ─────────────────────────────────── */

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;
  if (inEurope && inUs) return 'Europe/US overlap';
  if (inAsia && inEurope) return 'Asia/Europe overlap';
  if (inAsia) return 'Asia';
  if (inEurope) return 'Europe';
  if (inUs) return 'US';
  return 'Off-hours';
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(now);
  } catch { return '-'; }
}

function safeFileSlug(x) {
  return String(x ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    'priceToBeat', 'price_to_beat', 'strikePrice', 'strike_price',
    'strike', 'threshold', 'thresholdPrice', 'threshold_price',
    'targetPrice', 'target_price', 'referencePrice', 'reference_price'
  ];
  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];
  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);
    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === 'object') { stack.push({ obj: value, depth: depth + 1 }); continue; }
      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;
      const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
      if (!Number.isFinite(n)) continue;
      if (n > 1000 && n < 2_000_000) return n;
    }
  }
  return null;
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? '');
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

/* ── Market Resolution ────────────────────────────────── */

const marketCache = { market: null, fetchedAtMs: 0 };

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }
  if (!CONFIG.polymarket.autoSelectLatest) return null;
  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }
  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);
  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();
  if (!market) return { ok: false, reason: 'market_not_found' };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices) ? market.outcomePrices : (typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : []);
  const clobTokenIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : (typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null, downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;
    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex(x => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex(x => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());
  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return { ok: false, reason: 'missing_token_ids', market, outcomes, clobTokenIds, outcomePrices };
  }

  let upBuy = null, downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { ...upBookSummary };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: 'buy' }),
      fetchClobPrice({ tokenId: downTokenId, side: 'buy' }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);
    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null, askLiquidity: null
    };
    downBookSummary = { bestBid: null, bestAsk: null, spread: Number(market.spread) || null, bidLiquidity: null, askLiquidity: null };
  }

  return {
    ok: true, market,
    tokens: { upTokenId, downTokenId },
    prices: { up: upBuy ?? gammaYes, down: downBuy ?? gammaNo },
    orderbook: { up: upBookSummary, down: downBookSummary }
  };
}

/* ── Main Loop ────────────────────────────────────────── */

const dumpedMarkets = new Set();

async function main() {
  initPaperTrader();
  initRealTrader();

  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

  let latestData = null;
  let latestKlines = [];
  let latestVwapSeries = [];

  io.on('connection', (socket) => {
    console.log(`  [ws] client connected: ${socket.id}`);
    if (latestKlines.length > 0) {
      socket.emit('init', {
        klines: latestKlines.map(k => ({
          time: Math.floor(k.openTime / 1000),
          open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        vwapSeries: latestVwapSeries
          .map((v, i) => ({ time: Math.floor(latestKlines[i]?.openTime / 1000), value: v }))
          .filter(v => v.value !== null)
      });
    }
    if (latestData) socket.emit('tick', latestData);
    socket.on('refreshAi', (providerId) => {
      console.log(`  [ai] manual refresh requested by ${socket.id}` + (providerId ? ` for ${providerId}` : ' (all)'));
      forceNextRefresh(providerId || undefined);
    });
    socket.on('switchProvider', (providerId) => {
      if (setActiveProvider(providerId)) {
        io.emit('providerChanged', { activeProvider: getActiveProviderId(), providers: getProviderInfo() });
      }
    });
    socket.on('resetPaper', () => {
      console.log(`  [paper] reset requested by ${socket.id}`);
      const ps = resetPaperTrader();
      io.emit('paperUpdate', ps);
    });
    socket.on('toggleMartingale', () => {
      console.log(`  [paper] martingale toggle by ${socket.id}`);
      const ps = toggleMartingale();
      io.emit('paperUpdate', ps);
    });
    // ── Real Trader Controls ──
    socket.on('confirmRealSession', () => {
      console.log(`  [real] session confirm requested by ${socket.id}`);
      const result = confirmRealSession();
      io.emit('realUpdate', getRealState());
      socket.emit('realConfirmResult', result);
    });
    socket.on('killSwitch', async () => {
      console.log(`  [real] KILL SWITCH by ${socket.id}`);
      const rs = await killSwitch();
      io.emit('realUpdate', rs);
    });
    socket.on('disconnect', () => console.log(`  [ws] client disconnected: ${socket.id}`));
  });

  const csvHeader = [
    'timestamp', 'entry_minute', 'time_left_min', 'regime', 'signal',
    'model_up', 'model_down', 'mkt_up', 'mkt_down', 'edge_up', 'edge_down', 'recommendation'
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;
    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;
    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: 'polymarket_ws' })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: 'chainlink_ws' })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: '1m', limit: 240 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map(c => c.close);

      // ── Indicators ──
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];
      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const r = computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      // ── Extra Indicators ──
      const bollinger = computeBollingerBands(closes, 20, 2);
      const emaCross = computeEmaCrossover(closes, 9, 21);
      const atr = computeAtr(candles, 14);
      const stoch = computeStochastic(candles, 14, 3);
      const obvTrend = computeObvTrend(candles, 20);
      const signalAgreement = computeSignalAgreement({
        rsi: rsiNow, macdLabel: macd ? (macd.hist < 0 ? 'bearish' : 'bullish') : null,
        vwapDist, emaCross, stoch, obvTrend,
        heikenColor: consec.color, bollinger
      });

      // ── Engines ──
      const regimeInfo = detectRegime({ price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });
      const scored = scoreDirection({ price: lastPrice, vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope, macd, heikenColor: consec.color, heikenCount: consec.count, failedVwapReclaim });
      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      // ── Derived values ──
      const vwapSlopeLabel = vwapSlope === null ? '-' : vwapSlope > 0 ? 'UP' : vwapSlope < 0 ? 'DOWN' : 'FLAT';
      const macdLabel = macd === null ? '-'
        : macd.hist < 0 ? (macd.histDelta !== null && macd.histDelta < 0 ? 'bearish (expanding)' : 'bearish')
        : (macd.histDelta !== null && macd.histDelta > 0 ? 'bullish (expanding)' : 'bullish');

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;

      // ── Price to Beat ──
      const marketSlug = poly.ok ? String(poly.market?.slug ?? '') : '';
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }
      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
      }
      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat : null;

      // Price diff (Binance vs Chainlink)
      let priceDiffUsd = null, priceDiffPct = null;
      if (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0) {
        priceDiffUsd = spotPrice - currentPrice;
        priceDiffPct = (priceDiffUsd / currentPrice) * 100;
      }

      // ── Market JSON dump ──
      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || 'market');
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try { fs.mkdirSync('./logs', { recursive: true }); fs.writeFileSync(path.join('./logs', `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), 'utf8'); } catch { /* ignore */ }
        }
      }

      const liquidity = poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null;
      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      // ── AI Analysis — all providers in parallel (non-blocking, throttled) ──
      const aiSnapshot = {
        timeLeft: timeLeftMin, session: getBtcSession(new Date()),
        priceToBeat, chainlinkPrice: currentPrice, binancePrice: spotPrice,
        ptbDelta, priceDiffUsd,
        poly: { ok: poly.ok, upPrice: marketUp, downPrice: marketDown, liquidity },
        predict: { long: timeAware.adjustedUp, short: timeAware.adjustedDown },
        heikenAshi: { color: consec.color, count: consec.count },
        rsi: { value: rsiNow, slope: rsiSlope, ma: rsiMa },
        macd: { label: macdLabel, hist: macd?.hist ?? null, histDelta: macd?.histDelta ?? null },
        vwap: { value: vwapNow, dist: vwapDist, slopeLabel: vwapSlopeLabel },
        bollinger: bollinger ? { pctB: bollinger.pctB, bandwidth: bollinger.bandwidth, upper: bollinger.upper, lower: bollinger.lower } : null,
        emaCross: emaCross ? { signal: emaCross.signal, crossUp: emaCross.crossUp, crossDown: emaCross.crossDown, diff: emaCross.diff } : null,
        atr: atr ? { atr: atr.atr, atrPct: atr.atrPct, volRegime: atr.volRegime } : null,
        stochastic: stoch ? { k: stoch.k, d: stoch.d, signal: stoch.signal } : null,
        obv: obvTrend ? { trend: obvTrend.trend, slope: obvTrend.slope } : null,
        signalAgreement,
        delta1m, delta3m, regime: regimeInfo.regime,
        rec: { action: rec.action, side: rec.side, phase: rec.phase, strength: rec.strength ?? null, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown },
        agentLearnings: getLearningsForAi(),
      };
      const aiMulti = await getAllAiAnalyses(aiSnapshot);
      const aiResult = aiMulti.primary; // backward compatible

      // ── Build tick data ──
      const data = {
        binancePrice: spotPrice,
        binancePricePrev: prevSpotPrice,
        chainlinkPrice: currentPrice,
        chainlinkPricePrev: prevCurrentPrice,
        chainlinkSource: chainlink?.source ?? 'unknown',
        priceDiffUsd, priceDiffPct,
        priceToBeat, ptbDelta,

        poly: {
          ok: poly.ok,
          title: poly.ok ? (poly.market?.question ?? '-') : '-',
          slug: marketSlug,
          upPrice: marketUp, downPrice: marketDown,
          liquidity,
          settlementTimeLeft: settlementLeftMin,
          spreadUp, spreadDown,
          orderbook: poly.ok ? poly.orderbook : null
        },

        predict: { long: timeAware.adjustedUp, short: timeAware.adjustedDown },
        heikenAshi: { color: consec.color, count: consec.count },
        rsi: { value: rsiNow, slope: rsiSlope, ma: rsiMa },
        macd: { label: macdLabel, hist: macd?.hist ?? null, histDelta: macd?.histDelta ?? null, macdLine: macd?.macd ?? null },
        vwap: { value: vwapNow, dist: vwapDist, slopeLabel: vwapSlopeLabel, slope: vwapSlope },
        bollinger: bollinger ? { pctB: bollinger.pctB, bandwidth: bollinger.bandwidth, upper: bollinger.upper, lower: bollinger.lower, middle: bollinger.middle } : null,
        emaCross: emaCross ? { signal: emaCross.signal, crossUp: emaCross.crossUp, crossDown: emaCross.crossDown } : null,
        atr: atr ? { atr: atr.atr, atrPct: atr.atrPct, volRegime: atr.volRegime } : null,
        stochastic: stoch ? { k: stoch.k, d: stoch.d, signal: stoch.signal } : null,
        obv: obvTrend ? { trend: obvTrend.trend } : null,
        signalAgreement,
        delta1m, delta3m,

        regime: regimeInfo.regime,
        rec: {
          action: rec.action, side: rec.side, phase: rec.phase,
          strength: rec.strength ?? null, edge: rec.edge ?? null,
          edgeUp: edge.edgeUp, edgeDown: edge.edgeDown
        },

        timeLeft: timeLeftMin,
        session: getBtcSession(new Date()),
        etTime: fmtEtTime(new Date()),

        lastCandle: lastCandle ? {
          time: Math.floor(lastCandle.openTime / 1000),
          open: lastCandle.open, high: lastCandle.high, low: lastCandle.low, close: lastCandle.close,
          volume: lastCandle.volume
        } : null,
        lastVwap: lastCandle && vwapNow ? { time: Math.floor(lastCandle.openTime / 1000), value: vwapNow } : null,
        lastPtb: lastCandle && priceToBeat ? { time: Math.floor(lastCandle.openTime / 1000), value: priceToBeat } : null,

        ai: {
          enabled: aiResult.enabled,
          analysis: aiResult.analysis,
          cached: aiResult.cached ?? false,
          error: aiResult.error ?? null,
          activeProvider: aiMulti.activeProvider,
          availableProviders: aiMulti.availableProviders,
          providers: Object.fromEntries(
            Object.entries(aiMulti.providers).map(([id, r]) => [id, {
              enabled: r.enabled,
              analysis: r.analysis,
              cached: r.cached ?? false,
              error: r.error ?? null,
              providerId: r.providerId,
              providerName: r.providerName,
              model: r.model,
            }])
          ),
        },

        paper: null, // filled below
        real: null,  // filled below
      };

      // ── Paper Trader (runs after full data is assembled) ──
      data.paper = paperTick({
        ai: data.ai,
        aiAll: aiMulti.providers, // all providers for comparison tracking
        poly: { ok: poly.ok, slug: marketSlug, upPrice: marketUp, downPrice: marketDown },
        timeLeft: timeLeftMin,
        priceToBeat,
        ptbDelta,
        rec,
        snapshot: {
          rsi: rsiNow, rsiSlope, rsiMa,
          macdLabel, macdHist: macd?.hist, macdHistDelta: macd?.histDelta,
          vwapDist, vwapSlopeLabel,
          heikenColor: consec.color, heikenCount: consec.count,
          regime: regimeInfo.regime,
          bollinger: bollinger ? { pctB: bollinger.pctB, bandwidth: bollinger.bandwidth } : null,
          emaCross: emaCross ? { signal: emaCross.signal, crossUp: emaCross.crossUp, crossDown: emaCross.crossDown } : null,
          atr: atr ? { atr: atr.atr, atrPct: atr.atrPct, volRegime: atr.volRegime } : null,
          stochastic: stoch ? { k: stoch.k, d: stoch.d, signal: stoch.signal } : null,
          obvTrend: obvTrend ? { trend: obvTrend.trend, slope: obvTrend.slope } : null,
          signalAgreement,
          delta1m, delta3m,
          chainlinkPrice: currentPrice, binancePrice: spotPrice,
          ptbDelta, priceToBeat,
        }
      });

      // ── Real Trader (runs alongside paper trader) ──
      if (getRealTraderEnabled()) {
        data.real = await processRealTick({
          ai: data.ai,
          poly: { ok: poly.ok, slug: marketSlug, upPrice: marketUp, downPrice: marketDown },
          tokens: poly.ok ? poly.tokens : {},
          timeLeft: timeLeftMin,
          priceToBeat,
          ptbDelta,
          rec,
        });
      } else {
        data.real = getRealState();
      }

      // Attach model stats for the models page
      data.modelStats = getModelStats();

      latestData = data;
      latestKlines = klines1m;
      latestVwapSeries = vwapSeries;

      io.emit('tick', data);

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      // CSV logging
      const signal = rec.action === 'ENTER' ? (rec.side === 'UP' ? 'BUY UP' : 'BUY DOWN') : 'NO TRADE';
      appendCsvRow('./logs/signals.csv', csvHeader, [
        new Date().toISOString(), timing.elapsedMinutes.toFixed(3), timeLeftMin.toFixed(3),
        regimeInfo.regime, signal, timeAware.adjustedUp, timeAware.adjustedDown,
        marketUp, marketDown, edge.edgeUp, edge.edgeDown,
        rec.action === 'ENTER' ? `${rec.side}:${rec.phase}:${rec.strength}` : 'NO_TRADE'
      ]);
    } catch (err) {
      console.error(`  [loop] error: ${err?.message ?? String(err)}`);
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

/* ── Start Server ─────────────────────────────────────── */

server.listen(PORT, () => {
  const providers = getProviderInfo();
  const aiLines = providers.map(p => `${p.active ? '*' : ' '} ${p.name} (${p.model})`);
  const aiStatus = providers.length > 0 ? `ON (${providers.length} models)` : 'OFF (no keys)';
  const authStatus = hasAnyUsers() ? 'ON (users exist)' : 'SETUP NEEDED';
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║  Polymarket BTC 15m Assistant  v0.6  ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Dashboard: http://localhost:${PORT}     ║`);
  console.log(`  ║  AI Analysis: ${aiStatus.padEnd(21)}║`);
  for (const line of aiLines) {
    console.log(`  ║    ${line.padEnd(32)}║`);
  }
  console.log('  ║  Paper Trader: ON ($100 initial)     ║');
  const realStatus = getRealTraderEnabled() ? 'ON (needs confirm)' : 'OFF';
  console.log(`  ║  Real Trading: ${realStatus.padEnd(21)}║`);
  console.log('  ║  Background Agent: ACTIVE            ║');
  console.log(`  ║  Auth: ${authStatus.padEnd(29)}║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});

main();
