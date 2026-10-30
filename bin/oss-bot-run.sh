#!/bin/zsh
# One scheduled pass, as launchd runs it: no shell profile, so PATH and the token are set here.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source ./.env                         # COPILOT_GITHUB_TOKEN (+ TELEGRAM_BOT_TOKEN), chmod 600
if ! docker info >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) docker is not reachable (is Colima running?); skipping this pass" >&2
  exit 0
fi
exec ./node_modules/.bin/tsx src/cli.ts run
