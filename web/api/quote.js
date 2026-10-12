// GET /api/quote?side=buy|sell&amount=<tokens> — cached Jupiter routed-quote proxy.
// Mirrors the fill model the Rust engine uses: real AMM routing, slippage and
// price impact, so paper fills track true executable prices.
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UPSTREAM = "https://api.jup.ag/swap/v1/quote";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const { side, amount } = req.query;
  const amt = Number(amount);
  if (!["buy", "sell"].includes(side) || !(amt > 0) || !Number.isFinite(amt)) {
    res.status(400).json({ error: "bad_params" });
    return;
  }
  // buy: USDC (6dp) -> SOL; sell: SOL (9dp) -> USDC.
  const base =
    side === "buy" ? 1e6 : 1e9;
  const raw = Math.round(amt * base);
  if (raw <= 0 || raw > Number.MAX_SAFE_INTEGER) {
    res.status(400).json({ error: "amount_out_of_range" });
    return;
  }
  const inputMint = side === "buy" ? USDC : SOL;
  const outputMint = side === "buy" ? SOL : USDC;
  const url = `${UPSTREAM}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${raw}&slippageBps=20&swapMode=ExactIn`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) {
      res.status(502).json({ error: `jup_quote_${r.status}` });
      return;
    }
    const j = await r.json();
    if (j.error || !j.outAmount) {
      res.status(502).json({ error: j.error || "no_out_amount" });
      return;
    }
    const out = Number(j.outAmount) / base;
    if (!(out > 0)) {
      res.status(502).json({ error: "zero_out" });
      return;
    }
    res.status(200).json({
      side,
      grossOut: out,
      priceImpactPct: j.priceImpactPct ?? "0",
      routeLabels: (j.routePlan ?? []).map(
        (s) => s?.swapInfo?.label ?? s?.swapInfo?.ammKey ?? ""
      ),
      ts: Date.now(),
    });
  } catch {
    res.status(502).json({ error: "jup_unreachable" });
  }
}
