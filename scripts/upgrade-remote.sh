#!/bin/sh
# Upgrade the Reading Room CLI + launchd agent on remote macOS hosts over SSH.
#
#   scripts/upgrade-remote.sh <version> [host ...]
#
# With no hosts, upgrades every peer the local instance has discovered
# (GET /api/peers on 127.0.0.1:8413; each peer URL's first DNS label is used as
# the SSH host, e.g. https://m5air.<tailnet>.ts.net/ -> m5air). Hosts need
# key-based SSH and a deno on PATH or at /opt/homebrew/bin/deno.
#
# Per host: reinstalls the `reading-room` CLI into ~/.deno/bin pinned to
# <version>, then re-runs `reading-room agent install` carrying over the
# existing agent's --root, --port, and READONLY settings, and waits until the
# agent serves <version>. A launchd first launch of a new version can stall
# while deno populates its cache; if the agent isn't up in ~45s it is
# kickstarted once. The upgrade stops there on failure; other hosts continue.
#
# Wait for the version to be published on JSR first (the tag's publish
# workflow). Exit status is the number of hosts that did not come up.
set -u

V="${1:-}"
if [ -z "$V" ]; then
  echo "usage: $0 <version> [host ...]" >&2
  exit 64
fi
shift

if [ "$#" -eq 0 ]; then
  HOSTS=$(curl -s -m 20 http://127.0.0.1:8413/api/peers \
    | deno eval --quiet 'const t = await new Response(Deno.stdin.readable).text();
        for (const p of JSON.parse(t).peers ?? []) console.log(new URL(p.url).hostname.split(".")[0]);')
  if [ -z "$HOSTS" ]; then
    echo "no hosts given and no peers discovered on 127.0.0.1:8413" >&2
    exit 64
  fi
  echo "discovered peers: $(echo $HOSTS)"
  set -- $HOSTS
fi

fail=0
for H in "$@"; do
  ssh -o BatchMode=yes -o ConnectTimeout=8 -- "$H" "V='$V'; "'
    set -e
    DENO=$(command -v deno || true); [ -n "$DENO" ] || DENO=/opt/homebrew/bin/deno
    P="$HOME/Library/LaunchAgents/local.reading-room.plist"
    CLI="$HOME/.deno/bin/reading-room"
    echo "== $(hostname -s): upgrading to $V"

    # Carry the current agent settings over the reinstall.
    ARGS=""; PORT=8413
    if [ -f "$P" ]; then
      val() { grep -A1 -- "<string>$1</string>" "$P" | tail -1 | sed "s/<[^>]*>//g;s/^ *//;s/ *$//"; }
      R=$(val --root); [ -n "$R" ] && ARGS="$ARGS --root $R"
      N=$(val --port); [ -n "$N" ] && { PORT=$N; ARGS="$ARGS --port $N"; }
      grep -q "<key>READONLY</key>" "$P" && ARGS="$ARGS --readonly"
      echo "was: $(grep -o "reading-room@[0-9.]*" "$P" | head -1)  keeping:$ARGS"
    fi

    "$DENO" install -g -f --root "$HOME/.deno" -n reading-room \
      --allow-read --allow-write --allow-net --allow-run --allow-sys=hostname \
      --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,XDG_STATE_HOME,HOME \
      --minimum-dependency-age=0 "jsr:@tlockney/reading-room@$V/cli" >/dev/null 2>&1
    "$CLI" --help 2>&1 | head -1
    "$CLI" agent install $ARGS 2>&1 | head -1

    up() { curl -s -m 3 "http://127.0.0.1:$PORT/.well-known/reading-room.json" | grep -q "\"version\":\"$V\""; }
    n=0; until up || [ $n -ge 15 ]; do sleep 3; n=$((n+1)); done
    if ! up; then
      echo "first launch stalled; kickstarting the agent"
      launchctl kickstart -k "gui/$(id -u)/local.reading-room"
      n=0; until up || [ $n -ge 40 ]; do sleep 3; n=$((n+1)); done
    fi
    if up; then
      echo "ok: $(curl -s -m 3 "http://127.0.0.1:$PORT/.well-known/reading-room.json")"
    else
      echo "FAILED: agent not serving $V on :$PORT; see: reading-room agent logs"
      exit 1
    fi
  ' || fail=$((fail + 1))
done
exit "$fail"
