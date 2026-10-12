#!/usr/bin/env bash
# Install the paper-engine long-run daemon as a systemd service.
# Usage: sudo ./scripts/install-service.sh [REPO_DIR]
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SERVICE_SRC="$REPO_DIR/paper-engine.service"
SERVICE_DST="/etc/systemd/system/paper-engine.service"
STATE_DIR="/var/lib/paper-engine"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -x "$REPO_DIR/target/release/paper-engine" ] || {
  echo "binary missing: build first with 'cargo build --release' in $REPO_DIR"; exit 1;
}

# Point the unit at this checkout.
sed "s#^WorkingDirectory=.*#WorkingDirectory=$REPO_DIR#" "$SERVICE_SRC" > "$SERVICE_DST"

# Long-run profile stores state under the systemd state dir by default;
# map that path writable in the unit and point the config at it.
sed -i "s#^ReadWritePaths=.*#ReadWritePaths=$STATE_DIR#" "$SERVICE_DST"
mkdir -p "$STATE_DIR"
sed -i "s#^ExecStart=.*#ExecStart=$REPO_DIR/target/release/paper-engine --config $REPO_DIR/config.longrun.toml live#" "$SERVICE_DST"

systemctl daemon-reload
systemctl enable --now paper-engine
sleep 2
systemctl --no-pager status paper-engine | head -12
echo
echo "live logs: journalctl -u paper-engine -f"
