# jvcli architecture

v1 implements local agent native version control with filesystem workspaces
plus in-memory reference semantics. The spec platform backends
(FSKit, OverlayFS, ProjFS) are out of scope for v1. There is no environment
cache and no remote protocol in v1.

## Module map

Entry and dispatch:

- `src/cli-entry.ts`: node entry point. Runs `runCli(process.argv.slice(2))`
  with `Effect.runPromise`.
- `src/cli.ts`: help text, flag parsing (`flag`, `has`), dispatch
  (`execute`), output (`emit`, `out`), and error mapping (`jvErrorJson`,
  `runCli`). Every flag documented in `docs/commands.md` is defined here.
- `src/locate.ts`: repo discovery (`findRepoRoot` walks up to
  `.javelin/repo.json`) and workspace detection (`findLayerForCwd` walks up
  to a `.jvcli-layer` marker).

Domains (one file per concern):

- `src/domain-init.ts`: `initRepository`. Scans the target directory, writes
  the initial tree and world `v1`, creates `.javelin/`.
- `src/domain-layers.ts`: layer lifecycle. `createLayer`, `cloneLayer`,
  `childLayer` (delegates to `cloneLayer` in v1), `openLayer`,
  `closeLayer`, `flushLayer`, `checkpointLayer`, `layerStatus`,
  `listLayers`, `renameLayer`, `deleteLayer`, `refreshLayer`,
  `materializeFromRoot`.
- `src/domain-compose.ts`: multi state operations. `publishLayer`,
  `stackLayers`, plus merge helpers.
- `src/domain-context.ts`: agent context. `sessionStart`, `sessionAppend`,
  `sessionEnd`, `layerContextStatus`, `collectLayerContexts`.
- `src/domain-verify.ts`: integrity and reclamation. `verifyRepo`,
  `gcRepo`.

Core (storage primitives and encoding):

- `src/core/cbor.ts`: deterministic CBOR subset, `wrapObject` and
  `unwrapObject`, tree and blob encoders, `objectId` (BLAKE3-256 hex of the
  canonical bytes).
- `src/core/objects.ts`: the 9 object codecs plus `buildTreeFromFiles`,
  `flattenTree`, `diffTrees`, `structuralCompatible`.
- `src/core/store.ts`: `ObjectStore`. Sharded layout
  `objects/<aa>/<rest>`, atomic put through `tmp/` with fsync, hash
  verification on every read, collision detection.
- `src/core/refs.ts`: `refs.json` load, save, and CAS (`casRefs`),
  `resolveLayerRef`, and the per operation journal
  (`appendJournal`, `readJournal`, `updateJournal`).
- `src/core/repo.ts`: `openRepo`, world helpers (`currentWorldId`,
  `listWorlds`, `resolveWorldSelector`), tree flattening with a per call
  tree cache.
- `src/core/paths.ts`: path normalization and ignore rules. `.javelin` is
  reserved, symlinks that escape the root are skipped with warnings.
- `src/core/scan.ts`: directory scan, tree materialization, workspace
  clearing. Honors `.javelinignore`.
- `src/core/ids.ts`: 16 byte random hex ids for layers, sessions, and
  operations (`newId16`).
- `src/core/types.ts`: id brands, object type numbers 1 to 9, layer states,
  `JvError`, and the `CODES` table.
- `src/core/workspace/`: reserved for future workspace backends. Empty in
  v1, which uses plain filesystem directories.

## Object model

Objects are content addressed under `.javelin/objects`. The id is the
BLAKE3-256 hash of the deterministic CBOR encoding, so equal content has
equal ids and any corruption is detected on read (`ObjectStore.read`
recomputes the hash). The 9 types, with numeric tags from
`src/core/types.ts` and codecs in `src/core/objects.ts`:

1. `blob`: raw file bytes (`encodeBlob`).
2. `tree`: sorted directory entries. Each entry is file (points at a blob),
   dir (points at a tree), or symlink (stores the target string), plus the
   executable bit for files.
3. `world`: world version. Fields: repo id, sequence number, root tree id,
   previous world id, publication record id, sorted context manifest ids.
4. `checkpoint`: layer checkpoint. Fields: layer id, origin kind and id,
   anchor world id, root tree id, previous checkpoint id, record id
   (publication, refresh, or stack record), sorted context manifest ids.
5. `context-object`: one agent record. Fields: format, kind, ordinal, bytes.
6. `context-manifest`: one session. Fields: repo id, layer id, session id,
   parent session id, ordered object ids, completeness (0 open, 1 complete,
   2 interrupted, 3 reserved), gaps.
7. `publication`: publish record. Fields: layer id, checkpoint id, anchor
   id, prior world id, result root id, sequence number, context ids, actor,
   override flag, operation id.
8. `refresh`: refresh record. Fields: layer id, previous checkpoint id,
   previous anchor id, adopted world id, result root id, operation id.
9. `stack`: stack record. Fields: sorted sources (layer, checkpoint, root),
   anchor world id, destination layer id, result root id, order, context
   ids, operation id.

Trees are built bottom up by `buildTreeFromFiles`: blobs first, then child
trees, then parents, with directory entries sorted so encoding is canonical.
`flattenTree` walks a root into `(path -> blob id)` file and symlink maps.

## Refs and journal discipline

`refs.json` (see `src/core/refs.ts`) holds `{ currentWorld, worldsBySeq,
layers }`. Each layer ref holds id, name, origin kind and id, checkpoint id,
state, agent claim, session map (session id to manifest id), workspace path,
and delete metadata. Writes are atomic: serialize to a temp file, fsync the
file, rename over the target, fsync the directory.

Multi step mutations use compare and swap. `casRefs` reloads `refs.json`
and only swaps when the reloaded bytes equal the snapshot taken before the
operation. Publish and stack use this, and throw retryable `E_BUSY` when the
swap loses, so concurrent writers cannot silently interleave.

The journal (`.javelin/journal/<operationId>.json`) records recovery state
per operation. Publish moves through `prepared`, `objects_durable`,
`accepted`, `finalized`, with `conflict` as a terminal non success state.
Stack, refresh, and delete use `prepared` and `finalized` (refresh and
delete also record `conflict` or early finalization as applicable). A
repeated publish with an `accepted` or `finalized` operation id returns
`status: "recovered"` instead of duplicating the world. See
`docs/conformance.md` for the fault injection story.

## Publish, stack, and refresh flows

Publish (`publishLayer` in `src/domain-compose.ts`):

1. Resolve the layer, allocate or resume the operation id, journal
   `prepared`.
2. `flushLayer` checkpoints dirty workspace bytes, so the merge input is
   durable before any decision.
3. Load the anchor, prior world, and layer trees. Run
   `structuralCompatible(anchor, prior, layer)`. On conflict, journal
   `conflict` and return the conflicting paths.
4. Build the merged tree, persist blobs and trees, journal
   `objects_durable`.
5. Encode publication and world objects, then CAS `refs.json`: advance
   `currentWorld` and `worldsBySeq`, mark the layer `published`.
6. Journal `accepted`, then `finalized`. A stale world detected between
   merge and CAS either revalidates or throws retryable `E_STALE`.

Stack (`stackLayers` in `src/domain-compose.ts`):

1. Require at least two active sources, flush each, journal `prepared`.
2. Normalize every source onto the current world in isolation, so a stale
   source fails fast with `E_CONFLICT` before anything is written.
3. Fold sources in deterministic sorted layer id order with
   `structuralCompatible(current, accumulator, next)`. Any overlap that is
   not byte identical is a conflict.
4. Write the merged tree and a stack record, create the destination layer
   checkpoint, CAS `refs.json` (sources become `consumed`, destination
   becomes `active`), journal `finalized`, materialize the workspace.

Refresh (`refreshLayer` in `src/domain-layers.ts`):

1. Flush the workspace, journal `prepared` with the adopted world.
2. Three way merge `structuralCompatible(anchor, current, layer)`.
3. On conflict, journal `conflict` and return paths without touching the
   checkpoint. On success, write a refresh record plus a new checkpoint
   re anchored at the current world, save refs, journal `finalized`, and
   rematerialize the workspace.

Conflict semantics are shared: `diffTrees` classifies per path changes
(add, modify, delete, type-change, metadata-change), and
`structuralCompatible` reports `both-write`, `delete-modify`,
`type-clash`, and `ancestor-clash`.

## Workspace and checkpoint model

Each layer owns a workspace directory at
`.javelin/layers/<id>/workspace`. `createLayer` anchors the layer at the
current world (or `--from`) and materializes the anchor tree there.
`materializeFromRoot` clears the workspace, replays file bytes and
symlinks, and restores executable bits.

Checkpoints are taken by scanning the workspace (`scanDirectory`, honoring
`.javelinignore`), rebuilding the tree, and linking the new checkpoint to
the previous one through `prevId`. `flushLayer` is a no-op when the live
tree equals the checkpoint tree. `layerStatus` recomputes the live tree to
report `dirty` and `pendingCheckpoint`, and compares the anchor against the
current world to report `stale`.

Layer states are `active`, `closed`, `consumed`, `published`, `deleted`.
`close` flushes and detaches the workspace, `open` reattaches and
rematerializes it, `delete` journals the intent, marks the ref deleted, and
removes the directory. Only `active` layers accept writes, publishes,
refreshes, and context sessions.

## GC roots and collection phases

v1 implements explicit two-epoch reachability with dry-run, in the simplest
durable form: one foreground mark pass plus one sweep pass per `gc`
invocation. There are no background or incremental epochs and no persistent
epoch counters.

- Phase 1 (epoch one, mark): seed from explicit roots, the current world, every entry
  of `worldsBySeq`, every non deleted layer checkpoint, and every session
  manifest. Traverse by type: worlds to roots, previous worlds,
  publications, and contexts; checkpoints to anchors, roots, previous
  checkpoints, records, and contexts; trees to child trees and blobs;
  manifests to context objects; publication, refresh, and stack records to
  the checkpoints, worlds, roots, and contexts they cite.
- Phase 2 (epoch two, sweep): list every object file on disk and delete files outside
  the reachable set. With `--dry-run`, count the candidates and delete
  nothing.

Deleted layers are excluded from the roots, so their private checkpoints
become collectible once no world or record cites them. Journal files are
not object roots and are never swept by GC.

## Deliberately deferred

- Platform backends: FSKit (macOS), OverlayFS (Linux), and ProjFS
  (Windows) are not implemented. v1 uses plain filesystem workspaces on
  every platform, with in-memory tree comparison for merge semantics.
- Environment cache: no cached build or tool outputs outside the object
  store. Every status check rescans the workspace.
- Remote protocol: no fetch, push, or sync. Worlds advance only through
  local publish.
- Persistent GC epochs: collection is a single foreground pass per `gc`
  invocation, not a scheduled multi epoch collector.
- Golden vector suite: canonical encodings are defined by
  `src/core/cbor.ts` and checked by hash on read, but no checked in
  fixture vectors ship with v1.
