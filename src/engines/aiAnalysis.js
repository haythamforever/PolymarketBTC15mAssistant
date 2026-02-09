import OpenAI from 'openai';

/* ── Config ──────────────────────────────────────────── */

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL   = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'o3';

const INTERVAL_SEC = Number(process.env.AI_INTERVAL_SECONDS || process.env.OPENAI_INTERVAL_SECONDS) || 30;

let activeProviderId = (process.env.AI_PRIMARY_PROVIDER || 'deepseek').toLowerCase();

/* ── Cost per 1M tokens (rough estimates, update as needed) ─ */
const COST_TABLE = {
  'deepseek-chat':      { input: 0.14,   output: 0.28  },
  'deepseek-reasoner':  { input: 0.55,   output: 2.19  },
  'gpt-4o-mini':        { input: 0.15,   output: 0.60  },
  'gpt-4o':             { input: 2.50,   output: 10.00 },
  'o3':                 { input: 2.00,   output: 8.00  },
  'o3-mini':            { input: 1.10,   output: 4.40  },
};

function estimateCost(model, promptTokens, completionTokens) {
  const rates = COST_TABLE[model] || { input: 1.0, output: 3.0 }; // fallback
  return (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output;
}

/* ── Provider Registry ───────────────────────────────── */

function makeUsageTracker() {
  return {
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    // Rolling windows (timestamps of requests with token counts)
    history: [], // { ts, prompt, completion, cost }
  };
}

const PROVIDERS = {};

if (DEEPSEEK_API_KEY) {
  PROVIDERS.deepseek = {
    id: 'deepseek',
    name: 'DeepSeek',
    model: DEEPSEEK_MODEL,
    client: new OpenAI({ apiKey: DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' }),
    state: { lastAnalysis: null, lastCallMs: 0, pending: false },
    usage: makeUsageTracker(),
  };
}
if (OPENAI_API_KEY) {
  PROVIDERS.openai = {
    id: 'openai',
    name: 'OpenAI',
    model: OPENAI_MODEL,
    client: new OpenAI({ apiKey: OPENAI_API_KEY }),
    state: { lastAnalysis: null, lastCallMs: 0, pending: false },
    usage: makeUsageTracker(),
  };
}

// Ensure active provider is valid; fall back to whatever is configured
if (!PROVIDERS[activeProviderId]) {
  const available = Object.keys(PROVIDERS);
  activeProviderId = available.length > 0 ? available[0] : '';
}

/* ── System Prompt (shared) ──────────────────────────── */

const SYSTEM_PROMPT = `You are an expert BTC short-term price analyst for Polymarket's "Bitcoin Up or Down" 15-minute prediction markets.

MARKET RULES:
- A "Price to Beat" (PTB) is set at market open (the Chainlink BTC/USD price at that moment).
- At settlement (end of the 15-min window), if BTC's Chainlink price is ABOVE PTB → "UP" wins. If BELOW → "DOWN" wins.
- Traders buy UP or DOWN shares priced in cents (e.g. UP 73¢ means market implies 73% chance of UP).

YOUR TASK:
Given real-time technical indicators and market data, predict whether BTC will settle ABOVE (UP) or BELOW (DOWN) the Price to Beat when the window closes.

RESPONSE FORMAT (strict JSON):
{
  "direction": "UP" or "DOWN",
  "confidence": <number 0-100>,
  "reasoning": "<2-3 concise sentences explaining your analysis>",
  "key_factors": ["<factor1>", "<factor2>", "<factor3>"]
}

ANALYSIS PRINCIPLES:
1. Current price vs PTB delta is the MOST important signal — if price is $50 above PTB with 2 min left, UP is very likely.
2. Momentum matters: delta 1m/3m shows recent acceleration. Heiken Ashi streak shows trend persistence.
3. RSI extremes (>70 or <30) may signal mean reversion, especially early in the window.
4. VWAP slope and distance indicate trend direction and overextension.
5. Bollinger %B > 0.8 = overbought territory; %B < 0.2 = oversold. Narrow bandwidth = squeeze (expect breakout).
6. EMA 9/21 crossover: recent cross UP is bullish, cross DOWN is bearish. Diff magnitude shows trend strength.
7. Stochastic: K > 80 = overbought, K < 20 = oversold. K crossing above D is bullish and vice versa.
8. ATR: High volatility regime = wider price swings possible. Low = prices are stable.
9. OBV trend: RISING = buying pressure, FALLING = selling pressure. Confirms or diverges from price trend.
10. Signal Agreement: count of bullish vs bearish indicators. Strong agreement = higher confidence.
11. When time left < 3 minutes, current price vs PTB almost determines the outcome — give high confidence.
12. When time left > 10 minutes, be more uncertain — lots can change.
13. Polymarket odds reflect crowd wisdom — significant divergence from your analysis is worth noting.
14. Volume and regime (TREND/RANGE/CHOP) affect reliability of momentum signals.
15. Never give confidence above 95% (markets are unpredictable).
16. Be concise and decisive. Traders need clear signals, not hedging.`;

/* ── Prompt Builder (shared) ─────────────────────────── */

function buildUserPrompt(snapshot) {
  const s = snapshot;
  const lines = [];

  lines.push(`=== MARKET STATE ===`);
  lines.push(`Time left: ${s.timeLeft != null ? s.timeLeft.toFixed(1) : '?'} minutes`);
  lines.push(`Session: ${s.session || '?'}`);
  lines.push(``);

  lines.push(`=== PRICES ===`);
  lines.push(`Price to Beat (PTB): ${s.priceToBeat != null ? '$' + s.priceToBeat.toFixed(2) : 'not set'}`);
  lines.push(`Current Price (Chainlink): ${s.chainlinkPrice != null ? '$' + s.chainlinkPrice.toFixed(2) : '?'}`);
  lines.push(`Binance BTC: ${s.binancePrice != null ? '$' + s.binancePrice.toFixed(2) : '?'}`);
  if (s.ptbDelta != null) {
    lines.push(`Current vs PTB: ${s.ptbDelta > 0 ? '+' : ''}$${s.ptbDelta.toFixed(2)} (${s.ptbDelta > 0 ? 'ABOVE' : 'BELOW'} PTB)`);
  }
  if (s.priceDiffUsd != null) {
    lines.push(`Binance vs Chainlink diff: ${s.priceDiffUsd > 0 ? '+' : ''}$${s.priceDiffUsd.toFixed(2)}`);
  }
  lines.push(``);

  lines.push(`=== POLYMARKET ODDS ===`);
  if (s.poly?.ok) {
    lines.push(`UP price: ${s.poly.upPrice ?? '?'}¢  |  DOWN price: ${s.poly.downPrice ?? '?'}¢`);
    if (s.poly.liquidity != null) lines.push(`Liquidity: $${Math.round(s.poly.liquidity)}`);
  } else {
    lines.push(`Market data unavailable`);
  }
  lines.push(``);

  lines.push(`=== TECHNICAL INDICATORS ===`);
  lines.push(`TA Model Prediction: LONG ${s.predict?.long != null ? (s.predict.long * 100).toFixed(0) + '%' : '?'} / SHORT ${s.predict?.short != null ? (s.predict.short * 100).toFixed(0) + '%' : '?'}`);

  if (s.heikenAshi) {
    lines.push(`Heiken Ashi: ${s.heikenAshi.color || '?'} x${s.heikenAshi.count || 0} consecutive`);
  }
  if (s.rsi?.value != null) {
    const arrow = s.rsi.slope != null ? (s.rsi.slope > 0 ? '↑' : s.rsi.slope < 0 ? '↓' : '→') : '';
    lines.push(`RSI(14): ${s.rsi.value.toFixed(1)} ${arrow} (MA: ${s.rsi.ma != null ? s.rsi.ma.toFixed(1) : '?'})`);
  }
  if (s.macd) {
    lines.push(`MACD: ${s.macd.label || '?'} (hist: ${s.macd.hist != null ? s.macd.hist.toFixed(2) : '?'}, delta: ${s.macd.histDelta != null ? s.macd.histDelta.toFixed(4) : '?'})`);
  }
  if (s.vwap) {
    lines.push(`VWAP: $${s.vwap.value != null ? Math.round(s.vwap.value) : '?'} (dist: ${s.vwap.dist != null ? (s.vwap.dist * 100).toFixed(3) + '%' : '?'}, slope: ${s.vwap.slopeLabel || '?'})`);
  }
  if (s.delta1m != null || s.delta3m != null) {
    lines.push(`Price Delta 1m: ${s.delta1m != null ? (s.delta1m > 0 ? '+' : '') + '$' + s.delta1m.toFixed(2) : '?'}  |  3m: ${s.delta3m != null ? (s.delta3m > 0 ? '+' : '') + '$' + s.delta3m.toFixed(2) : '?'}`);
  }
  if (s.bollinger) {
    lines.push(`Bollinger Bands: %B=${s.bollinger.pctB.toFixed(2)}, bandwidth=${(s.bollinger.bandwidth * 100).toFixed(3)}%, upper=$${Math.round(s.bollinger.upper)}, lower=$${Math.round(s.bollinger.lower)}`);
  }
  if (s.emaCross) {
    lines.push(`EMA 9/21: ${s.emaCross.signal}${s.emaCross.crossUp ? ' (JUST CROSSED UP)' : s.emaCross.crossDown ? ' (JUST CROSSED DOWN)' : ''}, diff=${s.emaCross.diff?.toFixed(2) ?? '?'}`);
  }
  if (s.stochastic) {
    lines.push(`Stochastic: K=${s.stochastic.k.toFixed(1)}, D=${s.stochastic.d.toFixed(1)} — ${s.stochastic.signal}`);
  }
  if (s.atr) {
    lines.push(`ATR(14): $${s.atr.atr.toFixed(2)} (${s.atr.atrPct?.toFixed(3) ?? '?'}%) — Volatility: ${s.atr.volRegime || '?'}`);
  }
  if (s.obv) {
    lines.push(`OBV Trend: ${s.obv.trend}`);
  }
  if (s.signalAgreement) {
    lines.push(`Signal Agreement: ${s.signalAgreement.bullish} bullish / ${s.signalAgreement.bearish} bearish / ${s.signalAgreement.total} total → ${s.signalAgreement.direction} (${(s.signalAgreement.strength * 100).toFixed(0)}%)`);
  }
  if (s.regime) {
    lines.push(`Regime: ${s.regime}`);
  }
  lines.push(``);

  lines.push(`=== MODEL EDGE ===`);
  if (s.rec) {
    lines.push(`TA recommendation: ${s.rec.action === 'ENTER' ? s.rec.side + ' (' + s.rec.phase + ', ' + s.rec.strength + ')' : 'NO TRADE (' + s.rec.phase + ')'}`);
    if (s.rec.edgeUp != null) lines.push(`Edge UP: ${(s.rec.edgeUp * 100).toFixed(1)}%  |  Edge DOWN: ${(s.rec.edgeDown * 100).toFixed(1)}%`);
  }

  // ── Agent learning context (from past trade history) ──
  if (s.agentLearnings) {
    lines.push(``);
    lines.push(s.agentLearnings);
    lines.push(``);
    lines.push(`IMPORTANT: Apply the lessons above to improve your current prediction. Avoid the same mistakes.`);
  }

  lines.push(``);
  lines.push(`Based on ALL the above data, what is your prediction for this 15-minute window? Will BTC settle UP or DOWN vs the Price to Beat?`);

  return lines.join('\n');
}

/* ── Call a Single Provider ───────────────────────────── */

async function callProvider(provider, userPrompt) {
  const st = provider.state;
  const now = Date.now();
  const intervalMs = INTERVAL_SEC * 1000;

  if (st.pending || (st.lastCallMs && now - st.lastCallMs < intervalMs)) {
    return { enabled: true, analysis: st.lastAnalysis, cached: true, providerId: provider.id, providerName: provider.name, model: provider.model };
  }

  st.pending = true;
  try {
    // o3 / o3-mini are reasoning models — they don't support temperature, max_tokens, or system role
    const isReasoningModel = /^o[0-9]/.test(provider.model);

    const opts = { model: provider.model };

    if (isReasoningModel) {
      // Reasoning models: use 'developer' role instead of 'system', no temperature/max_tokens
      opts.messages = [
        { role: 'developer', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt + '\n\nRespond with ONLY valid JSON, no markdown.' }
      ];
      opts.max_completion_tokens = 2000;
    } else {
      opts.messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ];
      opts.temperature = 0.3;
      opts.max_tokens = 400;
      opts.response_format = { type: 'json_object' };
    }

    const response = await provider.client.chat.completions.create(opts);

    // ── Track token usage ──
    const resUsage = response.usage;
    if (resUsage) {
      const promptT = resUsage.prompt_tokens || 0;
      const completionT = resUsage.completion_tokens || 0;
      const totalT = resUsage.total_tokens || (promptT + completionT);
      const cost = estimateCost(provider.model, promptT, completionT);

      const u = provider.usage;
      u.totalRequests++;
      u.totalPromptTokens += promptT;
      u.totalCompletionTokens += completionT;
      u.totalTokens += totalT;
      u.totalCost += cost;
      u.history.push({ ts: now, prompt: promptT, completion: completionT, cost });

      // Trim history older than 7 days
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      u.history = u.history.filter(h => h.ts >= weekAgo);
    }

    const content = response.choices?.[0]?.message?.content ?? '';
    let parsed;
    try {
      // Some models wrap JSON in markdown code blocks
      const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { direction: 'UNKNOWN', confidence: 0, reasoning: content, key_factors: [] };
    }

    const direction = String(parsed.direction || '').toUpperCase();
    const confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 0));
    const reasoning = String(parsed.reasoning || '');
    const keyFactors = Array.isArray(parsed.key_factors) ? parsed.key_factors.map(String) : [];

    st.lastAnalysis = {
      direction: direction === 'UP' || direction === 'DOWN' ? direction : 'UNKNOWN',
      confidence, reasoning, keyFactors,
      model: provider.model,
      providerId: provider.id,
      providerName: provider.name,
      updatedAt: new Date().toISOString(),
      updatedAtMs: now,
    };

    st.lastCallMs = now;
    console.log(`  [ai:${provider.id}] ${st.lastAnalysis.direction} ${st.lastAnalysis.confidence}% — ${st.lastAnalysis.reasoning.slice(0, 80)}`);

    return { enabled: true, analysis: st.lastAnalysis, cached: false, providerId: provider.id, providerName: provider.name, model: provider.model };
  } catch (err) {
    console.error(`  [ai:${provider.id}] error: ${err?.message ?? String(err)}`);
    return { enabled: true, analysis: st.lastAnalysis, cached: true, error: err?.message, providerId: provider.id, providerName: provider.name, model: provider.model };
  } finally {
    st.pending = false;
  }
}

/* ── Public API ──────────────────────────────────────── */

/**
 * Get analysis from ALL configured providers in parallel.
 * Returns { primary, providers: { deepseek: {...}, openai: {...} }, activeProvider }
 */
export async function getAllAiAnalyses(snapshot) {
  const providerIds = Object.keys(PROVIDERS);
  if (providerIds.length === 0) {
    return {
      primary: { enabled: false, analysis: null, error: 'No AI providers configured' },
      providers: {},
      activeProvider: '',
      availableProviders: [],
    };
  }

  // Don't call if we don't have enough data
  if (snapshot.chainlinkPrice == null && snapshot.binancePrice == null) {
    const cached = {};
    for (const id of providerIds) {
      const p = PROVIDERS[id];
      cached[id] = { enabled: true, analysis: p.state.lastAnalysis, cached: true, error: 'waiting for price data', providerId: id, providerName: p.name, model: p.model };
    }
    return {
      primary: cached[activeProviderId] || Object.values(cached)[0],
      providers: cached,
      activeProvider: activeProviderId,
      availableProviders: providerIds.map(id => ({ id, name: PROVIDERS[id].name, model: PROVIDERS[id].model })),
    };
  }

  const userPrompt = buildUserPrompt(snapshot);

  // Call all providers in parallel
  const results = await Promise.all(
    providerIds.map(async id => {
      const result = await callProvider(PROVIDERS[id], userPrompt);
      return [id, result];
    })
  );

  const providers = {};
  for (const [id, result] of results) providers[id] = result;

  return {
    primary: providers[activeProviderId] || Object.values(providers)[0],
    providers,
    activeProvider: activeProviderId,
    availableProviders: providerIds.map(id => ({ id, name: PROVIDERS[id].name, model: PROVIDERS[id].model })),
  };
}

/** Force refresh for one or all providers */
export function forceNextRefresh(providerId) {
  if (providerId && PROVIDERS[providerId]) {
    PROVIDERS[providerId].state.lastCallMs = 0;
  } else {
    for (const p of Object.values(PROVIDERS)) p.state.lastCallMs = 0;
  }
}

/** Switch the primary (active) provider */
export function setActiveProvider(id) {
  if (PROVIDERS[id]) {
    activeProviderId = id;
    console.log(`  [ai] primary provider switched to: ${id} (${PROVIDERS[id].name} / ${PROVIDERS[id].model})`);
    return true;
  }
  return false;
}

export function getActiveProviderId() { return activeProviderId; }

export function isAiEnabled() {
  return Object.keys(PROVIDERS).length > 0;
}

export function getProviderInfo() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name, model: p.model, active: id === activeProviderId,
    hasAnalysis: !!p.state.lastAnalysis,
  }));
}

/** Return usage/cost stats for all providers (for the models page) */
export function getModelStats() {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo  = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  return Object.entries(PROVIDERS).map(([id, p]) => {
    const u = p.usage;
    const hourHist = u.history.filter(h => h.ts >= hourAgo);
    const dayHist  = u.history.filter(h => h.ts >= dayAgo);
    const weekHist = u.history.filter(h => h.ts >= weekAgo);

    const sumTokens = (arr) => arr.reduce((s, h) => s + h.prompt + h.completion, 0);
    const sumCost   = (arr) => arr.reduce((s, h) => s + h.cost, 0);

    return {
      id,
      name: p.name,
      model: p.model,
      active: id === activeProviderId,
      usage: {
        lastHour:   { tokens: sumTokens(hourHist), requests: hourHist.length, cost: sumCost(hourHist) },
        last24h:    { tokens: sumTokens(dayHist),  requests: dayHist.length,  cost: sumCost(dayHist) },
        lastWeek:   { tokens: sumTokens(weekHist), requests: weekHist.length, cost: sumCost(weekHist) },
        allTime:    { tokens: u.totalTokens, requests: u.totalRequests, cost: u.totalCost },
      },
    };
  });
}
