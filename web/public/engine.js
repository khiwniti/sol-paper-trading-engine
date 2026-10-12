// paper-engine (JS port): faithful browser port of the Rust engine.
// Signals, online AI, risk, broker fills and persistence match src/*.rs 1:1.

"use strict";

const DEFAULTS = {
  mints: {
    sol: "So11111111111111111111111111111111111111112",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  engine: {
    tickIntervalMs: 30000,
    historyLen: 120,
    initialUsdc: 1000.0,
    stateKey: "paper_state_v1",
  },
  strategy: {
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiOverbought: 72.0,
    rsiOversold: 28.0,
    momentumTicks: 20,
    ruleWeight: 0.6,
    entryScore: 0.35,
    exitScore: -0.25,
  },
  ai: {
    learningRate: 0.05,
    l2: 0.0001,
    horizonTicks: 10,
    upMoveBps: 20,
    aiWeight: 0.4,
  },
  risk: {
    stopLossBps: 200,
    takeProfitBps: 400,
    cooldownTicks: 10,
    basePositionPct: 0.3,
    maxPositionPct: 0.6,
    minOrderUsdc: 10.0,
    reserveUsdc: 5.0,
    maxDrawdownPct: 15.0,
  },
  fees: { feeBps: 10, replaySlippageBps: 5 },
};

// ---------- indicators (src/strategy.rs) ----------
function emaSeries(prices, period) {
  if (prices.length < period || period === 0) return null;
  const k = 2.0 / (period + 1.0);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const p of prices.slice(period)) ema = p * k + ema * (1.0 - k);
  return ema;
}

function rsi(prices, period) {
  if (prices.length < period + 1 || period === 0) return null;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const avgGain = gains / period,
    avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50.0 : 100.0;
  return 100.0 - 100.0 / (1.0 + avgGain / avgLoss);
}

function ruleSignal(prices, cfg) {
  const warmup = Math.max(cfg.emaSlow, cfg.rsiPeriod + 1, cfg.momentumTicks + 1);
  if (prices.length < warmup) return null;
  const emaFast = emaSeries(prices, cfg.emaFast);
  const emaSlow = emaSeries(prices, cfg.emaSlow);
  const rsiV = rsi(prices, cfg.rsiPeriod);
  if (emaFast == null || emaSlow == null || rsiV == null) return null;
  const n = prices.length;
  const lookback = Math.max(0, n - cfg.momentumTicks);
  const momentum = (prices[n - 1] - prices[lookback]) / prices[lookback];

  const spread = (emaFast - emaSlow) / emaSlow;
  const trend = Math.tanh(spread * 100.0);
  const mom = Math.tanh(momentum * 100.0);
  const agree = trend * mom >= 0;
  let base = 0.5 * (trend + mom) * (agree ? 1.0 : 0.25);
  let rsiMult = 1.0;
  if (rsiV >= cfg.rsiOverbought) rsiMult = 0.0;
  else if (rsiV <= cfg.rsiOversold) rsiMult = 0.5;
  const score = Math.max(-1, Math.min(1, base * rsiMult));
  return { score, emaFast, emaSlow, rsi: rsiV, momentum };
}

// ---------- online AI (src/ai.rs) ----------
const FEATURES = 6;
function features(ruleScore, momentum, ret1, ret5, rsiV) {
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return [
    1.0,
    ruleScore,
    cl(momentum, -1, 1),
    cl(ret1, -0.5, 0.5),
    cl(ret5, -0.5, 0.5),
    (rsiV - 50.0) / 50.0,
  ];
}
function sigmoid(z) {
  return 1.0 / (1.0 + Math.exp(-z));
}
function aiPredict(ai, x) {
  let z = 0;
  for (let i = 0; i < FEATURES; i++) z += x[i] * ai.weights[i];
  return sigmoid(z);
}
function aiTrainOne(ai, x, y, cfg) {
  const p = aiPredict(ai, x);
  const err = y - p;
  for (let i = 0; i < FEATURES; i++) {
    ai.weights[i] += cfg.learningRate * (err * x[i] - cfg.l2 * ai.weights[i]);
  }
  ai.trained++;
}
function aiResolvePending(ai, tick, price, cfg) {
  if (ai.pending.length === 0) return;
  const horizon = cfg.horizonTicks;
  const up = cfg.upMoveBps / 10000.0;
  const keep = [];
  for (const s of ai.pending) {
    if (tick >= s.tick + horizon) {
      const y = price >= s.price * (1.0 + up) ? 1.0 : 0.0;
      aiTrainOne(ai, s.features, y, cfg);
    } else keep.push(s);
  }
  ai.pending = keep;
}

// ---------- broker (src/broker.rs) ----------
function applyBuy(bal, usdcIn, solGross, feeBps) {
  const fee = (solGross * feeBps) / 10000.0;
  const solNet = solGross - fee;
  bal.usdc -= usdcIn;
  bal.sol += solNet;
  return {
    side: "buy",
    inAmount: usdcIn,
    outAmount: solNet,
    feeAmount: fee,
    effectivePrice: usdcIn / solNet,
  };
}
function applySell(bal, solIn, usdcGross, feeBps) {
  const fee = (usdcGross * feeBps) / 10000.0;
  const usdcNet = usdcGross - fee;
  bal.sol -= solIn;
  bal.usdc += usdcNet;
  return {
    side: "sell",
    inAmount: solIn,
    outAmount: usdcNet,
    feeAmount: fee,
    effectivePrice: usdcNet / solIn,
  };
}

// ---------- risk (src/risk.rs) ----------
function checkExit(entryPrice, price, cfg) {
  if (entryPrice <= 0) return null;
  const changeBps = ((price - entryPrice) / entryPrice) * 10000.0;
  if (changeBps <= -cfg.stopLossBps) return "stop_loss";
  if (changeBps >= cfg.takeProfitBps) return "take_profit";
  return null;
}
function drawdownHalted(peakEquity, equity, cfg) {
  if (peakEquity <= 0) return false;
  return ((peakEquity - equity) / peakEquity) * 100.0 > cfg.maxDrawdownPct;
}
function positionUsdc(score, entryScore, equity, availableUsdc, cfg) {
  if (score < entryScore) return null;
  const conviction = Math.max(0, Math.min(1, (score - entryScore) / (1.0 - entryScore)));
  const pct = cfg.basePositionPct + (cfg.maxPositionPct - cfg.basePositionPct) * conviction;
  const deployable = availableUsdc - cfg.reserveUsdc;
  if (deployable < cfg.minOrderUsdc) return null;
  const target = Math.min(equity * pct, deployable);
  if (target < cfg.minOrderUsdc) return null;
  return target;
}

// ---------- state ----------
function newState(initialUsdc) {
  return {
    tick: 0,
    balances: { usdc: initialUsdc, sol: 0 },
    position: null,
    priceHistory: [],
    peakEquity: initialUsdc,
    lastLossTick: null,
    ai: { weights: new Array(FEATURES).fill(0), pending: [], trained: 0 },
    fills: [],
    equityCurve: [],
    version: 1,
  };
}
function saveState(state) {
  try {
    localStorage.setItem(DEFAULTS.engine.stateKey, JSON.stringify(state));
  } catch {
    /* storage full/unavailable — keep in-memory */
  }
}
function loadState() {
  try {
    const raw = localStorage.getItem(DEFAULTS.engine.stateKey);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && s.balances && Array.isArray(s.ai?.weights)) return s;
  } catch {
    /* corrupt -> fresh */
  }
  return null;
}
function clearState() {
  localStorage.removeItem(DEFAULTS.engine.stateKey);
}
function equity(state, price) {
  return state.balances.usdc + state.balances.sol * price;
}

function ret(hist, n) {
  if (hist.length < n + 1 || n === 0) return 0;
  const last = hist[hist.length - 1];
  const prev = hist[hist.length - 1 - n];
  if (prev <= 0) return 0;
  return (last - prev) / prev;
}

// ---------- engine ----------
// quoteFn: async ({side, amount}) => {grossOut, priceImpactPct, routeLabels}
// Mirrors Engine::decide in src/engine.rs.
async function decide(state, price, quoteFn, cfg) {
  state.tick += 1;
  const tick = state.tick;
  const c = cfg;

  // 1. resolve matured learning labels
  aiResolvePending(state.ai, tick, price, c.ai);

  // 2. rolling window
  state.priceHistory.push(price);
  if (state.priceHistory.length > c.engine.historyLen)
    state.priceHistory.splice(0, state.priceHistory.length - c.engine.historyLen);

  // 3. equity + peak
  const eq = equity(state, price);
  state.peakEquity = Math.max(state.peakEquity, eq);

  // 4. signal (rule + AI blend)
  const sig = ruleSignal(state.priceHistory, c.strategy);
  let score = 0;
  let feats = features(0, 0, 0, 0, 50);
  let pUp = 0.5;
  if (sig) {
    feats = features(
      sig.score,
      sig.momentum,
      ret(state.priceHistory, 1),
      ret(state.priceHistory, 5),
      sig.rsi
    );
    pUp = aiPredict(state.ai, feats);
    score = c.strategy.ruleWeight * sig.score + c.ai.aiWeight * (pUp - 0.5) * 2.0;
    score = Math.max(-1, Math.min(1, score));
  }

  // 5. queue learning sample
  state.ai.pending.push({ tick, price, features: feats });

  // 6. exit-first
  if (state.position) {
    const pos = state.position;
    let reason = checkExit(pos.entryPrice, price, c.risk);
    if (!reason && score <= c.strategy.exitScore) reason = "signal";
    if (reason) {
      const q = await quoteFn({ side: "sell", amount: state.balances.sol });
      const fill = applySell(state.balances, state.balances.sol, q.grossOut, c.fees.feeBps);
      fill.route = q.routeLabels;
      const loss = fill.outAmount < pos.entryPrice * fill.inAmount;
      if (loss) state.lastLossTick = tick;
      state.fills.push({ tick, ...fill, action: `exit:${reason}`, price });
      state.position = null;
      return { tick, price, score, action: `exit:${reason}`, fill, pUp };
    }
    return { tick, price, score, action: "hold", fill: null, pUp };
  }

  // 7. entry gates + sizing
  const cooldown =
    state.lastLossTick != null && tick - state.lastLossTick < c.risk.cooldownTicks;
  const halted = drawdownHalted(state.peakEquity, eq, c.risk);
  if (cooldown || halted)
    return {
      tick,
      price,
      score,
      action: cooldown ? "stand_down:cooldown" : "stand_down:drawdown_halt",
      fill: null,
      pUp,
    };

  const order = positionUsdc(score, c.strategy.entryScore, eq, state.balances.usdc, c.risk);
  if (order == null) return { tick, price, score, action: "stand_aside", fill: null, pUp };

  const q = await quoteFn({ side: "buy", amount: order });
  if (!(q.grossOut > 0)) return { tick, price, score, action: "stand_aside:bad_quote", fill: null, pUp };
  const fill = applyBuy(state.balances, order, q.grossOut, c.fees.feeBps);
  fill.route = q.routeLabels;
  state.position = {
    sol: fill.outAmount,
    entryPrice: fill.effectivePrice,
    entryTick: tick,
    tp: fill.effectivePrice * (1 + c.risk.takeProfitBps / 10000),
    sl: fill.effectivePrice * (1 - c.risk.stopLossBps / 10000),
  };
  state.fills.push({ tick, ...fill, action: `enter`, price });
  return { tick, price, score, action: "enter", fill, pUp };
}

// One full engine tick with persistence + equity logging.
async function engineTick(state, price, quoteFn, cfg) {
  const out = await decide(state, price, quoteFn, cfg);
  const eq = equity(state, price);
  state.equityCurve.push({ tick: out.tick, price, equity: eq });
  if (state.equityCurve.length > 2000) state.equityCurve.splice(0, state.equityCurve.length - 2000);
  saveState(state);
  return { ...out, equity: eq };
}

window.PaperEngine = {
  DEFAULTS,
  ruleSignal,
  rsi,
  emaSeries,
  aiPredict,
  features,
  checkExit,
  positionUsdc,
  drawdownHalted,
  applyBuy,
  applySell,
  newState,
  loadState,
  saveState,
  clearState,
  equity,
  decide,
  engineTick,
};
