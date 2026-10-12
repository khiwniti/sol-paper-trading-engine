//! paper-engine CLI: autonomous SOL/USDC paper trading.

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use paper_engine::config::Config;
use paper_engine::engine::{Engine, LiveFillProvider, ReplayFillProvider};
use paper_engine::feed::JupiterFeed;
use paper_engine::state::EngineState;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "paper-engine", version, about = "Autonomous SOL/USDC paper-trading engine (Jupiter-fed)")]
struct Cli {
    /// Config file path.
    #[arg(long, default_value = "config.toml")]
    config: PathBuf,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run live: poll Jupiter prices on an interval, trade, persist state.
    Live {
        /// Stop after this many minutes (omit = run until Ctrl-C).
        #[arg(long)]
        duration_mins: Option<u64>,
        /// Milliseconds between ticks (overrides config).
        #[arg(long)]
        interval_ms: Option<u64>,
    },
    /// Replay a CSV of `timestamp_ms,price` rows through the engine.
    Replay {
        /// CSV file path.
        csv: PathBuf,
        /// Overwrite any existing state instead of resuming.
        #[arg(long)]
        fresh: bool,
    },
    /// Show current persisted state and equity.
    Status,
    /// Delete persisted state and logs (fresh start).
    Reset,
}

fn load_or_default(config: &Path) -> Result<Config> {
    if config.exists() {
        Config::load(config).with_context(|| format!("loading {}", config.display()))
    } else {
        warn!("config {} not found; using built-in defaults", config.display());
        Ok(Config::default())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let cfg = load_or_default(&cli.config)?;

    match cli.cmd {
        Cmd::Live { duration_mins, interval_ms } => {
            run_live(cfg, duration_mins, interval_ms).await
        }
        Cmd::Replay { csv, fresh } => run_replay(cfg, &csv, fresh).await,
        Cmd::Status => run_status(&cfg),
        Cmd::Reset => run_reset(&cfg),
    }
}

async fn run_live(cfg: Config, duration_mins: Option<u64>, interval_ms: Option<u64>) -> Result<()> {
    let state_path = PathBuf::from(&cfg.engine.state_path);
    let state = match EngineState::load(&state_path)? {
        Some(s) => {
            info!("resuming: tick {} ({:.2} USDC)", s.tick, s.balances.usdc);
            s
        }
        None => {
            info!("fresh paper wallet: {:.2} USDC", cfg.engine.initial_usdc);
            EngineState::new(cfg.engine.initial_usdc)
        }
    };
    let mut engine = Engine::new(state, cfg.clone());

    let feed = JupiterFeed::new(&cfg.api, cfg.mints.sol.clone(), cfg.mints.usdc.clone());
    let mut provider = LiveFillProvider::new(feed);

    let interval = Duration::from_millis(interval_ms.unwrap_or(cfg.engine.tick_interval_ms));
    let deadline =
        duration_mins.map(|m| tokio::time::Instant::now() + Duration::from_secs(m * 60));

    // Graceful shutdown: save state on SIGTERM/SIGINT so systemd restarts
    // (Restart=always) resume from the last good tick.
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut shutdown = false;

    info!("live mode: tick every {:?} (long-run: backoff on feed errors)", interval);
    let mut backoff_ms: u64 = 0;

    loop {
        tokio::select! {
            _ = sigterm.recv() => { info!("SIGTERM: shutting down gracefully"); shutdown = true; }
            _ = sigint.recv() => { info!("SIGINT: shutting down gracefully"); shutdown = true; }
            _ = tokio::time::sleep(if backoff_ms > 0 { Duration::from_millis(backoff_ms) } else { interval }) => {}
        }
        if shutdown {
            break;
        }
        if let Some(d) = deadline {
            if tokio::time::Instant::now() >= d {
                info!("duration reached; shutting down");
                break;
            }
        }

        match provider.price().await {
            Ok(price) => {
                backoff_ms = 0; // healthy feed resets backoff
                match engine.act(price, &mut provider).await {
                    Ok(out) => {
                        info!(
                            "tick {} price {:.2} score {:.3} {}",
                            out.tick, out.price, out.score, out.action
                        );
                        if let Some(f) = &out.fill {
                            info!(
                                "FILL {} {:.4} -> {:.6} @ {:.4} (fee {:.6})",
                                f.side, f.in_amount, f.out_amount, f.effective_price, f.fee_amount
                            );
                        }
                    }
                    // Engine errors (e.g. quote failure mid-trade) keep state
                    // consistent: act() saves before failing, so retry is safe.
                    Err(e) => {
                        warn!("tick skipped (engine error, will retry): {e:#}");
                        backoff_ms = next_backoff(backoff_ms);
                    }
                }
            }
            Err(e) => {
                warn!("feed error: {e:#}; backing off {}ms", backoff_ms);
                backoff_ms = next_backoff(backoff_ms);
            }
        }
    }

    // Final state save on shutdown (act() already saves per-tick; this covers
    // the case where shutdown lands between fetch and act).
    engine.state.save(&state_path)?;
    info!("state saved to {}; run complete", state_path.display());
    Ok(())
}

/// Exponential backoff schedule: 5s, 10s, 20s, 40s, ... capped at 10min.
/// Keeps a 24/7 daemon polite when Jupiter is down or rate-limiting.
fn next_backoff(prev_ms: u64) -> u64 {
    match prev_ms {
        0 => 5_000,
        ms => (ms * 2).min(10 * 60 * 1000),
    }
}

async fn run_replay(cfg: Config, csv: &Path, fresh: bool) -> Result<()> {
    let state_path = PathBuf::from(&cfg.engine.state_path);
    if fresh {
        for p in [&cfg.engine.state_path, &cfg.engine.fills_path, &cfg.engine.equity_path] {
            let path = Path::new(p);
            if path.exists() {
                std::fs::remove_file(path)?;
            }
        }
    }
    let state = match (fresh, EngineState::load(&state_path)?) {
        (false, Some(s)) => {
            println!("resuming from tick {}", s.tick);
            s
        }
        _ => EngineState::new(cfg.engine.initial_usdc),
    };

    let raw = std::fs::read_to_string(csv)
        .with_context(|| format!("reading {}", csv.display()))?;
    let rows: Vec<(u64, f64)> = raw
        .lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') {
                return None;
            }
            let mut it = l.split(',');
            let ts: Option<u64> = it.next().and_then(|t| t.trim().parse().ok());
            let px: Option<f64> = it.next().and_then(|p| p.trim().parse().ok());
            match (ts, px) {
                (Some(t), Some(p)) if p.is_finite() && p > 0.0 => Some((t, p)),
                // The first non-comment line is a header, not an error.
                _ if i == 0 => None,
                _ => {
                    warn!("skipping malformed line {}: {l}", i + 1);
                    None
                }
            }
        })
        .collect();
    if rows.is_empty() {
        bail!("no usable rows in {}", csv.display());
    }
    println!("replaying {} ticks from {}", rows.len(), csv.display());

    let mut engine = Engine::new(state, cfg.clone());
    let mut provider = ReplayFillProvider::new(cfg.fees.replay_slippage_bps);

    for (_ts, px) in &rows {
        provider.set_price(*px);
        let out = engine.act(*px, &mut provider).await?;
        println!(
            "tick {:>4} price {:>9.2} score {:>6.3} {}",
            out.tick, out.price, out.score, out.action
        );
    }
    std::io::stdout().flush()?;

    let last_px = rows.last().unwrap().1;
    let eq = engine.state.equity(last_px);
    println!("replay done: {} ticks", engine.state.tick);
    println!("equity: {:.2} USDC (peak {:.2})", eq, engine.state.peak_equity);
    println!(
        "balances: {:.4} USDC + {:.6} SOL",
        engine.state.balances.usdc, engine.state.balances.sol
    );
    Ok(())
}

fn run_status(cfg: &Config) -> Result<()> {
    let state_path = PathBuf::from(&cfg.engine.state_path);
    match EngineState::load(&state_path)? {
        Some(s) => {
            let last = s.price_history.last().copied().unwrap_or(0.0);
            println!("tick: {}", s.tick);
            println!(
                "balances: {:.4} USDC + {:.6} SOL",
                s.balances.usdc, s.balances.sol
            );
            if last > 0.0 {
                println!("equity @ {:.2}: {:.4} USDC", last, s.equity(last));
                println!("peak equity: {:.4}", s.peak_equity);
            }
            match &s.position {
                Some(p) => println!(
                    "position: {:.6} SOL @ {:.2} (tick {})",
                    p.sol, p.entry_price, p.entry_tick
                ),
                None => println!("position: flat"),
            }
            println!("ai trained samples: {}", s.ai.trained);
        }
        None => println!("no state at {}", state_path.display()),
    }
    Ok(())
}

fn run_reset(cfg: &Config) -> Result<()> {
    for p in [&cfg.engine.state_path, &cfg.engine.fills_path, &cfg.engine.equity_path] {
        let path = Path::new(p);
        if path.exists() {
            std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
            println!("removed {}", path.display());
        }
    }
    Ok(())
}

