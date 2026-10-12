//! Rule layer: EMA trend + momentum confirmation + RSI gate.
//!
//! Produces a bounded score in [-1, 1] per tick. Positive = bullish.
//! Returns `None` until the longest lookback is satisfied (warmup).
//!
//! Calibration notes:
//! - `trend` = tanh(ema_spread_pct * 100): a 1% fast-over-slow spread maps to
//!   ~0.76, a 2% spread to ~0.96. Sustained drift d per tick produces a
//!   spread of roughly d * (slow - fast) / 2.
//! - `momentum` = tanh(move_pct * 100) over the lookback window.
//! - A vertical (RSI-saturated) rally is deliberately gated to 0: chasing
//!   exhaustion is where trend-followers bleed.

use crate::config::StrategyCfg;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RuleSignal {
    /// Bounded rule score in [-1, 1]; positive = long-biased.
    pub score: f64,
    pub ema_fast: f64,
    pub ema_slow: f64,
    pub rsi: f64,
    /// Fractional move over `momentum_ticks`, clipped to [-1, 1].
    pub momentum: f64,
}

pub fn ema_series(prices: &[f64], period: usize) -> Option<f64> {
    if prices.len() < period || period == 0 {
        return None;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = prices[..period].iter().sum::<f64>() / period as f64;
    for &p in &prices[period..] {
        ema = p * k + ema * (1.0 - k);
    }
    Some(ema)
}

/// Wilder's RSI over the last `period` deltas.
pub fn rsi(prices: &[f64], period: usize) -> Option<f64> {
    if prices.len() < period + 1 || period == 0 {
        return None;
    }
    let mut gains = 0.0;
    let mut losses = 0.0;
    for w in prices.windows(2).take(period) {
        let d = w[1] - w[0];
        if d >= 0.0 {
            gains += d;
        } else {
            losses -= d;
        }
    }
    let avg_gain = gains / period as f64;
    let avg_loss = losses / period as f64;
    if avg_loss == 0.0 {
        return if avg_gain == 0.0 { Some(50.0) } else { Some(100.0) };
    }
    let rs = avg_gain / avg_loss;
    Some(100.0 - 100.0 / (1.0 + rs))
}

/// Compute the rule signal from the rolling price window (oldest first).
pub fn rule_signal(prices: &[f64], cfg: &StrategyCfg) -> Option<RuleSignal> {
    if prices.len() < cfg.warmup_ticks() {
        return None;
    }
    let ema_fast = ema_series(prices, cfg.ema_fast)?;
    let ema_slow = ema_series(prices, cfg.ema_slow)?;
    let rsi_v = rsi(prices, cfg.rsi_period)?;
    let n = prices.len();
    let lookback = n.saturating_sub(cfg.momentum_ticks);
    let momentum = (prices[n - 1] - prices[lookback]) / prices[lookback];

    let spread = (ema_fast - ema_slow) / ema_slow;
    let trend = (spread * 100.0).tanh();
    let mom = (momentum * 100.0).tanh();

    // Trend and momentum must agree for a full-strength signal; a conflict
    // means chop, so the blended component is dampened to 25%.
    let agree = trend * mom >= 0.0;
    let base = 0.5 * (trend + mom) * if agree { 1.0 } else { 0.25 };

    // RSI gate: zero out longs when overbought, dampen when oversold.
    let rsi_mult = if rsi_v >= cfg.rsi_overbought {
        0.0
    } else if rsi_v <= cfg.rsi_oversold {
        0.5
    } else {
        1.0
    };

    let score = (base * rsi_mult).clamp(-1.0, 1.0);
    Some(RuleSignal {
        score,
        ema_fast,
        ema_slow,
        rsi: rsi_v,
        momentum: momentum.clamp(-1.0, 1.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> StrategyCfg {
        StrategyCfg {
            ema_fast: 3,
            ema_slow: 5,
            rsi_period: 4,
            rsi_overbought: 72.0,
            rsi_oversold: 28.0,
            momentum_ticks: 4,
            rule_weight: 0.6,
            entry_score: 0.1,
            exit_score: -0.25,
        }
    }

    /// +1% / -0.5% alternating: net drift +0.25%/tick with RSI ~67 (in band).
    fn healthy_uptrend() -> Vec<f64> {
        let mut p = vec![100.0];
        for i in 0..15 {
            let last = *p.last().unwrap();
            p.push(if i % 2 == 0 { last * 1.01 } else { last * 0.995 });
        }
        p
    }

    #[test]
    fn healthy_uptrend_yields_positive_score() {
        let sig = rule_signal(&healthy_uptrend(), &cfg()).unwrap();
        assert!(sig.score > 0.1, "expected a clear long signal, got {}", sig.score);
        assert!(sig.rsi < 72.0 && sig.rsi > 28.0, "rsi {}", sig.rsi);
    }

    #[test]
    fn vertical_rally_is_gated() {
        // Monotonic rise drives RSI to 100: the gate must zero the score.
        let prices: Vec<f64> = (0..40).map(|i| 100.0 + i as f64).collect();
        let sig = rule_signal(&prices, &cfg()).unwrap();
        assert_eq!(sig.score, 0.0, "overbought gate must zero the score");
    }

    #[test]
    fn downtrend_yields_negative_score() {
        let prices: Vec<f64> = (0..40).map(|i| 200.0 - i as f64).collect();
        let sig = rule_signal(&prices, &cfg()).unwrap();
        assert!(sig.score < 0.0, "got {}", sig.score);
    }
    #[test]
    fn warmup_returns_none() {
        let prices = vec![100.0; 4];

        assert!(rule_signal(&prices, &cfg()).is_none());
        assert!(rule_signal(&healthy_uptrend(), &cfg()).is_some());
    }

    #[test]
    fn rsi_bounds() {
        let flat = vec![50.0; 30];
        assert_eq!(rsi(&flat, 14).unwrap(), 50.0);
        let up: Vec<f64> = (0..30).map(|i| 100.0 + i as f64).collect();
        assert!(rsi(&up, 14).unwrap() > 90.0);
        let down: Vec<f64> = (0..30).map(|i| 100.0 - i as f64).collect();
        assert!(rsi(&down, 14).unwrap() < 10.0);
    }
}
