//! Paper broker: balance math for fills with a modeled execution fee.
//!
//! The engine obtains a gross swap output from the fill provider (Jupiter
//! quote in live mode, price ± synthetic slippage in replay), then applies
//! `fee_bps` to the output here. Balances move exactly like a real wallet:
//! quote in -> tokens out, minus fee.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct Balances {
    pub usdc: f64,
    pub sol: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    /// "buy" (USDC -> SOL) or "sell" (SOL -> USDC).
    pub side: String,
    pub in_amount: f64,
    /// Net output after the modeled fee.
    pub out_amount: f64,
    pub fee_amount: f64,
    /// Effective price: USDC spent (net) per SOL received (net).
    pub effective_price: f64,
}

/// Spend `usdc_in` USDC for `sol_gross` SOL (pre-fee); fee is taken from output.
pub fn apply_buy(b: &mut Balances, usdc_in: f64, sol_gross: f64, fee_bps: u64) -> Fill {
    let fee = sol_gross * fee_bps as f64 / 10_000.0;
    let sol_net = sol_gross - fee;
    b.usdc -= usdc_in;
    b.sol += sol_net;
    Fill {
        side: "buy".to_string(),
        in_amount: usdc_in,
        out_amount: sol_net,
        fee_amount: fee,
        effective_price: usdc_in / sol_net,
    }
}

/// Sell `sol_in` SOL for `usdc_gross` USDC (pre-fee); fee is taken from output.
pub fn apply_sell(b: &mut Balances, sol_in: f64, usdc_gross: f64, fee_bps: u64) -> Fill {
    let fee = usdc_gross * fee_bps as f64 / 10_000.0;
    let usdc_net = usdc_gross - fee;
    b.sol -= sol_in;
    b.usdc += usdc_net;
    Fill {
        side: "sell".to_string(),
        in_amount: sol_in,
        out_amount: usdc_net,
        fee_amount: fee,
        effective_price: usdc_net / sol_in,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_moves_balances_and_charges_fee_on_output() {
        let mut b = Balances { usdc: 1000.0, sol: 0.0 };
        // 100 USDC for 0.9 SOL gross with 10 bps fee.
        let f = apply_buy(&mut b, 100.0, 0.9, 10);
        assert!((b.usdc - 900.0).abs() < 1e-12);
        assert!((b.sol - 0.9 * (1.0 - 0.001)).abs() < 1e-12);
        assert!((f.fee_amount - 0.9 * 0.001).abs() < 1e-12);
        assert!((f.effective_price - 100.0 / (0.9 * 0.999)).abs() < 1e-9);
    }

    #[test]
    fn sell_roundtrip_preserves_capital_minus_fees() {
        let mut b = Balances { usdc: 0.0, sol: 0.0 };
        let buy = apply_buy(&mut b, 0.0, 1.0, 0); // keep 1 SOL, no fee
        assert_eq!(buy.out_amount, 1.0);
        let sell = apply_sell(&mut b, 1.0, 200.0, 10);
        assert!((b.sol).abs() < 1e-12);
        assert!((b.usdc - 200.0 * 0.999).abs() < 1e-12);
        assert!((sell.effective_price - 199.8).abs() < 1e-9);
    }

    #[test]
    fn zero_fee_is_passthrough() {
        let mut b = Balances { usdc: 50.0, sol: 0.0 };
        let f = apply_buy(&mut b, 50.0, 1.0, 0);
        assert_eq!(f.out_amount, 1.0);
        assert_eq!(f.fee_amount, 0.0);
        assert_eq!(b.sol, 1.0);
    }
}
