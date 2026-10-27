#!/bin/zsh
# Installs (or with --uninstall removes) the 2-hourly launchd run for this checkout. Re-run it
# after moving the checkout or switching node versions; it rewrites the job from launchd/*.plist.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
agents="$HOME/Library/LaunchAgents"
gui="gui/$(id -u)"
labels=(dev.khanh.ossbot dev.khanh.ossbot.telegram)   # .telegram: removed job, unloaded if still there

for l in $labels; do launchctl bootout "$gui/$l" 2>/dev/null || true; done
if [[ "${1:-}" == --uninstall ]]; then
  for l in $labels; do rm -f "$agents/$l.plist"; done
  echo "removed: $labels"
  exit 0
fi

# launchd starts jobs without a shell profile: record where this shell finds the tools.
# (Not `path`: in zsh that is PATH itself.)
jobpath=""
for tool in node gh docker git; do
  p="$(command -v $tool)" || { echo "error: $tool is not on PATH" >&2; exit 1; }
  d="$(dirname "$p")"   # not resolved: Homebrew's Cellar paths change on every upgrade
  [[ ":$jobpath:" == *":$d:"* ]] || jobpath="${jobpath:+$jobpath:}$d"
done
jobpath="$jobpath:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$agents" "$dir/data"
for l in dev.khanh.ossbot; do
  sed -e "s|__DIR__|$dir|g" -e "s|__PATH__|$jobpath|g" "$dir/launchd/$l.plist" > "$agents/$l.plist"
  plutil -lint -s "$agents/$l.plist"
  launchctl bootstrap "$gui" "$agents/$l.plist"
  echo "loaded $l"
done
echo "PATH for jobs: $jobpath"
echo "Log: $dir/data/launchd.log.  Run a pass now: launchctl kickstart $gui/dev.khanh.ossbot"
