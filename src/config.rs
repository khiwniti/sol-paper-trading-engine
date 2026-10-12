//! Configuration loaded from `config.toml` (fully defaulted in code for tests).

use anyhow::Result;
use serde::Deserialize;
use std::path::Path;

pub const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub mints: MintsCfg,
    pub api: ApiCfg,
    pub engine: EngineCfg,
    pub strategy: StrategyCfg,
    pub ai: AiCfg,
    pub risk: RiskCfg,
    pub fees: FeesCfg,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct MintsCfg {
    pub sol: String,
    pub usdc: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ApiCfg {
    pub base_url: String,
    pub slippage_bps: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct EngineCfg {
    pub tick_interval_ms: u64,
    pub history_len: usize,
    pub initial_usdc: f64,
    pub state_path: String,
    pub fills_path: String,
    pub equity_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct StrategyCfg {
    pub ema_fast: usize,
    pub ema_slow: usize,
    pub rsi_period: usize,
    pub rsi_overbought: f64,
    pub rsi_oversold: f64,
    pub momentum_ticks: usize,
    pub rule_weight: f64,
    pub entry_score: f64,
    pub exit_score: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct AiCfg {
    pub learning_rate: f64,
    pub l2: f64,
    pub horizon_ticks: u64,
    pub up_move_bps: u64,
    pub ai_weight: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RiskCfg {
    pub stop_loss_bps: u64,
    pub take_profit_bps: u64,
    pub cooldown_ticks: u64,
    pub base_position_pct: f64,
    pub max_position_pct: f64,
    pub min_order_usdc: f64,
    pub reserve_usdc: f64,
    pub max_drawdown_pct: f64,
}


#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct FeesCfg {
    pub fee_bps: u64,
    pub replay_slippage_bps: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mints: MintsCfg::default(),
            api: ApiCfg::default(),
            engine: EngineCfg::default(),
            strategy: StrategyCfg::default(),
            ai: AiCfg::default(),
            risk: RiskCfg::default(),
            fees: FeesCfg::default(),
        }
    }
}

impl Default for MintsCfg {
    fn default() -> Self {
        Self { sol: SOL_MINT.to_string(), usdc: USDC_MINT.to_string() }
    }
}

impl Default for ApiCfg {
    fn default() -> Self {
        Self { base_url: "https://api.jup.ag".to_string(), slippage_bps: 20 }
    }
}

impl Default for EngineCfg {
    fn default() -> Self {
        Self {
            tick_interval_ms: 30_000,
            history_len: 120,
            initial_usdc: 1000.0,
            state_path: "state/paper_state.json".to_string(),
            fills_path: "state/fills.jsonl".to_string(),
            equity_path: "state/equity.jsonl".to_string(),
        }
    }
}

impl Default for StrategyCfg {
    fn default() -> Self {
        Self {
            ema_fast: 9,
            ema_slow: 21,
            rsi_period: 14,
            rsi_overbought: 72.0,
            rsi_oversold: 28.0,
            momentum_ticks: 20,
            rule_weight: 0.6,
            entry_score: 0.35,
            exit_score: -0.25,
        }
    }
}

impl Default for AiCfg {
    fn default() -> Self {
        Self {
            learning_rate: 0.05,
            l2: 0.0001,
            horizon_ticks: 10,
            up_move_bps: 20,
            ai_weight: 0.4,
        }
    }
}

impl Default for RiskCfg {
    fn default() -> Self {
        Self {
            stop_loss_bps: 200,
            take_profit_bps: 400,
            cooldown_ticks: 10,
            base_position_pct: 0.30,
            max_position_pct: 0.60,
            min_order_usdc: 10.0,
            reserve_usdc: 5.0,
            max_drawdown_pct: 15.0,
        }
    }
}

impl Default for FeesCfg {
    fn default() -> Self {
        Self { fee_bps: 10, replay_slippage_bps: 5 }
    }
}

impl StrategyCfg {
    /// Ticks required before any signal is trusted.
    pub fn warmup_ticks(&self) -> usize {
        self.ema_slow.max(self.rsi_period + 1).max(self.momentum_ticks + 1)
    }
}

impl Config {
    /// Load and parse a config file. Fails on unknown keys (typos) via deny_unknown_fields.
    pub fn load(path: &Path) -> Result<Config> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("cannot read config {}: {e}", path.display()))?;
        Ok(toml::from_str(&raw)?)
    }
}
