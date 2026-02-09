# Polymarket BTC 15m Assistant

A real-time **web dashboard** and **AI-powered trading assistant** for Polymarket's "Bitcoin Up or Down" 15-minute prediction markets.

## Features

- **Live Dashboard** — Real-time price tracking (Chainlink, Binance), Polymarket odds, candlestick chart
- **Dual AI Models** — DeepSeek + OpenAI (o3) running in parallel with consensus detection
- **12 Technical Indicators** — RSI, MACD, VWAP, Heiken Ashi, Bollinger Bands, EMA Cross, Stochastic, ATR, OBV, Signal Agreement, and more
- **Paper Trading Agent** — Autonomous background agent that trades based on AI analysis, learns from mistakes, and improves over time
- **Risk Analysis** — Max drawdown, Sharpe ratio, Kelly criterion, profit factor, expected value
- **Martingale Strategy** — Optional position sizing that increases after losses
- **AI Models Dashboard** — Side-by-side model comparison with token usage and cost tracking
- **Trade Journal** — Full trade history with AI reasoning, indicator accuracy, lessons learned
- **Authentication** — Login system with first-time admin setup

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/haythamforever/PolymarketBTC15mAssistant.git
cd PolymarketBTC15mAssistant
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:
- `DEEPSEEK_API_KEY` — Get from [DeepSeek](https://platform.deepseek.com/)
- `OPENAI_API_KEY` — Get from [OpenAI](https://platform.openai.com/)

### 3. Run

```bash
npm start
```

Open `http://localhost:3000` in your browser. First visit will prompt you to create an admin account.

## Pages

| Route | Description |
|-------|-------------|
| `/` | Main dashboard — prices, chart, indicators, AI analysis, paper trader |
| `/trades` | Trade history, lessons learned, agent learning, recent mistakes |
| `/models` | AI model comparison, token usage & cost tracking |

## Environment Variables

See [`.env.example`](.env.example) for all available configuration options.

### Key Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `AI_PRIMARY_PROVIDER` | `deepseek` | Which AI drives paper trading (`deepseek` or `openai`) |
| `AI_INTERVAL_SECONDS` | `30` | How often to call AI models |
| `DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek model name |
| `OPENAI_MODEL` | `o3` | OpenAI model name |

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

1. Connect your GitHub repo
2. Set environment variables in Railway dashboard (copy from your `.env`)
3. Railway auto-detects Node.js and deploys

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: Vanilla JS, Lightweight Charts
- **AI**: OpenAI SDK (compatible with DeepSeek and OpenAI)
- **Data**: Polymarket API, Binance API, Chainlink (Polygon)

## Safety

This is not financial advice. Paper trading only — no real money is at risk. Use at your own risk.
