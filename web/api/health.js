// GET /api/health — service heartbeat for the engine service.
export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "sol-paper-trading-engine",
    time: new Date().toISOString(),
  });
}
