# ◈ SOL/USDC Autonomous Paper-Trading Engine

**Professional paper-trading terminal for Solana** — real-time SOL/USDC prices from
[Jupiter](https://jup.ag), an autonomous AI+rule trading engine, take-profit/stop-loss
execution against real routed swap quotes, and a live signal chart. Rust CLI for
backtesting + a Vercel-deployed web interface.

![status](https://img.shields.io/badge/paper_trading-simulated_fills-6366f1)
![rust](https://img.shields.io/badge/engine-rust%20%2B%20wasm--ready%20js-orange)
![deploy](https://img.shields.io/badge/deploy-Vercel-black)

---

## What it does

- **Real market data** — polls Jupiter `/price/v3` for mid-market SOL price and
  `/swap/v1/quote` for executable routed swaps (real AMM routing, slippage, price impact).
- **Autonomous engine** — every tick: exit checks first (SL/TP/signal collapse), then
  entry decisions gated by cooldown, drawdown halt, and conviction-scaled sizing.
- **Signal ensemble** — EMA(9/21) trend + momentum confirmation + RSI gate, blended with
  an **online logistic regression** that learns per-tick whether price rises over a
  10-tick horizon (SGD, weights persist across restarts).
- **Risk layer** — stop-loss −2%, take-profit +4%, 10-tick post-loss cooldown,
  15% drawdown halt, 30–60% equity sizing with USDC reserve.
- **Paper fills** — simulated against live Jupiter quotes with 10 bps modeled fee;
  no keys, no funds, no on-chain transactions.
- **Web terminal** — price chart with EMA overlays, entry/TP/SL lines, buy/sell markers,
  RSI pane, equity curve, position card with unrealized PnL, execution log.

## Architecture

```
                ┌──────────────────────────── Vercel ────────────────────────────┐
                │                                                                │
 Browser ──────▶│  /api/price   ──▶ Jupiter /price/v3   (5s edge cache)          │
 (SPA, static)  │  /api/quote   ──▶ Jupiter /swap/v1/quote (routed quotes)       │
                │  /            ──▶ public/index.html   (terminal UI)            │
                └────────────────────────────────────────────────────────────────┘
                        │
                        ▼
              engine.js (client): faithful JS port of the Rust engine
              signals → AI → risk → broker → localStorage persistence

 Rust CLI (this repo): same engine, CSV replay backtests, cargo test suite
```

## Repository layout

```
├── src/                    # Rust engine (lib + CLI)
│   ├── config.rs           #   typed config (fully defaulted)
│   ├── feed.rs             #   Jupiter price/quote clients
│   ├── strategy.rs         #   EMA + momentum + RSI rule layer
│   ├── ai.rs               #   online logistic regression (SGD)
│   ├── risk.rs             #   SL/TP, cooldown, drawdown halt, sizing
│   ├── broker.rs           #   paper fills with fee model
│   ├── engine.rs           #   decision loop + fill providers
│   └── state.rs            #   atomic JSON persistence
├── web/                    # Vercel-deployed web terminal
│   ├── api/                #   serverless functions (price, quote, health)
│   └── public/             #   SPA: chart.js, engine.js (JS port), app.js
├── data/                   # sample CSV for replay backtests
├── config.toml             # engine configuration (dev)
├── config.longrun.toml     # 24x7 daemon profile (60s ticks)
├── paper-engine.service    # systemd unit for long-run operation
└── scripts/install-service.sh  # one-command service installer
```

## Rust engine — quick start

```bash
cargo build --release

# Paper-trade live against real Jupiter prices (30s ticks, resumes state)
cargo run --release -- live

# Deterministic backtest over a CSV (timestamp_ms,price)
cargo run --release -- replay data/sample_prices.csv --fresh

# Inspect / reset persisted state
cargo run --release -- status
cargo run --release -- reset
```

## Long-run operation (24/7 daemon)

The engine is built for unattended continuous running:

- **Feed errors never kill the daemon** — transient Jupiter failures back off
  exponentially (5s → 10s → … capped at 10 min) and resume automatically.
- **Graceful shutdown** — SIGTERM/SIGINT save state before exit, so a systemd
  `Restart=always` cycle resumes from the last good tick.
- **State-resume** — verified: stop at tick N, restart, continue at tick N+1.

```bash
# Run directly (60s ticks, rate-limit-friendly profile)
cargo run --release -- --config config.longrun.toml live

# Or install as a systemd service (auto-start on boot, auto-restart on crash)
cargo build --release
sudo ./scripts/install-service.sh
journalctl -u paper-engine -f     # follow live ticks
```

## Production notes (researched stack choices)

- **Jupiter API**: uses `api.jup.ag` (the official gateway). `lite-api.jup.ag`
  is being phased out with progressively reduced rate limits. For sustained
  24/7 polling, [get a free API key](https://dev.jup.ag) (1 RPS free tier;
  $25/mo Developer tier for more) and add it per Jupiter's docs.
- **Charts**: the web terminal uses **TradingView Lightweight Charts v5** —
  the industry-standard open-source library (17k★, 35KB) — with real OHLC
  candles, 1m/5m/15m/1h timeframes, crosshair, zoom/pan, price lines and
  trade markers.
- **Beyond paper trading** (execution stack used by production Solana
  systems): Yellowstone gRPC (Geyser) for sub-block price streams, Jito
  bundles for execution, and engines like NautilusTrader as a reference
  architecture for deterministic event-driven design. This repo's paper
  engine is a stepping stone toward that stack.

## Web terminal

Deployed on Vercel (API functions proxy Jupiter; SPA runs the engine client-side with
localStorage persistence — your paper wallet lives in your browser).
Light theme, fully responsive, timeframe-switchable candlestick chart.

```bash
cd web
npm run dev        # local static preview
npm run deploy     # vercel --prod
```
## Configuration

Every knob lives in `config.toml` (Rust) / `DEFAULTS` in `web/public/engine.js` (web):

| Section | Controls |
|---|---|
| `[engine]` | tick cadence, history window, initial capital |
| `[strategy]` | EMA periods, RSI band, momentum window, entry/exit thresholds |
| `[ai]` | learning rate, L2, label horizon, blend weight |
| `[risk]` | SL/TP (bps), cooldown, sizing caps, reserve, drawdown halt |
| `[fees]` | modeled execution fee, replay slippage |

## Verified behavior

- **Rust replay backtest** (121 ticks: uptrend → −18% crash → choppy recovery):
  4 entries, 2 take-profits, 2 stop-losses, **+1.5% net equity through the crash**,
  conviction-scaled sizing observed (334 → 402 → 436 USDC).
- **Live smoke** vs real Jupiter prices: warmup stand-aside, state persistence,
  resume-from-tick, AI label resolution across restarts.
- **JS port parity**: same scenario passes in `web/public/engine.js` (entry →
  take-profit → cooldown gate).

## Limitations

- Paper trading only. Fills assume the fetched quote is executable at fetch time; real
  execution adds latency, partials, and MEV.
- Long-only (flat or long), no shorting, no leverage.
- Jupiter lite-api is rate-limited; set `api.base_url` to `api.jup.ag` with a key for
  heavy polling.
- 21-tick warmup: the engine stands flat for the first ~10 minutes of a fresh run.
- Not investment advice.

## License

MIT
