//! Online learning layer: logistic regression trained per tick via SGD.
//!
//! The engine labels each past tick retroactively: "did price rise by at least
//! `up_move_bps` within `horizon_ticks`?" Each resolved label triggers one
//! SGD step. Weights persist in the engine state, so the model survives
//! restarts and keeps learning autonomously.

use crate::config::AiCfg;
use serde::{Deserialize, Serialize};

pub const FEATURES: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingSample {
    pub tick: u64,
    pub price: f64,
    pub features: [f64; FEATURES],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiState {
    pub weights: Vec<f64>,
    pub pending: Vec<PendingSample>,
    pub trained: u64,
}

impl AiState {
    pub fn new() -> Self {
        Self {
            weights: vec![0.0; FEATURES],
            pending: Vec::new(),
            trained: 0,
        }
    }

    pub fn sigmoid(z: f64) -> f64 {
        1.0 / (1.0 + (-z).exp())
    }

    /// Probability (0..1) that price rises over the horizon.
    pub fn predict(&self, x: &[f64; FEATURES]) -> f64 {
        let z: f64 = x
            .iter()
            .zip(self.weights.iter())
            .map(|(a, w)| a * w)
            .sum();
        Self::sigmoid(z)
    }

    fn train_one(&mut self, x: &[f64; FEATURES], y: f64, cfg: &AiCfg) {
        let p = self.predict(x);
        let err = y - p;
        let lr = cfg.learning_rate;
        let l2 = cfg.l2;
        for (w, &xi) in self.weights.iter_mut().zip(x.iter()) {
            *w += lr * (err * xi - l2 * *w);
        }
        self.trained += 1;
    }

    /// Resolve every pending sample whose horizon has elapsed, using the
    /// current price as the future observation of the sample's entry price.
    pub fn resolve_pending(&mut self, tick: u64, price: f64, cfg: &AiCfg) {
        if self.pending.is_empty() {
            return;
        }
        let horizon = cfg.horizon_ticks;
        let up = cfg.up_move_bps as f64 / 10_000.0;
        let all = std::mem::take(&mut self.pending);
        let mut keep = Vec::with_capacity(all.len());
        for s in all {
            if tick >= s.tick + horizon {
                let y = if price >= s.price * (1.0 + up) { 1.0 } else { 0.0 };
                self.train_one(&s.features, y, cfg);
            } else {
                keep.push(s);
            }
        }
        self.pending = keep;
    }
}

impl Default for AiState {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the feature vector for the current tick.
///
/// x = [bias, rule_score, momentum, ret_1, ret_5, rsi_centered]
/// Returns are fractional and clipped to ±0.5 so a single outlier cannot
/// dominate the dot product.
pub fn features(
    rule_score: f64,
    momentum: f64,
    ret_1: f64,
    ret_5: f64,
    rsi: f64,
) -> [f64; FEATURES] {
    [
        1.0,
        rule_score,
        momentum.clamp(-1.0, 1.0),
        ret_1.clamp(-0.5, 0.5),
        ret_5.clamp(-0.5, 0.5),
        (rsi - 50.0) / 50.0,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AiCfg {
        AiCfg {
            learning_rate: 0.5,
            l2: 0.0,
            horizon_ticks: 2,
            up_move_bps: 20,
            ai_weight: 0.4,
        }
    }

    #[test]
    fn learns_rising_pattern() {
        let mut ai = AiState::new();
        let c = cfg();
        // Bullish features labeled up 10 times: prediction must rise above 0.5.
        let bull = features(0.8, 0.02, 0.01, 0.04, 75.0);
        for _ in 0..10 {
            ai.train_one(&bull, 1.0, &c);
        }
        assert!(ai.predict(&bull) > 0.5, "prediction = {}", ai.predict(&bull));
        // And the mirror: bearish features labeled down 10 times -> below 0.5.
        let bear = features(-0.8, -0.02, -0.01, -0.04, 25.0);
        for _ in 0..10 {
            ai.train_one(&bear, 0.0, &c);
        }
        assert!(ai.predict(&bear) < 0.5);
    }

    #[test]
    fn resolve_pending_trains_only_after_horizon() {
        let mut ai = AiState::new();
        let c = cfg();
        ai.pending.push(PendingSample {
            tick: 1,
            price: 100.0,
            features: features(0.5, 0.01, 0.0, 0.0, 60.0),
        });
        ai.resolve_pending(2, 200.0, &c); // horizon=2: tick 1 matures at tick 3
        assert_eq!(ai.trained, 0);
        assert_eq!(ai.pending.len(), 1);
        ai.resolve_pending(3, 200.0, &c);
        assert_eq!(ai.trained, 1);
        assert!(ai.pending.is_empty());
    }

    #[test]
    fn untrained_model_is_neutral() {
        let ai = AiState::new();
        assert_eq!(ai.predict(&[1.0, 0.9, 0.5, 0.5, 0.5, 0.5]), 0.5);
    }
}
