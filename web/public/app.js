// app.js — glue: price polling, engine loop, UI binding.
"use strict";

const E = window.PaperEngine;
const cfg = structuredClone(E.DEFAULTS);

const $ = (id) => document.getElementById(id);
const els = {
  price: $("price"), chg24: $("chg24"), conn: $("conn"),
  equity: $("equity"), peak: $("peak"), pnl: $("pnl"), tick: $("tick"),
  posBadge: $("pos-badge"), posSize: $("pos-size"), posEntry: $("pos-entry"),
  posMark: $("pos-mark"), posUpnl: $("pos-upnl"), posTp: $("pos-tp"), posSl: $("pos-sl"),
  actionBadge: $("action-badge"), sigRule: $("sig-rule"), sigAi: $("sig-ai"),
  sigBlend: $("sig-blend"), aiCount: $("ai-count"),
  sigFill: $("sigfill"), sigMark: $("sigmark"),
  ret: $("ret"), fillCount: $("fill-count"), fillBody: document.querySelector("#fills tbody"),
  btnRun: $("btn-run"), btnReset: $("btn-reset"), interval: $("interval"),
  engineBadge: $("engine-badge"),
};

const chart = new Charts.Chart($("chart"), { maxTicks: 160 });
const rsiChart = new Charts.RsiChart($("rsi"), cfg.strategy.rsiPeriod);
const spark = new Charts.Sparkline($("spark"));

let state = E.loadState() || E.newState(cfg.engine.initialUsdc);
let running = false;
let timer = null;
let lastPrice = null;
let lastAction = "—";

const fmt = Charts.fmt;
const usd = (v) => (v == null ? "—" : "$" + fmt(v, v < 10 ? 4 : 2));
const pct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + fmt(v, 2) + "%");

// ---- API layer (Vercel functions proxy Jupiter) ----
async function fetchPrice() {
  const r = await fetch("/api/price");
  if (!r.ok) throw new Error("price_" + r.status);
  return r.json();
}
async function fetchQuote(side, amount) {
  const r = await fetch(`/api/quote?side=${side}&amount=${amount}`);
  if (!r.ok) throw new Error("quote_" + r.status);
  return r.json();
}
const quoteFn = async ({ side, amount }) => {
  try {
    const q = await fetchQuote(side, amount);
    return q;
  } catch (e) {
    // graceful degrade: mark-price fill with replay slippage
    const slip = cfg.fees.replaySlippageBps / 10000;
    const p = lastPrice || 0;
    if (p <= 0) throw e;
    return side === "buy"
      ? { grossOut: amount / (p * (1 + slip)), routeLabels: ["mark"], priceImpactPct: "0" }
      : { grossOut: amount * p * (1 - slip), routeLabels: ["mark"], priceImpactPct: "0" };
  }
};

// ---- UI ----
function setConn(ok) {
  els.conn.textContent = ok ? "● live" : "● offline";
  els.conn.className = "conn " + (ok ? "dot-on" : "dot-off");
}
function setScore(s) {
  const pctPos = ((s + 1) / 2) * 100; // -1..1 -> 0..100
  els.sigMark.style.left = pctPos + "%";
  if (s >= 0) {
    els.sigFill.style.left = "50%";
    els.sigFill.style.width = (s * 50) + "%";
  } else {
    els.sigFill.style.left = 50 + s * 50 + "%";
    els.sigFill.style.width = (-s * 50) + "%";
  }
}
function render() {
  const price = lastPrice;
  const eq = price != null ? E.equity(state, price) : state.peakEquity;
  const initial = cfg.engine.initialUsdc;

  if (price != null) {
    els.price.textContent = fmt(price);
    els.equity.textContent = usd(eq);
    els.peak.textContent = usd(state.peakEquity);
    const pnl = ((eq - initial) / initial) * 100;
    els.pnl.textContent = pct(pnl);
    els.pnl.className = "chg " + (pnl >= 0 ? "up" : "down");
    els.ret.textContent = pct(pnl);
    els.ret.className = "chg " + (pnl >= 0 ? "up" : "down");
  }
  els.tick.textContent = state.tick;
  els.aiCount.textContent = state.ai.trained;
  els.fillCount.textContent = state.fills.length + " fills";

  // position card
  const pos = state.position;
  if (pos && price != null) {
    const upnl = pos.sol * (price - pos.entryPrice);
    els.posBadge.textContent = "LONG";
    els.posBadge.className = "badge long";
    els.posSize.textContent = fmt(pos.sol, 4) + " SOL";
    els.posEntry.textContent = usd(pos.entryPrice);
    els.posMark.textContent = usd(price);
    els.posUpnl.textContent = usd(upnl);
    els.posUpnl.style.color = upnl >= 0 ? "var(--up)" : "var(--down)";
    els.posTp.textContent = usd(pos.tp);
    els.posSl.textContent = usd(pos.sl);
    chart.setLines({ entry: pos.entryPrice, tp: pos.tp, sl: pos.sl });
  } else {
    els.posBadge.textContent = "FLAT";
    els.posBadge.className = "badge flat";
    for (const e of [els.posSize, els.posEntry, els.posMark, els.posUpnl, els.posTp, els.posSl]) e.textContent = "—";
    chart.setLines({});
  }

  // signal
  const sig = E.ruleSignal(state.priceHistory, cfg.strategy);
  if (sig) {
    els.sigRule.textContent = fmt(sig.score, 3);
    els.sigRule.style.color = sig.score >= 0 ? "var(--up)" : "var(--down)";
  } else els.sigRule.textContent = "warmup";

  els.actionBadge.textContent = lastAction;
  els.actionBadge.className =
    "badge " + (lastAction.startsWith("enter") ? "long" : lastAction.startsWith("hold") ? "hot" : "flat");

  spark.push(state.equityCurve.map((p) => p.equity));
  rsiChart.pushHistory(state.priceHistory);
  chart.draw();
}

function renderFills() {
  const rows = state.fills.slice(-50).reverse();
  els.fillBody.innerHTML = rows
    .map(
      (f) => `<tr class="${f.side}">
        <td>${f.tick}</td><td>${f.action || f.side}</td><td>${f.side}</td>
        <td>${fmt(f.inAmount, 4)}</td><td>${fmt(f.outAmount, 4)}</td>
        <td>${fmt(f.effectivePrice)}</td><td>${fmt(f.feeAmount, 4)}</td>
        <td class="dim">${(f.route || []).slice(0, 2).join("·") || "—"}</td></tr>`
    )
    .join("");
}

// ---- engine loop ----
async function tick() {
  let priceData;
  try {
    priceData = await fetchPrice();
    setConn(true);
  } catch {
    setConn(false);
    schedule();
    return;
  }
  lastPrice = priceData.price;
  if (priceData.priceChange24h != null) {
    const c = priceData.priceChange24h;
    els.chg24.textContent = pct(c);
    els.chg24.className = "chg " + (c >= 0 ? "up" : "down");
  }
  chart.push(priceData.ts, priceData.price);

  const out = await E.engineTick(state, priceData.price, quoteFn, cfg);
  lastAction = out.action;
  if (out.fill) {
    chart.addMarker({
      t: priceData.ts,
      price: priceData.price,
      side: out.fill.side,
      action: out.action,
    });
    renderFills();
  }
  els.sigAi.textContent = out.pUp != null ? fmt(out.pUp * 100, 1) + "%" : "—";
  els.sigBlend.textContent = fmt(out.score, 3);
  els.sigBlend.style.color = out.score >= 0 ? "var(--up)" : "var(--down)";
  setScore(out.score);
  render();
  schedule();
}

function schedule() {
  if (!running) return;
  timer = setTimeout(tick, Number(els.interval.value));
}

function start() {
  if (running) return;
  running = true;
  els.btnRun.textContent = "⏸ Stop engine";
  els.btnRun.className = "btn stop";
  els.engineBadge.textContent = "RUNNING";
  els.engineBadge.className = "badge on";
  tick();
}
function stop() {
  running = false;
  clearTimeout(timer);
  els.btnRun.textContent = "▶ Start engine";
  els.btnRun.className = "btn primary";
  els.engineBadge.textContent = "STOPPED";
  els.engineBadge.className = "badge off";
}

els.btnRun.addEventListener("click", () => (running ? stop() : start()));
els.btnReset.addEventListener("click", () => {
  if (!confirm("Reset paper wallet? All simulated fills and state are deleted.")) return;
  stop();
  E.clearState();
  state = E.newState(cfg.engine.initialUsdc);
  chart.ticks = [];
  chart.markers = [];
  lastAction = "—";
  renderFills();
  render();
});

// restore visible history into chart on load
for (const p of state.priceHistory) chart.push(Date.now() - (state.priceHistory.length - state.priceHistory.indexOf(p)) * cfg.engine.tickIntervalMs, p);
for (const f of state.fills) {
  chart.addMarker({ t: Date.now() - (state.tick - f.tick) * cfg.engine.tickIntervalMs, price: f.price, side: f.side, action: f.action });
}

render();
renderFills();
// start in live-observing mode: poll prices immediately, engine decisions each tick
start();
