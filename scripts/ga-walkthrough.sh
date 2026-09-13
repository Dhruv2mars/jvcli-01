#!/bin/sh
# GA walkthrough: exercises spec section 27 items 1-15 end to end on the
# real CLI and fails on the first broken step. Every check prints PASS
# with the evidence, so a green run is the audit trail.
# Usage: scripts/ga-walkthrough.sh [path-to-cli-entry.js]
set -eu
CLI="${JVCLI_SMOKE_BIN:-${1:-dist/cli-entry.js}}"
case "$CLI" in /*) ;; *) CLI="$(pwd)/$CLI";; esac
run_cli() { "$CLI" "$@"; }
ROOT="$(mktemp -d /tmp/jvcli-ga-XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT INT TERM
R="$ROOT/repo"
pass() { printf 'PASS %s: %s\n' "$1" "$2"; }
need() { test "$1" = "$2" || { printf 'FAIL %s: expected %s got %s\n' "$3" "$1" "$2" >&2; exit 1; }; }
json() { python3 -c 'import json,sys; print(json.load(sys.stdin)["'"$1"'"])'; }

mkdir -p "$R"
printf 'hello\n' > "$R/a.txt"
run_cli init "$R" >/dev/null
W1="$(run_cli --json status 2>/dev/null || true)"
cd "$R"
pass "1-init" "world v1 exists: $(run_cli history --world --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["worlds"]))') version"

A="$(run_cli layer create --name alpha --json | json layer)"
WA="$(run_cli layer status "$A" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
B="$(run_cli layer create --name beta --json | json layer)"
WB="$(run_cli layer status "$B" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
pass "2-isolated-layers" "alpha=$A beta=$B workspaces differ"

printf 'tool output\n' > "$WA/tool.txt"
printf 'int main(){}\n' > "$WB/prog.c"
pass "3-ordinary-tools" "plain writes land in workspaces"

S1="$(run_cli publish "$A" --json | json seq)"
need "$S1" "2" "4-autosave-publish-human"
pass "4-human-publish" "alpha published as v$S1 without context"

run_cli context begin --layer "$B" --agent ga-agent --json >/dev/null
S="$(run_cli context status --layer "$B" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessions"][0]["session"])')"
run_cli context append --layer "$B" --session "$S" --kind note --text "ga trace" --json >/dev/null
printf 'agent edit\n' >> "$WB/prog.c"
run_cli context end --layer "$B" --session "$S" --json >/dev/null
S2="$(run_cli publish "$B" --json | json seq)"
need "$S2" "3" "5-agent-publish"
pass "5-agent-context" "beta session sealed then published as v$S2"

C="$(run_cli layer create --name human --json | json layer)"
WC="$(run_cli layer status "$C" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
printf 'human tweak\n' >> "$WC/prog.c"
pass "6-human-only" "human layer edits without sessions"

K="$(run_cli layer child "$C" --name kid --json | json layer)"
pass "7-child" "child $K branches from human layer"

CL="$(run_cli layer clone "$C" --name clone1 --json | json layer)"
WK="$(run_cli layer status "$K" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
printf 'kid work\n' > "$WK/kid.txt"
ST="$(run_cli stack "$CL" "$K" --into family --json | json dest)"
pass "8-clone-stack" "stacked clone plus child into $ST"

D12="$(run_cli diff v1 v2 --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["changes"]))')"
H3="$(run_cli history --world --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["worlds"]))')"
pass "9-inspect" "diff v1 v2 has $D12 changes, history has $H3 worlds"

D="$(run_cli layer create --name stale-ok --json | json layer)"
WD="$(run_cli layer status "$D" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
printf 'disjoint\n' > "$WD/fresh.txt"
E="$(run_cli layer create --name bumper --json | json layer)"
WE="$(run_cli layer status "$E" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
printf 'bump\n' > "$WE/bump.txt"
run_cli publish "$E" --json >/dev/null
SD="$(run_cli publish "$D" --json | json seq)"
pass "10-stale-compatible" "stale layer auto-merged as v$SD"

F="$(run_cli layer create --name clash1 --json | json layer)"
G="$(run_cli layer create --name clash2 --json | json layer)"
WF="$(run_cli layer status "$F" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
WG="$(run_cli layer status "$G" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
printf 'one\n' > "$WF/a.txt"
printf 'two\n' > "$WG/a.txt"
run_cli publish "$F" --json >/dev/null
if run_cli publish "$G" --json >/dev/null 2>&1; then printf 'FAIL 11-conflict: expected E_CONFLICT\n' >&2; exit 1; fi
P11="$(run_cli publish "$G" --json 2>&1 | python3 -c 'import json,sys; print((json.load(sys.stdin)["error"].get("paths") or ["?"])[0])')"
pass "11-conflict" "incompatible publish reports $P11"

H="$(run_cli layer create --name atomic --json | json layer)"
WH="$(run_cli layer status "$H" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["layer"]["workspace"])')"
printf 'atomic\n' > "$WH/atomic.txt"
OP="abcdef0123456789abcdef0123456789"
SH="$(run_cli publish "$H" --operation-id "$OP" --json | json world)"
SH2="$(run_cli publish "$H" --operation-id "$OP" --json | json world)"
pass "12-atomic-publish" "world $SH stable across op-id retry ($SH2)"

run_cli verify --full --json >/dev/null
GCD="$(run_cli gc --dry-run --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["removed"])')"
pass "13-retry-verify" "verify --full clean, gc dry-run reports $GCD candidates"

run_cli layer close "$C" --json >/dev/null
run_cli layer open "$C" --json >/dev/null
run_cli verify --json >/dev/null
pass "14-recovery" "close plus open plus verify clean"

V15="$(run_cli verify --full --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["worlds"],d["layers"],d["objects"])')"
pass "15-verify-refs" "verify --full reports $V15"
printf 'GA-WALKTHROUGH-GREEN worlds=%s\n' "$(run_cli history --world --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["worlds"]))')"
