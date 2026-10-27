#!/bin/zsh
# One scheduled pass, as launchd runs it: no shell profile, so the token is sourced here.
# PATH comes from the plist (bin/install-launchd.sh records where node, gh and docker live).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:$HOME/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source ./.env                         # COPILOT_GITHUB_TOKEN (+ TELEGRAM_BOT_TOKEN), chmod 600
if ! docker info >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) docker is not reachable (is Docker Desktop / Colima running?); skipping this pass" >&2
  exit 0
fi
exec ./node_modules/.bin/tsx src/cli.ts run
