#!/bin/sh
# Pack smoke: builds, packs, installs into a temp dir with dependencies,
# and runs the GA walkthrough against the installed binary.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/jvcli-pack-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT INT TERM
cd "$ROOT"
bun run build >/dev/null
PKG="$(bun pm pack --destination "$WORK" 2>/dev/null | grep -o "$WORK/.*\.tgz" | head -1)"
test -n "$PKG"
mkdir -p "$WORK/install"
tar -xzf "$PKG" -C "$WORK/install"
cd "$WORK/install/package"
test -f dist/cli-entry.js
bun install --silent >/dev/null 2>&1
node dist/cli-entry.js --help >/dev/null
"$ROOT/scripts/ga-walkthrough.sh" "$WORK/install/package/dist/cli-entry.js"
printf 'PACK-SMOKE-GREEN %s\n' "$PKG"
