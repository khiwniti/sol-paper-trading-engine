//! Live price + executable-quote feeds from Jupiter (lite-api).
//!
//! Two endpoints:
//! - `/price/v3`: mid-market USD price per token (signal input).
//! - `/swap/v1/quote`: routed swap output including AMM routing, slippage and
//!   price impact (fill model input). The engine paper-trades against this
//!   quote output, so simulated fills track real on-chain execution costs.

use crate::config::ApiCfg;
use anyhow::{bail, Context, Result};
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

pub struct JupiterFeed {
    client: Client,
    base_url: String,
    sol_mint: String,
    usdc_mint: String,
    slippage_bps: u64,
}

/// Parsed result of `/swap/v1/quote` (fields the engine uses).
#[derive(Debug, Deserialize)]
pub struct QuoteResponse {
    pub in_amount: String,
    pub out_amount: String,
}

impl JupiterFeed {
    pub fn new(api: &ApiCfg, sol_mint: String, usdc_mint: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("paper-engine/0.1")
            .build()
            .expect("reqwest client");
        Self {
            client,
            base_url: api.base_url.clone(),
            sol_mint,
            usdc_mint,
            slippage_bps: api.slippage_bps,
        }
    }

    /// Mid-market SOL price in USD (USDC ≈ 1 USD).
    pub async fn sol_price(&self) -> Result<f64> {
        let url = format!("{}/price/v3?ids={}", self.base_url, self.sol_mint);
        let resp: serde_json::Value = self
            .client
            .get(&url)
            .send()
            .await
            .context("price request failed")?
            .error_for_status()
            .context("price endpoint returned error status")?
            .json()
            .await
            .context("price response not JSON")?;
        let entry = resp
            .get(&self.sol_mint)
            .ok_or_else(|| anyhow::anyhow!("price response missing {}", self.sol_mint))?;
        let price = entry
            .get("usdPrice")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| anyhow::anyhow!("price response missing usdPrice"))?;
        if !(price.is_finite() && price > 0.0) {
            bail!("price feed returned non-finite price {price}");
        }
        Ok(price)
    }

    /// Routed quote for spending USDC into SOL (fills only).
    pub async fn quote_usdc_to_sol(&self, usdc_amount: f64) -> Result<QuoteResponse> {
        let micro_usdc = (usdc_amount * 1e6).round() as u64;
        if micro_usdc == 0 {
            bail!("quote amount rounds to zero");
        }
        let url = format!(
            "{}/swap/v1/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}&swapMode=ExactIn",
            self.base_url, self.usdc_mint, self.sol_mint, micro_usdc, self.slippage_bps
        );
        self.get_quote(&url).await
    }

    /// Routed quote for selling SOL into USDC (fills only).
    pub async fn quote_sol_to_usdc(&self, sol_amount: f64) -> Result<QuoteResponse> {
        let lamports = (sol_amount * 1e9).round() as u64;
        if lamports == 0 {
            bail!("quote amount rounds to zero");
        }
        let url = format!(
            "{}/swap/v1/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}&swapMode=ExactIn",
            self.base_url, self.sol_mint, self.usdc_mint, lamports, self.slippage_bps
        );
        self.get_quote(&url).await
    }

    async fn get_quote(&self, verified_url: &str) -> Result<QuoteResponse> {
        let resp: serde_json::Value = self
            .client
            .get(verified_url)
            .send()
            .await
            .context("quote request failed")?
            .error_for_status()
            .context("quote endpoint returned error status")?
            .json()
            .await
            .context("quote response not JSON")?;
        if let Some(err) = resp.get("error") {
            bail!("quote endpoint error: {}", err.as_str().unwrap_or("?"));
        }
        Ok(serde_json::from_value::<QuoteResponse>(resp)
            .context("quote response shape mismatch")?)
    }
}
