//! Engine: per-tick decision loop wiring feed, signals, AI, risk, and broker.

use crate::ai;
use crate::broker::{self, Fill};
use crate::config::Config;
use crate::feed::JupiterFeed;
use crate::risk::{self, ExitReason};
use crate::state::{EngineState, Position};
use crate::strategy::rule_signal;
use anyhow::{Context, Result};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Where a fill's gross output came from.
#[async_trait::async_trait]
pub trait FillProvider: Send {
    async fn usdc_to_sol(&mut self, usdc: f64) -> Result<f64>;
    async fn sol_to_usdc(&mut self, sol: f64) -> Result<f64>;
}

/// Live provider: routed Jupiter quotes (real AMM routing, slippage, impact).
pub struct LiveFillProvider {
    feed: JupiterFeed,
}

impl LiveFillProvider {
    pub fn new(feed: JupiterFeed) -> Self {
        Self { feed }
    }
    /// Mid-market price used for signal scoring.
    pub async fn price(&mut self) -> Result<f64> {
        self.feed.sol_price().await
    }
}

#[async_trait::async_trait]
impl FillProvider for LiveFillProvider {
    async fn usdc_to_sol(&mut self, usdc: f64) -> Result<f64> {
        let q = self.feed.quote_usdc_to_sol(usdc).await.context("USDC->SOL quote")?;
        let raw: f64 = q.out_amount.parse().context("outAmount parse")?;
        Ok(raw / 1e9) // SOL has 9 decimals
    }
    async fn sol_to_usdc(&mut self, sol: f64) -> Result<f64> {
        let q = self.feed.quote_sol_to_usdc(sol).await.context("SOL->USDC quote")?;
        let raw: f64 = q.out_amount.parse().context("outAmount parse")?;
        Ok(raw / 1e6) // USDC has 6 decimals
    }
}

/// Replay provider: deterministic synthetic fills from the tick price.
pub struct ReplayFillProvider {
    price: f64,
    slippage_bps: u64,
}

impl ReplayFillProvider {
    pub fn new(slippage_bps: u64) -> Self {
        Self { price: 0.0, slippage_bps }
    }
    pub fn set_price(&mut self, price: f64) {
        self.price = price;
    }
}

#[async_trait::async_trait]
impl FillProvider for ReplayFillProvider {
    async fn usdc_to_sol(&mut self, usdc: f64) -> Result<f64> {
        let slip = self.slippage_bps as f64 / 10_000.0;
        Ok(usdc / (self.price * (1.0 + slip)))
    }
    async fn sol_to_usdc(&mut self, sol: f64) -> Result<f64> {
        let slip = self.slippage_bps as f64 / 10_000.0;
        Ok(sol * self.price * (1.0 - slip))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TickOutcome {
    pub tick: u64,
    pub price: f64,
    pub score: f64,
    pub action: String,
    pub fill: Option<Fill>,
}

pub struct Engine {
    pub state: EngineState,
    cfg: Config,
    persist: bool,
}

impl Engine {
    pub fn new(state: EngineState, cfg: Config) -> Self {
        Self { state, cfg, persist: true }
    }

    /// In-memory engine (tests / ephemeral replay); never touches disk.
    pub fn ephemeral(state: EngineState, cfg: Config) -> Self {
        Self { state, cfg, persist: false }
    }

    pub async fn act(
        &mut self,
        price: f64,
        provider: &mut dyn FillProvider,
    ) -> Result<TickOutcome> {
        let outcome = self.decide(price, provider).await?;
        if self.persist {
            self.state.save(Path::new(&self.cfg.engine.state_path))?;
            self.append_equity(price)?;
            if let Some(f) = &outcome.fill {
                self.append_fill(f, &outcome.action)?;
            }
        }
        Ok(outcome)
    }

    async fn decide(
        &mut self,
        price: f64,
        provider: &mut dyn FillProvider,
    ) -> Result<TickOutcome> {
        let cfg = self.cfg.clone();
        self.state.tick += 1;
        let tick = self.state.tick;

        // 1. Resolve matured learning labels against the fresh price.
        self.state.ai.resolve_pending(tick, price, &cfg.ai);

        // 2. Update rolling price window.
        self.state.price_history.push(price);
        let hist_len = cfg.engine.history_len;
        if self.state.price_history.len() > hist_len {
            let drop = self.state.price_history.len() - hist_len;
            self.state.price_history.drain(0..drop);
        }

        // 3. Update equity & peak equity for all decisions (exits and entries).
        let equity = self.state.equity(price);
        self.state.peak_equity = self.state.peak_equity.max(equity);

        // 4. Compute signal once: rule + AI blend.
        let hist = &self.state.price_history;
        let (score, feats) = match rule_signal(hist, &cfg.strategy) {
            Some(sig) => {
                let f = ai::features(
                    sig.score,
                    sig.momentum,
                    ret(hist, 1),
                    ret(hist, 5),
                    sig.rsi,
                );
                let p_up = self.state.ai.predict(&f);
                let blended = (cfg.strategy.rule_weight * sig.score
                    + cfg.ai.ai_weight * (p_up - 0.5) * 2.0)
                    .clamp(-1.0, 1.0);
                (blended, f)
            }
            None => (0.0, ai::features(0.0, 0.0, 0.0, 0.0, 50.0)),
        };

        // 5. Queue learning sample for this tick (labeled later).
        self.state.ai.pending.push(ai::PendingSample {
            tick,
            price,
            features: feats,
        });

        // 6. Exits take precedence over new entries.
        if let Some(pos) = self.state.position.clone() {
            let reason = risk::check_exit(pos.entry_price, price, &cfg.risk).or_else(|| {
                if score <= cfg.strategy.exit_score {
                    Some(ExitReason::Signal)
                } else {
                    None
                }
            });

            if let Some(reason) = reason {
                let fill = self.sell_all(provider).await?;
                let loss = fill.out_amount < pos.entry_price * fill.in_amount;
                if loss {
                    self.state.last_loss_tick = Some(tick);
                }
                self.state.position = None;
                return Ok(TickOutcome {
                    tick,
                    price,
                    score,
                    action: format!("exit:{}", reason.as_str()),
                    fill: Some(fill),
                });
            }
            return Ok(TickOutcome {
                tick,
                price,
                score,
                action: format!("hold:score={score:.3}"),
                fill: None,
            });
        }

        // 7. Entry checks: cooldown, drawdown halt, conviction sizing.
        let cooldown_active = self
            .state
            .last_loss_tick
            .map(|lt| tick - lt < cfg.risk.cooldown_ticks)
            .unwrap_or(false);
        let halted = risk::drawdown_halted(self.state.peak_equity, equity, &cfg.risk);
        if cooldown_active || halted {
            return Ok(TickOutcome {
                tick,
                price,
                score,
                action: if cooldown_active {
                    format!("stand_down:cooldown:score={score:.3}")
                } else {
                    format!("stand_down:drawdown_halt:score={score:.3}")
                },
                fill: None,
            });
        }

        let order = risk::position_usdc(
            score,
            cfg.strategy.entry_score,
            equity,
            self.state.balances.usdc,
            &cfg.risk,
        );
        let Some(usdc_in) = order else {
            return Ok(TickOutcome {
                tick,
                price,
                score,
                action: format!("stand_aside:score={score:.3}"),
                fill: None,
            });
        };

        let sol_gross = provider.usdc_to_sol(usdc_in).await?;
        if !(sol_gross.is_finite() && sol_gross > 0.0) {
            return Ok(TickOutcome {
                tick,
                price,
                score,
                action: "stand_aside:bad_quote".to_string(),
                fill: None,
            });
        }
        let fill = broker::apply_buy(
            &mut self.state.balances,
            usdc_in,
            sol_gross,
            cfg.fees.fee_bps,
        );
        self.state.position = Some(Position {
            sol: fill.out_amount,
            entry_price: fill.effective_price,
            entry_tick: tick,
        });
        Ok(TickOutcome {
            tick,
            price,
            score,
            action: format!("enter:score={score:.3}"),
            fill: Some(fill),
        })
    }

    pub async fn sell_all(&mut self, provider: &mut dyn FillProvider) -> Result<Fill> {
        let sol = self.state.balances.sol;
        let usdc_gross = provider.sol_to_usdc(sol).await?;
        let fill = broker::apply_sell(
            &mut self.state.balances,
            sol,
            usdc_gross,
            self.cfg.fees.fee_bps,
        );
        Ok(fill)
    }

    fn append_equity(&self, price: f64) -> Result<()> {
        let equity = self.state.equity(price);
        let path = Path::new(&self.cfg.engine.equity_path);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(
            f,
            "{{\"tick\":{},\"price\":{},\"equity\":{}}}",
            self.state.tick, price, equity
        )?;
        Ok(())
    }

    fn append_fill(&self, fill: &Fill, action: &str) -> Result<()> {
        let path = PathBuf::from(&self.cfg.engine.fills_path);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(
            f,
            "{{\"tick\":{},\"action\":\"{}\",\"side\":\"{}\",\"in\":{:.4},\"out\":{:.6},\"effective_price\":{:.4},\"fee\":{:.6}}}",
            self.state.tick, action, fill.side, fill.in_amount, fill.out_amount, fill.effective_price, fill.fee_amount
        )?;
        Ok(())
    }
}

/// Fractional return over the last `n` ticks; 0.0 when insufficient history.
fn ret(hist: &[f64], n: usize) -> f64 {
    if hist.len() < n + 1 || n == 0 {
        return 0.0;
    }
    let last = hist[hist.len() - 1];
    let prev = hist[hist.len() - 1 - n];
    if prev <= 0.0 {
        return 0.0;
    }
    (last - prev) / prev
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn test_cfg() -> Config {
        let mut c = Config::default();
        c.strategy.ema_fast = 3;
        c.strategy.ema_slow = 5;
        c.strategy.rsi_period = 4;
        c.strategy.momentum_ticks = 4;
        c.strategy.entry_score = 0.1;
        c.strategy.exit_score = -0.25;
        c.risk.stop_loss_bps = 200;
        c.risk.take_profit_bps = 400;
        c.risk.cooldown_ticks = 5;
        c.risk.reserve_usdc = 5.0;
        c.risk.min_order_usdc = 10.0;
        c.engine.history_len = 100;
        c
    }

    /// +1% / -0.5% alternating: net drift +0.25%/tick, RSI ~67 (in band).
    fn healthy_uptrend() -> Vec<f64> {
        let mut p = vec![100.0];
        for i in 0..15 {
            let last = *p.last().unwrap();
            p.push(if i % 2 == 0 { last * 1.01 } else { last * 0.995 });
        }
        p
    }

    #[tokio::test]
    async fn trend_entry_and_take_profit_exit() {
        let cfg = test_cfg();
        let mut engine = Engine::ephemeral(EngineState::new(1000.0), cfg);
        let mut provider = ReplayFillProvider::new(0);

        let mut saw_entry = false;
        for &px in healthy_uptrend().iter() {
            provider.set_price(px);
            let out = engine.act(px, &mut provider).await.unwrap();
            if out.action.starts_with("enter") {
                saw_entry = true;
            }
        }
        assert!(saw_entry, "engine must enter long during uptrend");
        assert!(engine.state.position.is_some());

        // +5% jump above entry triggers take-profit.
        let ep = engine.state.position.as_ref().unwrap().entry_price;
        provider.set_price(ep * 1.05);
        let out = engine.act(ep * 1.05, &mut provider).await.unwrap();
        assert!(
            out.action.starts_with("exit:take_profit"),
            "action = {}",
            out.action
        );
        assert!(engine.state.position.is_none());
        assert!(engine.state.balances.sol.abs() < 1e-12);
        assert!(engine.state.balances.usdc > 1000.0);
    }

    #[tokio::test]
    async fn crash_triggers_stop_loss_and_cooldown_blocks_reentry() {
        let cfg = test_cfg();
        let mut engine = Engine::ephemeral(EngineState::new(1000.0), cfg);
        let mut provider = ReplayFillProvider::new(0);

        for &px in healthy_uptrend().iter() {
            provider.set_price(px);
            let _ = engine.act(px, &mut provider).await.unwrap();
        }
        assert!(engine.state.position.is_some());
        let ep = engine.state.position.as_ref().unwrap().entry_price;

        // Crash -3%: stop-loss fires.
        provider.set_price(ep * 0.97);
        let out = engine.act(ep * 0.97, &mut provider).await.unwrap();
        assert!(
            out.action.starts_with("exit:stop_loss"),
            "action = {}",
            out.action
        );
        assert!(engine.state.last_loss_tick.is_some());

        // Exactly 4 recovery ticks (all inside the 5-tick cooldown window):
        // every single tick must stand down due to cooldown.
        for i in 1..=4 {
            let px = ep * 0.97 + (i as f64) * 0.5;
            provider.set_price(px);
            let out = engine.act(px, &mut provider).await.unwrap();
            assert!(
                out.action.starts_with("stand_down:cooldown"),
                "tick {i} should be blocked by cooldown, got {}",
                out.action
            );
        }
        assert!(engine.state.position.is_none());
        assert!(engine.state.balances.sol.abs() < 1e-12);
    }

    #[tokio::test]
    async fn position_never_exceeds_cap() {
        let cfg = test_cfg();
        let mut engine = Engine::ephemeral(EngineState::new(1000.0), cfg);
        let mut provider = ReplayFillProvider::new(0);
        for &px in healthy_uptrend().iter() {
            provider.set_price(px);
            let _ = engine.act(px, &mut provider).await.unwrap();
        }
        let p = engine.state.position.unwrap();
        let deployed = p.entry_price * p.sol;
        assert!(
            deployed <= 600.0 + 1e-9,
            "deployed {deployed} exceeds 60% cap"
        );
        assert!(deployed >= 300.0, "deployed {deployed} below base sizing");
    }

    #[tokio::test]
    async fn drawdown_halt_blocks_entries() {

        let mut cfg = test_cfg();
        cfg.risk.max_drawdown_pct = 5.0; // tight threshold so crash trips it
        let mut engine = Engine::ephemeral(EngineState::new(1000.0), cfg);
        let mut provider = ReplayFillProvider::new(0);

        for &px in healthy_uptrend().iter() {
            provider.set_price(px);
            let _ = engine.act(px, &mut provider).await.unwrap();
        }
        assert!(engine.state.position.is_some());
        let ep = engine.state.position.as_ref().unwrap().entry_price;

        // Crash 50%: stop loss sells at 50% loss, equity drops ~15% > 5% threshold.
        provider.set_price(ep * 0.5);
        let out = engine.act(ep * 0.5, &mut provider).await.unwrap();
        assert!(out.action.starts_with("exit:stop_loss"));

        // 8 recovery ticks: ticks 1-4 are inside cooldown, ticks 5-8 are
        // outside cooldown but MUST be blocked by drawdown halt.
        let mut saw_cooldown = false;
        let mut saw_halt = false;
        for i in 1..=8 {
            let px = ep * 0.5 + (i as f64) * 1.0;
            provider.set_price(px);
            let out = engine.act(px, &mut provider).await.unwrap();
            if out.action.starts_with("stand_down:cooldown") {
                saw_cooldown = true;
            } else if out.action.starts_with("stand_down:drawdown_halt") {
                saw_halt = true;
            } else {
                panic!("unexpected action during recovery: {}", out.action);
            }
        }
        assert!(saw_cooldown, "cooldown must be observed first");
        assert!(saw_halt, "drawdown halt must persist after cooldown expires");
    }
}
