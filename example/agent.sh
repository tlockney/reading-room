#!/bin/bash
# Reading Room — local LaunchAgent + Tailscale HTTPS management.
#
# Runs the dynamic server on 127.0.0.1:PORT under launchd (starts at login,
# restarts if it dies), and exposes it over your tailnet via `tailscale serve`
# (HTTPS, tailnet-only — never raw on a LAN). Because serving is dynamic, the
# agent never needs restarting when you add/edit documents.
#
# Runs `deno task serve` in this script's directory, so the same file works in
# the engine repo and in any content repo — copy it next to your deno.jsonc.
#
#   ./agent.sh install     # write + load the agent, set up tailscale serve
#   ./agent.sh uninstall   # unload the agent, reset tailscale serve
#   ./agent.sh status      # show agent + serve state
#   ./agent.sh logs        # tail the agent logs
set -euo pipefail

LABEL="local.reading-room"
PORT="${PORT:-8413}"
RR="$(cd "$(dirname "$0")" && pwd)"
DENO="${DENO:-$(command -v deno || echo /opt/homebrew/bin/deno)}"
TS="${TS:-$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_="$(id -u)"

write_plist() {
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DENO</string><string>task</string><string>serve</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$RR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$RR/.agent.out.log</string>
  <key>StandardErrorPath</key><string>$RR/.agent.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF
}

case "${1:-}" in
install)
  write_plist
  launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_" "$PLIST"
  "$TS" serve --bg "$PORT" ||
    echo "  ! tailscale serve failed — enable HTTPS for your tailnet (admin: DNS → HTTPS Certificates), then: $TS serve --bg $PORT"
  echo "installed."
  echo "  local:  http://127.0.0.1:$PORT/"
  "$TS" serve status 2>/dev/null | sed 's/^/  /' || true
  ;;
uninstall)
  launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
  "$TS" serve reset 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled (agent unloaded, plist removed, tailscale serve reset)."
  ;;
status)
  launchctl print "gui/$UID_/$LABEL" 2>/dev/null | grep -E "state =|pid =" | sed 's/^/  /' || echo "  agent not loaded"
  "$TS" serve status 2>/dev/null || echo "  no serve config"
  ;;
logs)
  tail -n 40 "$RR/.agent.err.log" "$RR/.agent.out.log" 2>/dev/null || echo "no logs yet"
  ;;
*)
  echo "usage: $0 {install|uninstall|status|logs}"
  exit 1
  ;;
esac
