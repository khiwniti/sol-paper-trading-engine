// GET /api/price — cached Jupiter mid-market price proxy.
// Lite-api is rate-limited; the 5s edge cache keeps the browser poller polite.
const SOL = "So11111111111111111111111111111111111111112";
const UPSTREAM = "https://lite-api.jup.ag/price/v3";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
  try {
    const r = await fetch(`${UPSTREAM}?ids=${SOL}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) {
      res.status(502).json({ error: `jup_price_${r.status}` });
      return;
    }
    const j = await r.json();
    const entry = j[SOL];
    const price = entry && Number(entry.usdPrice);
    if (!price || !(price > 0)) {
      res.status(502).json({ error: "bad_price_payload" });
      return;
    }
    res.status(200).json({
      price,
      liquidity: entry.liquidity ?? null,
      priceChange24h: entry.priceChange24h ?? null,
      slot: entry.blockId ?? null,
      ts: Date.now(),
    });
  } catch {
    res.status(502).json({ error: "jup_unreachable" });
  }
}
