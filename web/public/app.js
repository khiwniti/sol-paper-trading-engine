// app.js — glue: price polling, engine loop, UI binding (zip-style panels).
"use strict";

const E = window.PaperEngine;
const cfg = structuredClone(E.DEFAULTS);

const $ = (id) => document.getElementById(id);
const els = {
  price: $("price"), chg24: $("chg24"), conn: $("conn"),
  equity: $("equity"), usdcBal: $("usdc-bal"), solBal: $("sol-bal"),
  pnl: $("pnl"), winrate: $("winrate"), tradeCount: $("trade-count"),
  posBadge: $("pos-badge"), openPos: $("open-pos"), closedPos: $("closed-pos"),
  sigBlend: $("sig-blend"), sigAi: $("sig-ai"), aiCount: $("ai-count"),
  sigFill: $("sigfill"), sigMark: $("sigmark"),
  engineBadge: $("engine-badge"), btnRun: $("btn-run"), btnReset: $("btn-reset"),
  interval: $("interval"),
  signalsList: $("signals-list"), routesList: $("routes-list"),
  fillBody: document.querySelector("#fills tbody"),
};

ChartX.init($("chart"), $("rsi"), null, {
  onTfChange: (tf) => {
    for (const b of document.querySelectorAll("#tf-tabs button"))
      b.classList.toggle("active", b.dataset.tf === tf);
  },
});
document.querySelectorAll("#tf-tabs button").forEach((b) =>
  b.addEventListener("click", () => ChartX.setTf(b.dataset.tf))
);
let running = false;
let timer = null;
let lastPrice = null;
let lastAction = "—";

const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));
const usd = (v) => (v == null ? "—" : "$" + fmt(v, v < 10 ? 4 : 2));
const pct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + fmt(v, 2) + "%");
const num = (v, d = 3) => (v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

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
    return await fetchQuote(side, amount);
  } catch (e) {
    const slip = cfg.fees.replaySlippageBps / 10000;
    const p = lastPrice || 0;
    if (p <= 0) throw e;
    return side === "buy"
      ? { grossOut: amount / (p * (1 + slip)), routeLabels: ["mark"], priceImpactPct: "0" }
      : { grossOut: amount * p * (1 - slip), routeLabels: ["mark"], priceImpactPct: "0" };
  }
};

// ---- UI helpers ----
function setConn(ok) {
  els.conn.textContent = ok ? "● live" : "● offline";
  els.conn.className = "conn " + (ok ? "dot-on" : "dot-off");
}
function setScore(s) {
  els.sigMark.style.left = ((s + 1) / 2) * 100 + "%";
  if (s >= 0) {
    els.sigFill.style.left = "50%";
    els.sigFill.style.width = s * 50 + "%";
  } else {
    els.sigFill.style.left = 50 + s * 50 + "%";
    els.sigFill.style.width = -s * 50 + "%";
  }
}

// closed-position PnL per round trip, derived from the fills log
function closedRounds() {
  const closed = [];
  let open = null;
  for (const f of state.fills) {
    if (f.side === "buy") {
      open = { entry: f.effectivePrice, usdc: f.inAmount, tick: f.tick };
    } else if (f.side === "sell" && open) {
      const pnl = f.outAmount - open.usdc;
      closed.push({
        side: "buy", pnl, entry: open.entry, exit: f.effectivePrice,
        openTick: open.tick, closeTick: f.tick, reason: (f.action || "").replace("exit:", ""),
      });
      open = null;
    }
  }
  return closed;
}

function renderPositions(price) {
  const pos = state.position;
  if (pos && price != null) {
    const upnl = pos.sol * (price - pos.entryPrice);
    const upnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    els.posBadge.textContent = "LONG";
    els.posBadge.className = "badge long";
    els.openPos.innerHTML = `
      <div class="pos-card">
        <div class="pc-field"><label>Size</label><span>${fmt(pos.sol, 4)} SOL</span></div>
        <div class="pc-field"><label>Entry</label><span>${usd(pos.entryPrice)}</span></div>
        <div class="pc-field"><label>Mark</label><span>${usd(price)}</span></div>
        <div class="pc-field"><label>Unrealized P&L</label><span style="color:${upnl >= 0 ? "var(--up)" : "var(--down)"}">${usd(upnl)} (${pct(upnlPct)})</span></div>
        <div class="pc-field"><label>Take Profit</label><span style="color:var(--up)">${usd(pos.tp)}</span></div>
        <div class="pc-field"><label>Stop Loss</label><span style="color:var(--down)">${usd(pos.sl)}</span></div>
        <div class="pc-field"><label>Opened</label><span>tick ${pos.entryTick}</span></div>
      </div>`;
    ChartX.setLines({ entry: pos.entryPrice, tp: pos.tp, sl: pos.sl });
  } else {
    els.posBadge.textContent = "FLAT";
    els.posBadge.className = "badge flat";
    els.openPos.innerHTML = `<div class="pos-none">No open position · engine enters on a qualifying signal (blend ≥ ${cfg.strategy.entryScore})</div>`;
    ChartX.setLines({});
  }

  const rounds = closedRounds().slice(-8).reverse();
  if (rounds.length) {
    els.closedPos.innerHTML = `<h3>Closed Positions (${rounds.length} shown)</h3>` + rounds.map((r) => `
      <div class="pos-row">
        <span class="pr-side buy">LONG</span>
        <span>in ${usd(r.entry)}</span>
        <span>out ${usd(r.exit)}</span>
        <span class="dim">ticks ${r.openTick}→${r.closeTick}</span>
        <span class="dim">${r.reason || "closed"}</span>
        <span class="pr-pnl" style="color:${r.pnl >= 0 ? "var(--up)" : "var(--down)"}">${r.pnl >= 0 ? "+" : ""}${usd(r.pnl)}</span>
      </div>`).join("");
  } else {
    els.closedPos.innerHTML = "";
  }
}

function renderSignals(out) {
  const items = [];
  // engine actions as signal entries
  const actions = state.fills.slice(-12).reverse();
  for (const f of actions) {
    const buy = f.side === "buy";
    items.push(`
      <div class="feed-item">
        <div class="ico ${buy ? "buy" : "sell"}">${buy ? "B" : "S"}</div>
        <div class="fi-main">
          <div class="fi-title">${buy ? "Entry executed" : "Exit: " + (f.action || "").replace("exit:", "") || f.action}</div>
          <div class="fi-sub">${fmt(f.inAmount, 2)} → ${fmt(f.outAmount, 4)} @ ${fmt(f.effectivePrice)} · route ${(f.route || ["—"])[0]}</div>
        </div>
      </div>`);
  }
  if (out && out.action && !out.fill) {
    const label =
      out.action === "stand_aside" ? "Stand aside · score below threshold" :
      out.action === "hold" ? "Holding position" :
      out.action === "stand_down:cooldown" ? "Cooldown active after loss" :
      out.action === "stand_down:drawdown_halt" ? "Drawdown halt · entries blocked" :
      out.action === "warmup" ? "Warmup · collecting history" : out.action;
    items.push(`
      <div class="feed-item">
        <div class="ico info">i</div>
        <div class="fi-main">
          <div class="fi-title">${label}</div>
          <div class="fi-sub">score ${fmt(out.score, 3)} · tick ${out.tick}</div>
        </div>
      </div>`);
  }
  els.signalsList.innerHTML = items.length
    ? items.join("")
    : `<div class="feed-empty">No signals yet · engine decides every tick</div>`;
}

function renderRoutes() {
  const routes = state.fills.slice(-12).reverse().map((f) => `
    <div class="feed-item">
      <div class="ico ${f.side === "buy" ? "buy" : "sell"}">${f.side === "buy" ? "B" : "S"}</div>
      <div class="fi-main">
        <div class="fi-title">${(f.route || ["Jupiter routed"]).join(" · ")}</div>
        <div class="fi-sub">${f.side === "buy" ? "USDC → SOL" : "SOL → USDC"} @ ${fmt(f.effectivePrice)} · fee ${fmt(f.feeAmount, 4)}</div>
      </div>
    </div>`).join("");
  els.routesList.innerHTML = routes || `<div class="feed-empty">No executions yet</div>`;
}

function renderStats(price) {
  const eq = price != null ? E.equity(state, price) : null;
  const initial = cfg.engine.initialUsdc;
  if (eq != null) {
    els.equity.textContent = usd(eq);
    const pnl = eq - initial;
    els.pnl.textContent = (pnl >= 0 ? "+" : "") + usd(pnl);
    els.pnl.className = "chg " + (pnl >= 0 ? "up" : "down");
  }
  els.usdcBal.textContent = usd(state.balances.usdc);
  els.solBal.textContent = num(state.balances.sol, 3) + " SOL";
  els.tradeCount.textContent = state.fills.length;

  const rounds = closedRounds();
  const wins = rounds.filter((r) => r.pnl > 0).length;
  els.winrate.textContent = rounds.length ? fmt((wins / rounds.length) * 100, 1) + "%" : "—";

  els.aiCount.textContent = state.ai.trained + " samples";
  if (price != null) renderPositions(price);
  ChartX.Spark.push(state.equityCurve.map((p) => p.equity));
}

function renderFills(filter = "ALL") {
  const rows = state.fills
    .filter((f) => (filter === "ALL" ? true : f.side === filter))
    .slice(-50).reverse();
  els.fillBody.innerHTML = rows
    .map((f) => `<tr class="${f.side}">
      <td>${f.tick}</td><td>${f.action || f.side}</td><td>${f.side}</td>
      <td>${fmt(f.inAmount, 4)}</td><td>${fmt(f.outAmount, 4)}</td>
      <td>${fmt(f.effectivePrice)}</td><td>${fmt(f.feeAmount, 4)}</td>
      <td class="dim">${(f.route || []).slice(0, 2).join("·") || "—"}</td></tr>`)
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
  ChartX.push(priceData.ts, priceData.price);

  const out = await E.engineTick(state, priceData.price, quoteFn, cfg);
  lastAction = out.action;
  els.sigAi.textContent = out.pUp != null ? fmt(out.pUp * 100, 1) + "%" : "—";
  els.sigBlend.textContent = fmt(out.score, 3);
  setScore(out.score);
  if (out.fill) {
    ChartX.addMarker({ t: priceData.ts, side: out.fill.side, action: out.action });
    renderFills(document.querySelector(".tab-pill [data-hf].active")?.dataset.hf || "ALL");
    renderRoutes();
  }
  renderSignals(out);
  renderStats(priceData.price);
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
  ChartX.clear();
  lastAction = "—";
  lastPrice = null;
  els.price.textContent = "—";
  renderFills();
  renderStats(null);
  renderSignals(null);
  renderRoutes();
});

// tab pills
document.querySelectorAll(".tab-pill [data-hf]").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab-pill [data-hf]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    renderFills(b.dataset.hf);
  })
);
$("tab-signals").addEventListener("click", () => {
  $("tab-signals").classList.add("active"); $("tab-routes").classList.remove("active");
  els.signalsList.hidden = false; els.routesList.hidden = true;
});
$("tab-routes").addEventListener("click", () => {
  $("tab-routes").classList.add("active"); $("tab-signals").classList.remove("active");
  els.routesList.hidden = false; els.signalsList.hidden = true;
});

// restore history into chart on load
const now = Date.now();
state.priceHistory.forEach((p, i) =>
  ChartX.push(now - (state.priceHistory.length - 1 - i) * cfg.engine.tickIntervalMs, p)
);
for (const f of state.fills)
  ChartX.addMarker({ t: now - (state.tick - f.tick) * cfg.engine.tickIntervalMs, side: f.side, action: f.action });

renderFills();
renderStats(null);
renderSignals(null);
renderRoutes();
start();
