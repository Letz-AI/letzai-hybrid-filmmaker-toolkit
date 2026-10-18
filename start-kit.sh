#!/usr/bin/env sh
# LetzAI Hybrid Filmmaker Kit - macOS / Linux launcher.
# Optional: ./start-kit.sh --project "$HOME/Films/My film"
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js 20 or newer is needed. Download it from https://nodejs.org and run this again."
  echo
  exit 1
fi
exec node server/index.js "$@"
