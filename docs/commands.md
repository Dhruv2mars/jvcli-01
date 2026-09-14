# jvcli command reference

Executable: `jvcli`. The npm `bin` entries `jvcli` and `jvcli-01` in
`package.json` both point at `dist/cli-entry.js`; during development use
`node dist/cli-entry.js`.
All flag spellings below match `src/cli.ts` and `node dist/cli-entry.js --help` exactly.

## Global conventions

Run every command (except `init` and `help`) from inside a repository, so parent
directory search finds `.javelin/repo.json`. Repo discovery is in `src/locate.ts`.

`--json` prints a JSON object on stdout instead of human text. The usage
lines show `[--json]` on every command except `init` and
`diagnostics bundle`, but `src/cli.ts` honors `--json` on `init` too, so
`jvcli init --json` works despite the omission in `--help`. For
`diagnostics bundle`, behavior is special: without `--output` stdout is
always the JSON bundle whether or not `--json` is passed; with `--output`
the bundle is also written to that file and stdout is the human line
`bundle: <path>` unless `--json` is passed. For `show`
of a blob, stdout is the raw blob bytes with or without `--json` (see `show`).

Layer selectors accept a full id, a unique id prefix, or a unique layer name
(see `resolveLayerRef` in `src/core/refs.ts`).

World selectors accept `vN` (for example `v3`), a bare sequence number
(for example `3`), or a world id prefix of at least 8 hex characters
(see `resolveWorldSelector` in `src/core/repo.ts`).

## Errors and exit codes

Without `--json`, failures print `jvcli: CODE: message (hint)` on stderr.
With `--json`, failures print this object on stdout:

```json
{
  "ok": false,
  "error": {
    "code": "E_CONFLICT",
    "message": "publish conflicts: a.txt",
    "repo": "abc...",
    "layer": "def...",
    "operation": "123...",
    "paths": ["a.txt"],
    "retryable": false,
    "hint": null
  }
}
```

Missing optional fields are `null`, except `retryable` which is always boolean.
Exit code is `0` on success, `2` on `E_CONFLICT` or `E_STALE`, `1` on any other
error. See `runCli` and `jvErrorJson` in `src/cli.ts`.

Known error codes (`CODES` in `src/core/types.ts`): `E_NOT_REPOSITORY`,
`E_NOT_LAYER`, `E_UNSUPPORTED_FORMAT`, `E_CORRUPT_OBJECT`, `E_INVALID_PATH`,
`E_UNSUPPORTED_PATH`, `E_INVALID_IGNORE`, `E_AMBIGUOUS_LAYER`,
`E_LAYER_NOT_FOUND`, `E_LAYER_STATE`, `E_AGENT_CLAIMED`, `E_CONFLICT`,
`E_STALE`, `E_MISSING_CONTEXT`, `E_BUSY`, `E_BACKEND_UNAVAILABLE`, `E_IO`,
`E_INTERRUPTED`, `E_NO_SPACE`.

## help

Usage: `jvcli help`, `jvcli --help`, `jvcli -h`

Prints the usage text. Exit code `0`.

## init

Usage: `jvcli init [path]`

Creates a repository at `path` (default: current directory). Scans existing
files into the object store, writes world `v1`, and creates `.javelin/`
(`repo.json`, `refs.json`, `objects/`, `journal/`, `layers/`, `tmp/`).

Example:

```sh
jvcli init my-repo
```

JSON shape: `{ ok, repo, root, world, seq: 1, files, warnings }`.
`warnings` lists skipped symlinks or special files.
Portable path policy: names are NFC UTF-8, components cap at 255 bytes,
paths at 4096 bytes, trailing dots and spaces rejected, control characters
rejected, Windows reserved stems (`AUX`, `COM1`, and kin, with or without an
extension) rejected, case-fold collisions rejected, `.javelin` reserved. A
file that violates the policy fails the whole scan with `E_INVALID_PATH`,
so a directory containing `aux.txt` or `readme.` cannot initialize on any
platform. This is the spec section 8.1 rule, kept so hashes match across
macOS, Linux, and Windows.
Exit codes: `1` if the target is not a directory or already a repository.

## status

Usage: `jvcli status [--layer <id>] [--json]`

Without `--layer`, prints the current world plus one line per layer. With
`--layer <id>`, prints world, layer state, checkpoint, anchor, workspace,
dirty flag, checkpoint pending flag, stale flag, and context state. When run
from inside a layer workspace it reports that layer automatically.

Example:

```sh
jvcli status --layer my-feature --json
```

JSON shapes:

- Repo view: `{ ok, repo, root, world: { seq, id }, layers: [{ id, name, state, anchorSeq, stale }] }`
- Layer view: `{ ok, repo, root, world: { seq, id }, layer: { id, name, state, checkpoint, anchorSeq, anchor, workspace, workspace_dirty, checkpoint_pending, checkpoint_durable, stale, context } }`

Exit codes: `1` outside a repository or for an unknown layer.

## history

Usage: `jvcli history [--world | --layer <id>] [--json]`

`--world` (the default) lists every world version by sequence number. A layer
selector (flag or positional value) lists that layer checkpoint chain, newest
first.

Examples:

```sh
jvcli history --world
jvcli history --layer my-feature --json
```

JSON shapes:

- World view: `{ ok, repo, worlds: [{ seq, id, root, prev, publication, contexts }] }`
- Layer view: `{ ok, repo, layer, checkpoints: [{ id, anchor, root }] }`

Exit codes: `1` when neither `--world` nor a resolvable `--layer` is given.

## timeline

Usage: `jvcli timeline [--layer <id>] [--kind <kind>] [--limit <n>] [--json]`

Reads worlds, publications, checkpoints, refresh and stack records, context
manifests, and journals into one flat row list. Writes nothing. Rows sort by
world sequence, then by kind in the order world, publish, checkpoint, refresh
and stack, context, journal. Journal rows that resolve to no sequence sort
last by update time. `--kind` keeps one of `world`, `publish`,
`checkpoint`, `refresh`, `stack`, `context`, or `journal`. `--limit` keeps
the first rows after sorting. `--layer` keeps rows for that layer.

Example:

```sh
jvcli timeline --kind world --json
```

JSON shape: `{ ok, rows: [{ t: { seq, at }, kind, id, layer, operation, detail }] }`.
No row carries payload bytes or workspace paths.
Exit codes: `1` for a bad `--kind`, a bad `--limit`, or an unreadable root.

## show

Usage: `jvcli show <object-or-version> [--json]`

Resolves `vN`, a bare sequence number, a world id prefix, or a raw object id,
then prints the object type. Blob output is the raw blob bytes on stdout (the
JSON form is not used for blobs). Other types print `object <id> type <name>`.

Example:

```sh
jvcli show v2 --json
```

JSON shape: `{ ok, id, type }`, where `type` is one of `blob`, `tree`,
`world`, `checkpoint`, `context-object`, `context-manifest`, `publication`,
`refresh`, `stack`.
Exit codes: `1` for unknown selectors or missing objects (`E_CORRUPT_OBJECT`).

## diff

Usage: `jvcli diff <left> [right] [--json]`

Compares two states. Each side may be `vN`, a sequence number, a world id
prefix, a layer selector, a checkpoint id, or a raw tree id. `right` defaults
to the current world. Human output is one `kind<TAB>path` line per change.

Example:

```sh
jvcli diff v1 v2 --json
```

JSON shape: `{ ok, left, right, changes: [{ path, kind, oldBlob, newBlob }] }`.
Observed `kind` values are `add`, `modify`, `delete`, `type-change`, and
`metadata-change`.
Exit codes: `1` for unresolvable selectors.

## verify

Usage: `jvcli verify [--full] [--json]`

Checks every referenced object: worlds, checkpoints, manifests, and context
objects. `--full` additionally walks every tree and reads every blob payload.

Example:

```sh
jvcli verify --full --json
```

JSON shape: `{ ok, worlds, layers, objects, issues: [] }`. On failure it throws
`E_CORRUPT_OBJECT` listing the first bad object, with up to 10 details in
`paths`. Exit codes: `1` on any integrity failure.

## gc

Usage: `jvcli gc [--dry-run] [--json]`

Marks objects reachable from the current world, all recorded worlds, live
layer checkpoints, and session manifests, then deletes unreferenced object
files. `--dry-run` counts candidates without deleting.

Example:

```sh
jvcli gc --dry-run --json
```

JSON shape: `{ ok, reachable, total, removed, dryRun }`.
Exit codes: `1` outside a repository.

## diagnostics bundle

Usage: `jvcli diagnostics bundle [--output <path>]`

Prints a small JSON bundle (`version`, `repo`, `world`, layer and world
counts, per-state layer counts, stale layer count, journal counts by state
plus operation ids, a non-full verify summary, `platform`, `node`). With
`--output <path>` it also writes the bundle
to that file and reports the resolved `output` path inside the JSON. Without
`--output`, stdout is always JSON; with `--output`, stdout is the human
`bundle: <path>` line unless `--json` is passed.
File bytes and context payloads are never included.

Example:

```sh
jvcli diagnostics bundle --output /tmp/jvdiag.json
```

JSON shape: `{ ok, version: 1, repo, world: { seq, id }, layers, layerStates, staleLayers, worlds, journals: { total, byState, liveOperationIds, archived }, verify: { ok, worlds, layers, objects }, platform, node[, output] }`. `layers` counts every retained ref including tombstones, so it equals the sum of `layerStates`. `liveOperationIds` lists every non-terminal journal id with no cap, and `archived` counts the terminal ones.
Without `--output`, stdout is always JSON. With `--output`, stdout is the
human `bundle: <path>` line unless `--json` is passed; the file always
contains the bundle.
Exit codes: `1` for anything other than the `bundle` subcommand.

## layer create

Usage: `jvcli layer create [--name <n>] [--from <base>] [--json]`

Creates an active layer anchored at the current world, or at `--from <base>`
(a world sequence, world id prefix, or layer id), and materializes its
workspace. Fails if `--name` is already taken.

Example:

```sh
jvcli layer create --name my-feature --json
```

JSON shape: `{ ok, repo, layer, name, workspace }`.
Exit codes: `1` on name clash or bad `--from`.

## layer clone

Usage: `jvcli layer clone <layer> [--name <n>] [--checkpoint <cp>] [--json]`

Copies a layer checkpoint into a new active layer (origin kind 2) and
materializes its workspace. `--checkpoint` must belong to the source layer.

Example:

```sh
jvcli layer clone my-feature --name retry --json
```

JSON shape: `{ ok, repo, layer, workspace }`.
Exit codes: `1` on unknown layer, name clash, or foreign checkpoint.

## layer child

Usage: `jvcli layer child <parent> [--name <n>] [--checkpoint <cp>] [--json]`

Identical to `layer clone` in v1: a new active layer branched from the parent
checkpoint. See `childLayer` in `src/domain-layers.ts`.

Example:

```sh
jvcli layer child my-feature --name sub-task --json
```

JSON shape: `{ ok, repo, layer, workspace }`.
Exit codes: same as `layer clone`.

## layer open

Usage: `jvcli layer open <layer> [--json]`

Reactivates a `closed` layer (state becomes `active`, workspace is
rematerialized) or returns the existing workspace for an `active` layer.
`published`, `consumed`, and `deleted` layers cannot be opened; clone them.

Example:

```sh
jvcli layer open my-feature --json
```

JSON shape: `{ ok, repo, layer, workspace }`.
Exit codes: `1` (`E_LAYER_STATE`) for terminal states, with hint `clone it to continue`.

## layer close

Usage: `jvcli layer close <layer> [--json]`

Flushes a pending checkpoint, then marks the layer `closed` and detaches its
workspace. Only `active` layers can be closed.

Example:

```sh
jvcli layer close my-feature --json
```

JSON shape: `{ ok, layer }`.
Exit codes: `1` (`E_LAYER_STATE`) for non-active layers.

## layer rename

Usage: `jvcli layer rename <layer> <name> [--json]`

Renames a non-deleted layer. Fails if another live layer holds `<name>`.

Example:

```sh
jvcli layer rename abc123 my-feature --json
```

JSON shape: `{ ok, layer, name }`.
Exit codes: `1` on unknown layer, deleted layer, or name clash.

## layer list

Usage: `jvcli layer list [--json]`

Lists all non-deleted layers with id, name, state, anchor version, staleness,
and workspace.

Example:

```sh
jvcli layer list --json
```

JSON shape: `{ ok, layers }`, where each entry carries the full status fields
described under `layer status`.
Exit codes: `1` outside a repository.

## layer status

Usage: `jvcli layer status <layer> [--json]`

Detailed status for one layer. The selector may be omitted when run from
inside that layer workspace.

Example:

```sh
jvcli layer status my-feature --json
```

JSON shape: `{ ok, layer: { id, name, state, checkpoint, anchorSeq, anchorId, rootId, workspace, agent, dirty, pendingCheckpoint, stale, currentSeq } }`.
Exit codes: `1` for unknown layers.

## layer refresh

Usage: `jvcli layer refresh <layer> [--json]`

Flushes the workspace, then three-way merges the layer onto the current
world. The selector may be omitted when run from inside that layer
workspace. On success the layer checkpoint is re-anchored and the workspace is
rematerialized. On conflict it throws `E_CONFLICT` listing `paths`.

Example:

```sh
jvcli layer refresh my-feature --json
```

JSON shape on success: `{ ok, checkpoint, adopted }`, where `adopted` is the
adopted world sequence.
Exit codes: `2` on merge conflicts (`E_CONFLICT`), `1` otherwise.

## layer delete

Usage: `jvcli layer delete <layer> [--json]`

Flushes, journals the delete, marks the layer `deleted`, and removes its
workspace directory. Deleting an already deleted layer is a no-op success.

Example:

```sh
jvcli layer delete my-feature --json
```

JSON shape: `{ ok }`.
Exit codes: `1` for unknown layers.

## stack

Usage: `jvcli stack <layer>... [--into <name>] [--operation-id <id>] [--json]`

Merges two or more active layers onto the current world in deterministic
(sorted layer id) order, writes a stack record, creates a new active layer
holding the result, and marks sources `consumed`. `--operation-id <id>` makes
the stack resumable: a repeated call with a finalized id returns the same
destination instead of stacking twice. Any normalization or merge
conflict throws `E_CONFLICT` with `paths` and a retry hint.

Example:

```sh
jvcli stack feat-a feat-b --into combined --json
```

JSON shape: `{ ok, dest, workspace, operation, order }`.
Exit codes: `2` on conflicts (`E_CONFLICT`), `1` for fewer than two layers,
non-active sources, or name clashes.

## publish

Usage: `jvcli publish <layer> [--allow-missing-context] [--operation-id <id>] [--json]`

Flushes the layer, checks agent context, three-way merges onto the current
world, and atomically advances the world on success. Without
`--allow-missing-context`, incomplete context throws `E_MISSING_CONTEXT` with
hint `jvcli context status --layer <id>`. `--operation-id <id>` makes the
operation resumable: a repeated call with an accepted or finalized id returns
`status: "recovered"`. The id is bound to its layer, so retrying it from a
different layer fails with `E_IO`. Conflicts throw `E_CONFLICT` with `paths`.
A world that advanced mid-publish throws retryable `E_STALE` (exit `2`, no
conflicting paths: re-resolve and retry the same operation id).

Example:

```sh
jvcli publish my-feature --allow-missing-context --json
```

JSON shape: `{ ok, seq, world, operation, status }`, where `status` is
`published` or `recovered`.
Exit codes: `2` on conflicts or stale worlds, `1` otherwise.

## context status

Usage: `jvcli context status [--layer <id>] [--json]`

Reports agent context sessions for a layer: one line per session, or a
`no sessions` note. The layer may also be given positionally or detected from
the workspace directory.

Example:

```sh
jvcli context status --layer my-feature --json
```

JSON shape: `{ ok, layer, missing, sessions: [{ session, manifest, completeness, objects, bytes, gaps }] }`.
`missing` is true when a session is incomplete or an agent claimed the layer
without sessions.
Exit codes: `1` for unknown layers.

## context sessions

Usage: `jvcli context sessions [--layer <id>] [--json]`

Alias of `context status` in v1: same arguments, same human output, same JSON
shape. See `src/cli.ts`, `context` command.

## context show

Usage: `jvcli context show <session-or-manifest> [--json]`

Resolves a session id, session id prefix, or manifest object id and prints
completeness and object counts.

Example:

```sh
jvcli context show 9f2c --json
```

JSON shape: `{ ok, manifest, repoId, layerId, sessionId, parentSessionId, objectIds, completeness, gaps }`.
Exit codes: `1` (`E_INVALID_PATH`) for unknown sessions.

## context begin

Usage: `jvcli context begin --layer <id> [--session <id>] [--parent <id>] [--agent <a>] [--format <f>] [--json]`

Starts a session on an active layer, claims the layer for `--agent` on first
use (a different agent later gets `E_AGENT_CLAIMED`), and stores an empty
manifest. `--session` must be 32 hex characters when given; `--format`
defaults to `jvcli.text.v1`.

Example:

```sh
jvcli context begin --layer my-feature --agent alice --json
```

JSON shape: `{ ok, manifest, sessionId }`.
Exit codes: `1` for unknown layers, bad session ids, or agent conflicts.

## context append

Usage: `jvcli context append --layer <id> --session <id> --kind <k> [--ordinal <n>] [--text <t>] [--file <p>] [--json]`

Appends one context object to a session. `--kind` defaults to `note`. At
least one of `--text <t>` or `--file <p>` is required; when both are
given, `--file` wins. `--ordinal <n>` pins the
record ordinal for adapters that retransmit; without it the next free ordinal
is used. Duplicate ordinals fail, appends to a sealed session fail, and a gap
in the ordinal sequence marks the manifest completeness `3` with gap ranges.

Example:

```sh
jvcli context append --layer my-feature --session 9f2c --kind note --text "plan approved" --json
```

JSON shape: `{ ok, manifest, objects }`.
Exit codes: `1` for unknown layers or sessions, or when both `--text` and
`--file` are missing.

## context end

Usage: `jvcli context end --layer <id> --session <id> [--interrupted] [--json]`

Seals a session as complete (completeness `1`), or interrupted (completeness
`2`) with `--interrupted`, and checkpoints the layer so the new manifest is
durable.

Example:

```sh
jvcli context end --layer my-feature --session 9f2c --json
```

JSON shape: `{ ok, manifest }`.
Exit codes: `1` for unknown layers or sessions.

## checkpoint

Usage: `jvcli checkpoint --layer <id> [--json]` or `jvcli checkpoint --all [--json]`

Checkpoints one dirty layer now, or every dirty active layer with `--all`.
Clean layers report `created: false` with exit `0`. Each checkpoint writes a
journal entry, a checkpoint object, and advances the layer reference.

Example:

```sh
jvcli checkpoint --all --json
```

JSON shapes: `{ ok, repo, layer, checkpoint, created }` for one layer,
`{ ok, repo, created, checkpoints: [{ layer, checkpoint, created }] }` for `--all`.
Exit codes: `1` for an unknown layer or for `--all` combined with a layer.

## watch

Usage: `jvcli watch [--interval <ms>] [--once] [--layer <id>] [--json]`

Polls workspaces and checkpoints dirty layers through the checkpoint engine.
Requests coalesce by layer. `--interval` sets the pause between cycles in
milliseconds, from `250` to `60000`, default `2000`. `--once` runs one cycle
and exits. Without `--once` the loop runs until it receives `SIGINT` or
`SIGTERM`, which stop it with exit `0`. `--layer` watches one layer,
resolved by name, id, or current workspace.

Example:

```sh
jvcli watch --once --json
```

JSON shape per cycle: `{ ok, repo, cycle, interval, checked, dirty, checkpointed, checkpoints }`.
Exit codes: `1` for a bad `--interval` or an unknown layer.
