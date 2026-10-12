// chart.js — production-grade charting on TradingView Lightweight Charts v5.
// Real OHLC candles with switchable timeframes, EMA overlays, TP/SL/entry
// price lines, and trade-entry markers — the standard pro trading UX.

"use strict";

const ChartX = (() => {
  const TF = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
  };
  let chart = null;
  let candles = null;     // CandlestickSeries
  let emaFastSeries = null;
  let emaSlowSeries = null;
  let markersPrim = null;
  let volumeSeries = null;
  let activeTf = "1m";
  let ticks = [];          // raw ticks: {t (ms), price}
  let markers = [];       // {t, side, price}
  let lines = {};         // {entry, tp, sl}
  let priceLines = [];
  let onTfChange = null;

  const EMA_F = 9, EMA_S = 21;

  // -- OHLC aggregation: bucket raw ticks into timeframe candles --
  function buildCandles(tfMs) {
    const by = new Map();
    for (const { t, price } of ticks) {
      const bucket = Math.floor(t / tfMs) * tfMs;
      let c = by.get(bucket);
      if (!c) {
        c = { time: bucket / 1000, open: price, high: price, low: price, close: price };
        by.set(bucket, c);
      } else {
        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        c.close = price;
      }
    }
    return [...by.values()].sort((a, b) => a.time - b.time);
  }

  function emaOver(candles, period) {
    const out = [];
    const k = 2 / (period + 1);
    let prev = null;
    for (const c of candles) {
      let e;
      if (prev == null) e = c.close;
      else e = c.close * k + prev * (1 - k);
      out.push({ time: c.time, value: e });
      prev = e;
    }
    return out;
  }

  function setData() {
    const tfMs = TF[activeTf];
    const cds = buildCandles(tfMs);
    candles.setData(cds);
    emaFastSeries.setData(emaOver(cds, EMA_F));
    emaSlowSeries.setData(emaOver(cds, EMA_S));

    // markers must land on candle boundaries of the active timeframe
    markersPrim.setMarkers(
      markers
        .map((m) => ({
          time: Math.floor(m.t / tfMs) * tfMs / 1000,
          position: m.side === "buy" ? "belowBar" : "aboveBar",
          color: m.side === "buy" ? "#16a34a" : "#dc2626",
          shape: m.side === "buy" ? "arrowUp" : "arrowDown",
          text: m.side === "buy" ? "B" : "S",
        }))
        .sort((a, b) => a.time - b.time)
    );
  }

  function applyLines() {
    for (const pl of priceLines) candles.removePriceLine(pl);
    priceLines = [];
    const spec = [
      ["entry", "#7c3aed", "ENTRY"],
      ["tp", "#16a34a", "TP"],
      ["sl", "#dc2626", "SL"],
    ];
    for (const [key, color, title] of spec) {
      const v = lines[key];
      if (v == null || !isFinite(v)) continue;
      priceLines.push(
        candles.createPriceLine({
          price: v,
          color,
          lineWidth: 1,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title,
        })
      );
    }
  }

  function init(container, rsiContainer, sparkCanvas, opts = {}) {
    onTfChange = opts.onTfChange || null;
    const LC = window.LightweightCharts;
    chart = LC.createChart(container, {
      layout: {
        background: { type: "solid", color: "#ffffff" },
        textColor: "#64748b",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      rightPriceScale: { borderColor: "#e2e8f0" },
      timeScale: {
        borderColor: "#e2e8f0",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
      },
      crosshair: { mode: LC.CrosshairMode.Normal },
      handleScroll: true,
      handleScale: true,
      autoSize: true,
    });

    candles = chart.addSeries(LC.CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    emaFastSeries = chart.addSeries(LC.LineSeries, {
      color: "#0ea5e9",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    emaSlowSeries = chart.addSeries(LC.LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    markersPrim = LC.createSeriesMarkers(candles, []);

    // RSI pane as a separate lightweight chart synced to the same timescale
    if (rsiContainer) {
      RsiPane.init(rsiContainer);
      chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (r) RsiPane.syncRange(r);
      });
    }
    if (sparkCanvas) Spark.init(sparkCanvas);
  }

  function push(t, price) {
    ticks.push({ t, price });
    const max = 60 * 60 * 1000 * 6; // keep 6h of raw ticks
    const cutoff = t - max;
    if (ticks.length && ticks[0].t < cutoff)
      ticks = ticks.filter((x) => x.t >= cutoff);

    // live-update the forming candle of the active timeframe
    const tfMs = TF[activeTf];
    const bucket = Math.floor(t / tfMs) * tfMs / 1000;
    const last = { time: bucket, open: price, high: price, low: price, close: price };
    candles.update(last);
    const cd = buildCandles(tfMs);
    const fast = emaOver(cd, EMA_F), slow = emaOver(cd, EMA_S);
    emaFastSeries.update(fast[fast.length - 1]);
    emaSlowSeries.update(slow[slow.length - 1]);
  }

  function addMarker(m) { markers.push(m); setData(); }
  function setLines(l) { lines = l || {}; applyLines(); }
  function setTf(tf) {
    if (!TF[tf] || tf === activeTf) return;
    activeTf = tf;
    setData();
    if (onTfChange) onTfChange(tf);
  }
  function activeTimeframe() { return activeTf; }
  function clear() {
    ticks = []; markers = []; lines = {}; applyLines();
    markersPrim.setMarkers([]);
    candles.setData([]); emaFastSeries.setData([]); emaSlowSeries.setData([]);
  }
  function fit() { chart.timeScale().fitContent(); }

  // ---------- RSI sub-pane (separate synced chart) ----------
  const RsiPane = {
    chart: null, series: null, period: 14,
    init(container) {
      const LC = window.LightweightCharts;
      this.chart = LC.createChart(container, {
        layout: {
          background: { type: "solid", color: "#ffffff" },
          textColor: "#64748b", fontSize: 10,
        },
        grid: { vertLines: { color: "#f8fafc" }, horzLines: { color: "#f8fafc" } },
        rightPriceScale: { borderColor: "#e2e8f0", scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: { borderColor: "#e2e8f0", visible: false },
        autoSize: true,
        handleScroll: false,
        handleScale: false,
      });
      this.series = this.chart.addSeries(LC.LineSeries, {
        color: "#d946ef", lineWidth: 1, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false,
      });
      for (const lvl of [30, 70]) {
        this.series.createPriceLine({
          price: lvl, color: lvl === 70 ? "#fca5a5" : "#86efac",
          lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "",
        });
      }
    },
    update(candles) {
      if (!this.series) return;
      // Wilder RSI over candle closes
      const vals = [];
      let g = 0, l = 0;
      for (let i = 1; i < candles.length; i++) {
        const d = candles[i].close - candles[i - 1].close;
        if (i <= this.period) {
          if (d >= 0) g += d; else l -= d;
          if (i === this.period) { g /= this.period; l /= this.period; }
          else continue;
        } else {
          g = (g * (this.period - 1) + Math.max(d, 0)) / this.period;
          l = (l * (this.period - 1) + Math.max(-d, 0)) / this.period;
        }
        const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
        vals.push({ time: candles[i].time, value: rsi });
      }
      this.series.setData(vals);
    },
    syncRange(r) { if (this.chart) this.chart.timeScale().setVisibleLogicalRange(r); },
  };

  // ---------- equity sparkline (canvas) ----------
  const Spark = {
    cv: null, ctx: null, pts: [],
    init(cv) { this.cv = cv; this.ctx = cv.getContext("2d"); this.ro(); window.addEventListener("resize", () => this.ro()); },
    ro() {
      const r = this.cv.getBoundingClientRect(); const dpr = devicePixelRatio || 1;
      this.cv.width = r.width * dpr; this.cv.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.draw();
    },
    push(points) { this.pts = points; this.draw(); },
    draw() {
      const { ctx } = this; const w = this.cv.width / (devicePixelRatio||1), h = this.cv.height / (devicePixelRatio||1);
      ctx.clearRect(0, 0, w, h);
      const p = this.pts; if (p.length < 2) return;
      let lo = Math.min(...p), hi = Math.max(...p); if (lo === hi) { lo--; hi++; }
      const y = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
      const x = (i) => (i / (p.length - 1)) * w;
      const up = p[p.length - 1] >= p[0];
      ctx.beginPath();
      p.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
      ctx.strokeStyle = up ? "#16a34a" : "#dc2626"; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, up ? "rgba(22,163,74,.18)" : "rgba(220,38,38,.18)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fill();
    },
  };

  // refresh RSI when candles change
  const _push = push;
  push = function (t, price) { _push(t, price); RsiPane.update(buildCandles(TF[activeTf])); };

  return { init, push, addMarker, setLines, setTf, activeTimeframe, clear, fit, TF, Spark };
})();

window.ChartX = ChartX;
