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
└── config.toml             # engine configuration
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

`cargo test` — 22 tests: trend entry, take-profit, crash stop-loss, cooldown
stand-down, drawdown halt, sizing caps, fee math, state roundtrip, AI convergence.

## Web terminal

Deployed on Vercel (API functions proxy Jupiter; SPA runs the engine client-side with
localStorage persistence — your paper wallet lives in your browser).

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
