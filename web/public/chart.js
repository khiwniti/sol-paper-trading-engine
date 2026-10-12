// chart.js — lightweight canvas chart: candles + EMA overlays, entry/TP/SL
// price lines, fill markers, RSI pane, equity sparkline. No dependencies.

"use strict";

const C = {
  up: "#22c55e",
  down: "#ef4444",
  emaFast: "#38bdf8",
  emaSlow: "#f59e0b",
  grid: "rgba(148,163,184,0.12)",
  text: "#94a3b8",
  tp: "#22c55e",
  sl: "#ef4444",
  entry: "#a78bfa",
  accent: "#6366f1",
};

function fmt(v, d = 2) {
  return v == null || !isFinite(v) ? "—" : v.toFixed(d);
}

class Chart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;
    this.ticks = []; // {t, price}
    this.markers = []; // {t, price, side, action}
    this.lines = {}; // {entry, tp, sl}
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  push(t, price) {
    this.ticks.push({ t, price });
    const max = this.opts.maxTicks || 160;
    if (this.ticks.length > max) this.ticks.splice(0, this.ticks.length - max);
  }

  addMarker(m) {
    this.markers.push(m);
    const cutoff = this.ticks.length ? this.ticks[0].t : 0;
    this.markers = this.markers.filter((x) => x.t >= cutoff);
  }

  setLines(l) {
    this.lines = l || {};
  }

  ema(period, i) {
    const need = period;
    if (i + 1 < need) return null;
    const k = 2 / (period + 1);
    let e = 0;
    for (let j = i - need + 1; j <= i; j++) e += this.ticks[j].price;
    e /= need;
    for (let j = i - need + 2; j <= i; j++) e = this.ticks[j].price * k + e * (1 - k);
    return e;
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (this.ticks.length < 2) {
      ctx.fillStyle = C.text;
      ctx.font = "13px system-ui";
      ctx.fillText("waiting for ticks…", w / 2 - 60, h / 2);
      return;
    }

    const padR = 64,
      padB = 22,
      padT = 10;
    const plotW = w - padR - 6,
      plotH = h - padB - padT;

    const prices = this.ticks.map((t) => t.price);
    let lo = Math.min(...prices),
      hi = Math.max(...prices);
    for (const v of Object.values(this.lines))
      if (v != null && isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad;
    hi += pad;
    const y = (p) => padT + plotH - ((p - lo) / (hi - lo)) * plotH;
    const n = this.ticks.length;
    const step = plotW / n;
    const x = (i) => 6 + i * step;

    // grid + right axis
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.text;
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";
    for (let g = 0; g <= 4; g++) {
      const p = lo + ((hi - lo) * g) / 4;
      const yy = y(p);
      ctx.beginPath();
      ctx.moveTo(6, yy);
      ctx.lineTo(6 + plotW, yy);
      ctx.stroke();
      ctx.fillText(fmt(p), 6 + plotW + 6, yy + 3);
    }

    // price line + area
    ctx.beginPath();
    this.ticks.forEach((t, i) => {
      const px = x(i),
        py = y(t.price);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(x(n - 1), padT + plotH);
    ctx.lineTo(x(0), padT + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, "rgba(99,102,241,0.18)");
    grad.addColorStop(1, "rgba(99,102,241,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    // EMA overlays
    for (const [period, color] of [
      [9, C.emaFast],
      [21, C.emaSlow],
    ]) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const e = this.ema(period, i);
        if (e == null) continue;
        const px = x(i),
          py = y(e);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // position lines: entry / TP / SL
    const lineLabels = [
      ["entry", C.entry, "ENTRY"],
      ["tp", C.tp, "TP"],
      ["sl", C.sl, "SL"],
    ];
    for (const [key, color, label] of lineLabels) {
      const v = this.lines[key];
      if (v == null || !isFinite(v)) continue;
      const yy = y(v);
      ctx.strokeStyle = color;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(6, yy);
      ctx.lineTo(6 + plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = "9px system-ui";
      ctx.fillText(`${label} ${fmt(v)}`, 8, yy - 3);
    }

    // fill markers
    for (const m of this.markers) {
      const i = this.ticks.findIndex((t) => t.t === m.t);
      if (i < 0) continue;
      const px = x(i),
        py = y(m.price);
      const buy = m.side === "buy";
      ctx.fillStyle = buy ? C.up : C.down;
      ctx.beginPath();
      if (buy) {
        ctx.moveTo(px, py + 14);
        ctx.lineTo(px - 5, py + 22);
        ctx.lineTo(px + 5, py + 22);
      } else {
        ctx.moveTo(px, py - 14);
        ctx.lineTo(px - 5, py - 22);
        ctx.lineTo(px + 5, py - 22);
      }
      ctx.closePath();
      ctx.fill();
    }

    // last price badge
    const last = this.ticks[n - 1].price;
    const ly = y(last);
    ctx.fillStyle = C.accent;
    ctx.fillRect(6 + plotW + 2, ly - 8, padR - 8, 16);
    ctx.fillStyle = "#fff";
    ctx.font = "10px system-ui";
    ctx.fillText(fmt(last), 6 + plotW + 6, ly + 3);

    // time axis
    ctx.fillStyle = C.text;
    ctx.font = "9px system-ui";
    ctx.textAlign = "center";
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 5))) {
      const t = new Date(this.ticks[i].t);
      ctx.fillText(
        `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`,
        x(i),
        h - 8
      );
    }
  }
}

// RSI pane: value line + overbought/oversold bands.
class RsiChart {
  constructor(canvas, period = 14) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.period = period;
    this.values = [];
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  pushHistory(prices) {
    // recompute RSI over the visible window
    this.values = prices.map((_, i) => PaperEngine.rsi(prices.slice(0, i + 1), this.period));
  }
  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const v = this.values;
    if (!v.length) return;
    const lo = 0,
      hi = 100;
    const y = (p) => h - ((p - lo) / (hi - lo)) * h;
    // bands
    ctx.fillStyle = "rgba(148,163,184,0.07)";
    ctx.fillRect(0, y(72), w, y(28) - y(72));
    ctx.strokeStyle = "rgba(239,68,68,0.35)";
    ctx.beginPath();
    ctx.moveTo(0, y(72));
    ctx.lineTo(w, y(72));
    ctx.stroke();
    ctx.strokeStyle = "rgba(34,197,94,0.35)";
    ctx.beginPath();
    ctx.moveTo(0, y(28));
    ctx.lineTo(w, y(28));
    ctx.stroke();
    // line
    ctx.beginPath();
    const step = w / v.length;
    v.forEach((r, i) => (i === 0 ? ctx.moveTo(0, y(r)) : ctx.lineTo(i * step, y(r))));
    ctx.strokeStyle = "#e879f9";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // last value
    const last = v[v.length - 1];
    ctx.fillStyle = "#e879f9";
    ctx.font = "10px system-ui";
    ctx.fillText(`RSI ${last.toFixed(1)}`, 6, 12);
  }
}

// Equity sparkline.
class Sparkline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.points = [];
    this.baseline = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  push(points) {
    this.points = points;
    this.draw();
  }
  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const p = this.points;
    if (p.length < 2) return;
    let lo = Math.min(...p),
      hi = Math.max(...p);
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    const y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
    const x = (i) => (i / (p.length - 1)) * w;
    const up = p[p.length - 1] >= p[0];
    ctx.beginPath();
    p.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.strokeStyle = up ? C.up : C.down;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, up ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fill();
  }
}

window.Charts = { Chart, RsiChart, Sparkline, fmt };
