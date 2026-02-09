/**
 * Additional technical indicators for improved decision-making.
 * Bollinger Bands, EMA Crossover, ATR, Stochastic, OBV
 */

/* ── EMA helper ───────────────────────────────────────── */

export function computeEma(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/* ── Bollinger Bands ──────────────────────────────────── */

export function computeBollingerBands(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const last = closes[closes.length - 1];
  const bandwidth = mean > 0 ? (upper - lower) / mean : 0; // normalized
  const pctB = (upper - lower) > 0 ? (last - lower) / (upper - lower) : 0.5;
  // Squeeze: compare bandwidth to its 120-period average
  return { upper, lower, middle: mean, std, bandwidth, pctB };
}

/* ── EMA Crossover (9/21) ─────────────────────────────── */

export function computeEmaCrossover(closes, fastP = 9, slowP = 21) {
  if (!closes || closes.length < slowP + 2) return null;
  const fast = computeEma(closes, fastP);
  const slow = computeEma(closes, slowP);
  if (fast == null || slow == null) return null;

  const diff = fast - slow;
  // Previous bar
  const prevCloses = closes.slice(0, -1);
  const prevFast = computeEma(prevCloses, fastP);
  const prevSlow = computeEma(prevCloses, slowP);
  const prevDiff = (prevFast != null && prevSlow != null) ? prevFast - prevSlow : null;

  const crossUp   = prevDiff != null && prevDiff <= 0 && diff > 0;
  const crossDown = prevDiff != null && prevDiff >= 0 && diff < 0;
  const signal = diff > 0 ? 'BULLISH' : 'BEARISH';

  return { fast, slow, diff, crossUp, crossDown, signal };
}

/* ── ATR (Average True Range) ─────────────────────────── */

export function computeAtr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const recent = trs.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
  const lastClose = candles[candles.length - 1].close;
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : null;
  // Volatility regime
  const avgAtr = trs.length >= period * 2
    ? trs.slice(-period * 2, -period).reduce((a, b) => a + b, 0) / period
    : null;
  const volRegime = avgAtr != null ? (atr > avgAtr * 1.3 ? 'HIGH' : atr < avgAtr * 0.7 ? 'LOW' : 'NORMAL') : null;

  return { atr, atrPct, volRegime };
}

/* ── Stochastic Oscillator ────────────────────────────── */

export function computeStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod + dPeriod) return null;

  const kValues = [];
  for (let j = dPeriod - 1; j >= 0; j--) {
    const end = candles.length - j;
    const start = end - kPeriod;
    if (start < 0) return null;
    const slice = candles.slice(start, end);
    const highest = Math.max(...slice.map(c => c.high));
    const lowest  = Math.min(...slice.map(c => c.low));
    const range = highest - lowest;
    kValues.push(range > 0 ? ((slice[slice.length - 1].close - lowest) / range) * 100 : 50);
  }

  const k = kValues[kValues.length - 1];
  const d = kValues.reduce((a, b) => a + b, 0) / kValues.length;
  const signal = k > 80 ? 'OVERBOUGHT' : k < 20 ? 'OVERSOLD' : 'NEUTRAL';

  return { k, d, signal };
}

/* ── OBV (On-Balance Volume) trend ────────────────────── */

export function computeObvTrend(candles, lookback = 20) {
  if (!candles || candles.length < lookback + 1) return null;
  let obv = 0;
  const obvSeries = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
    obvSeries.push(obv);
  }
  const recent = obvSeries.slice(-lookback);
  const start = recent[0], end = recent[recent.length - 1];
  const trend = end > start ? 'RISING' : end < start ? 'FALLING' : 'FLAT';
  // OBV slope (normalized)
  const priceStart = candles[candles.length - lookback]?.close || 1;
  const slope = (end - start) / lookback / priceStart;

  return { obv: end, trend, slope };
}

/* ── Signal Agreement Score ───────────────────────────── */

export function computeSignalAgreement(indicators) {
  let bullish = 0, bearish = 0, total = 0;

  const { rsi, macdLabel, vwapDist, emaCross, stoch, obvTrend, heikenColor, bollinger } = indicators;

  // RSI
  if (rsi != null) {
    total++;
    if (rsi > 55) bullish++;
    else if (rsi < 45) bearish++;
  }

  // MACD
  if (macdLabel) {
    total++;
    if (macdLabel.includes('bullish')) bullish++;
    else if (macdLabel.includes('bearish')) bearish++;
  }

  // VWAP distance
  if (vwapDist != null) {
    total++;
    if (vwapDist > 0.001) bullish++;
    else if (vwapDist < -0.001) bearish++;
  }

  // EMA crossover
  if (emaCross) {
    total++;
    if (emaCross.signal === 'BULLISH') bullish++;
    else if (emaCross.signal === 'BEARISH') bearish++;
  }

  // Stochastic
  if (stoch) {
    total++;
    if (stoch.k > 60) bullish++;
    else if (stoch.k < 40) bearish++;
  }

  // OBV
  if (obvTrend) {
    total++;
    if (obvTrend.trend === 'RISING') bullish++;
    else if (obvTrend.trend === 'FALLING') bearish++;
  }

  // Heiken Ashi
  if (heikenColor) {
    total++;
    if (heikenColor === 'green') bullish++;
    else if (heikenColor === 'red') bearish++;
  }

  // Bollinger %B
  if (bollinger) {
    total++;
    if (bollinger.pctB > 0.6) bullish++;
    else if (bollinger.pctB < 0.4) bearish++;
  }

  const direction = bullish > bearish ? 'BULLISH' : bearish > bullish ? 'BEARISH' : 'MIXED';
  const strength = total > 0 ? Math.max(bullish, bearish) / total : 0;

  return { bullish, bearish, total, direction, strength };
}
