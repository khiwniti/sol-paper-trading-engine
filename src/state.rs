//! Persistent engine state: balances, position, history, AI weights.
//!
//! State is written atomically (temp file + rename) after every mutating tick
//! so a crash or Ctrl-C never corrupts the paper wallet.

use crate::ai::AiState;
use crate::broker::Balances;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub sol: f64,
    pub entry_price: f64,
    pub entry_tick: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineState {
    pub tick: u64,
    pub balances: Balances,
    pub position: Option<Position>,
    pub price_history: Vec<f64>,
    pub peak_equity: f64,
    pub last_loss_tick: Option<u64>,
    pub ai: AiState,
}

impl EngineState {
    pub fn new(initial_usdc: f64) -> Self {
        Self {
            tick: 0,
            balances: Balances { usdc: initial_usdc, sol: 0.0 },
            position: None,
            price_history: Vec::new(),
            peak_equity: initial_usdc,
            last_loss_tick: None,
            ai: AiState::new(),
        }
    }

    /// Equity in USDC terms at the given SOL price.
    pub fn equity(&self, sol_price: f64) -> f64 {
        self.balances.usdc + self.balances.sol * sol_price
    }

    pub fn load(path: &Path) -> anyhow::Result<Option<EngineState>> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(path)?;
        Ok(Some(serde_json::from_str(&raw)?))
    }

    /// Atomically persist state (write temp, then rename over the target).
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp: PathBuf = path.with_extension("json.tmp");
        let mut f = fs::File::create(&tmp)?;
        f.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
        f.flush()?;
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_all_fields() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let mut s = EngineState::new(500.0);
        s.tick = 7;
        s.balances.sol = 2.5;
        s.price_history = vec![100.0, 101.0, 102.0];
        s.peak_equity = 750.0;
        s.last_loss_tick = Some(3);
        s.ai.weights = vec![0.1, -0.2, 0.3, 0.0, 0.5, -0.6];
        s.ai.pending.push(crate::ai::PendingSample {
            tick: 5,
            price: 101.0,
            features: [1.0; crate::ai::FEATURES],
        });
        s.position = Some(Position { sol: 2.5, entry_price: 100.0, entry_tick: 4 });
        s.save(&p).unwrap();
        let loaded = EngineState::load(&p).unwrap().unwrap();
        assert_eq!(loaded.tick, 7);
        assert_eq!(loaded.balances.usdc, 500.0);
        assert_eq!(loaded.balances.sol, 2.5);
        assert_eq!(loaded.price_history, vec![100.0, 101.0, 102.0]);
        assert_eq!(loaded.peak_equity, 750.0);
        assert_eq!(loaded.last_loss_tick, Some(3));
        assert_eq!(loaded.ai.weights, s.ai.weights);
        assert_eq!(loaded.ai.pending.len(), 1);
        assert_eq!(loaded.position.as_ref().unwrap().entry_tick, 4);
    }

    #[test]
    fn load_missing_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(EngineState::load(&dir.path().join("nope.json")).unwrap().is_none());
    }

    #[test]
    fn equity_marks_position_to_market() {
        let mut s = EngineState::new(1000.0);
        s.balances.usdc = 400.0;
        s.balances.sol = 6.0;
        assert!((s.equity(100.0) - 1000.0).abs() < 1e-9);
    }
}
