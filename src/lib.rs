//! paper-engine: autonomous SOL/USDC paper-trading engine.
//!
//! - Prices and fills come from Jupiter (lite-api) in live mode, or from a CSV in replay mode.
//! - Signals combine a rule layer (EMA trend + RSI gate) with an online logistic model
//!   that learns per tick whether price rises over a short horizon.
//! - Risk layer: stop-loss, take-profit, signal exit, post-loss cooldown, drawdown halt,
//!   position sizing caps.
//! - All state is persisted so the engine can stop/resume autonomously.

pub mod ai;
pub mod broker;
pub mod config;
pub mod engine;
pub mod feed;
pub mod risk;
pub mod state;
pub mod strategy;
