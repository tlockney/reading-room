#!/bin/sh
# convert-to-engine.sh — migrate an existing Reading Room content repo into the
# resolved content home so the installed `reading-room` CLI can serve it.
#
# Usage:
#   convert-to-engine.sh [SOURCE_DIR]
#
#   SOURCE_DIR  directory holding the content to migrate (default: .)
#
# The resolved home follows the same precedence as the CLI:
#   $READING_ROOM_HOME → ${XDG_DATA_HOME:-~/.local/share}/reading-room
# Override before running: READING_ROOM_HOME=/my/path sh convert-to-engine.sh
#
# Nothing in the home is ever overwritten; existing files are skipped.
set -eu

# --- resolve paths ------------------------------------------------------------
SRC="${1:-.}"
SRC="$(cd "$SRC" && pwd)"

if [ -n "${READING_ROOM_HOME:-}" ]; then
  HOME_DIR="$READING_ROOM_HOME"
elif [ -n "${XDG_DATA_HOME:-}" ]; then
  HOME_DIR="$XDG_DATA_HOME/reading-room"
else
  HOME_DIR="${HOME}/.local/share/reading-room"
fi

echo "source:  $SRC"
echo "home:    $HOME_DIR"

# --- init the home ------------------------------------------------------------
if command -v reading-room >/dev/null 2>&1; then
  echo "running: reading-room init"
  reading-room init
else
  echo "reading-room not installed — run init manually:"
  echo "  deno run -A jsr:@tlockney/reading-room/cli init"
  echo "(continuing with mkdir -p fallback)"
  mkdir -p "$HOME_DIR/_migrated" "$HOME_DIR/comments"
fi

# --- migrate content ----------------------------------------------------------
# Each item is copied only if it does not already exist in the home.

copy_if_absent() {
  src_path="$1"
  dest_path="$2"
  if [ -e "$dest_path" ]; then
    echo "skip (exists): $dest_path"
  else
    cp -R "$src_path" "$dest_path"
    echo "copied: $dest_path"
  fi
}

for item in registry.jsonc site.jsonc publish.jsonc; do
  [ -f "$SRC/$item" ] || continue
  copy_if_absent "$SRC/$item" "$HOME_DIR/$item"
done

for dir in _migrated comments assets; do
  [ -d "$SRC/$dir" ] || continue
  copy_if_absent "$SRC/$dir" "$HOME_DIR/$dir"
done

# --- print next steps ---------------------------------------------------------
cat <<NEXT

Migration complete. Next steps:

1. Install (or upgrade) the CLI:

   deno install -g -f -n reading-room \\
     --allow-read --allow-write --allow-net --allow-run \\
     --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME \\
     --minimum-dependency-age=0 \\
     jsr:@tlockney/reading-room/cli

2. Verify the content home:

   reading-room serve

3. For an always-on launchd agent (macOS), the agent plist needs only:

     <key>ProgramArguments</key>
     <array>
       <string>/path/to/reading-room</string><string>serve</string>
     </array>

   No WorkingDirectory needed — the CLI resolves the home from
   \$READING_ROOM_HOME or the XDG default.

NEXT
