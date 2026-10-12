//! Risk layer: exit triggers, position sizing, drawdown halt, cooldown.

use crate::config::RiskCfg;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    StopLoss,
    TakeProfit,
    Signal,
}

impl ExitReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExitReason::StopLoss => "stop_loss",
            ExitReason::TakeProfit => "take_profit",
            ExitReason::Signal => "signal",
        }
    }
}

/// Price-based exit check vs the entry's effective fill price.
pub fn check_exit(entry_price: f64, price: f64, cfg: &RiskCfg) -> Option<ExitReason> {
    if entry_price <= 0.0 {
        return None;
    }
    let change_bps = (price - entry_price) / entry_price * 10_000.0;
    if change_bps <= -(cfg.stop_loss_bps as f64) {
        Some(ExitReason::StopLoss)
    } else if change_bps >= cfg.take_profit_bps as f64 {
        Some(ExitReason::TakeProfit)
    } else {
        None
    }
}

/// True when peak-to-equity drawdown exceeds the configured halt threshold.
/// Halts block new entries only; open positions still exit by their rules.
pub fn drawdown_halted(peak_equity: f64, equity: f64, cfg: &RiskCfg) -> bool {
    if peak_equity <= 0.0 {
        return false;
    }
    let dd_pct = (peak_equity - equity) / peak_equity * 100.0;
    dd_pct > cfg.max_drawdown_pct
}

/// USDC to deploy for a fresh long, or None when the order is not viable.
///
/// Sizing scales linearly with conviction between `base_position_pct` and
/// `max_position_pct` of equity, clamped to available USDC minus the reserve
/// and floored at `min_order_usdc`.
pub fn position_usdc(
    score: f64,
    entry_score: f64,
    equity: f64,
    available_usdc: f64,
    cfg: &RiskCfg,
) -> Option<f64> {
    if score < entry_score {
        return None;
    }
    let conviction = ((score - entry_score) / (1.0 - entry_score)).clamp(0.0, 1.0);
    let pct = cfg.base_position_pct
        + (cfg.max_position_pct - cfg.base_position_pct) * conviction;
    let deployable = available_usdc - cfg.reserve_usdc;
    if deployable < cfg.min_order_usdc {
        return None;
    }
    let target = (equity * pct).min(deployable);
    if target < cfg.min_order_usdc {
        None
    } else {
        Some(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RiskCfg {
        RiskCfg {
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

    #[test]
    fn exit_triggers_at_boundaries() {
        let c = cfg();
        assert_eq!(check_exit(100.0, 98.0, &c), Some(ExitReason::StopLoss));
        assert_eq!(check_exit(100.0, 97.9, &c), Some(ExitReason::StopLoss));
        assert_eq!(check_exit(100.0, 104.0, &c), Some(ExitReason::TakeProfit));
        assert_eq!(check_exit(100.0, 104.1, &c), Some(ExitReason::TakeProfit));
        assert_eq!(check_exit(100.0, 100.0, &c), None);
        assert_eq!(check_exit(100.0, 99.0, &c), None);
        assert_eq!(check_exit(0.0, 100.0, &c), None);
    }

    #[test]
    fn sizing_scales_with_conviction_and_caps() {
        let c = cfg();
        let s0 = position_usdc(0.5, 0.35, 1000.0, 1000.0, &c).unwrap();
        let s1 = position_usdc(1.0, 0.35, 1000.0, 1000.0, &c).unwrap();
        assert!((s1 - 600.0).abs() < 1e-9);
        // Below-threshold score: no order.
        assert_eq!(position_usdc(0.34, 0.35, 1000.0, 1000.0, &c), None);
    }

    #[test]
    fn sizing_respects_reserve_and_min_order() {
        let c = cfg();
        // Only 12 USDC available: deployable 7 < min 10 -> None.
        assert_eq!(position_usdc(0.9, 0.35, 1000.0, 12.0, &c), None);
        // 15.5 available -> deployable 10.5 -> order 10.5.
        let s = position_usdc(0.9, 0.35, 1000.0, 15.5, &c).unwrap();
        assert!((s - 10.5).abs() < 1e-9);
    }

    #[test]
    fn drawdown_halt_threshold() {
        let c = cfg();
        assert!(!drawdown_halted(1000.0, 850.0, &c));
        assert!(drawdown_halted(1000.0, 849.99, &c));
        assert!(!drawdown_halted(0.0, 0.0, &c));
    }
}
