# jvcli spec conformance notes

This file maps the Javelin `javelin-cli` specification, revision 1.0, to the
v1 implementation. It states what is covered, how it is verified, and where
v1 knowingly stops. Platform backends (FSKit, OverlayFS, ProjFS) are out of
scope for v1 and are listed as gaps.

## Spec section mapping

Object model and encoding:

- Canonical CBOR and content addressing: `src/core/cbor.ts`
  (`wrapObject`, `unwrapObject`, `objectId` as BLAKE3-256 of canonical
  bytes). `src/core/store.ts` enforces hash on read.
- Blob and tree objects, sorted canonical trees, flatten and diff:
  `src/core/objects.ts` (`buildTreeFromFiles`, `flattenTree`, `diffTrees`).
- World versions, checkpoints, publications, refresh and stack records,
  context objects and manifests: `src/core/objects.ts` codecs for types 1
  to 9; type numbers in `src/core/types.ts`.

Repository layout and references:

- `.javelin/` layout (`repo.json`, `refs.json`, `objects/`, `journal/`,
  `layers/<id>/workspace`, `tmp/`): `src/domain-init.ts`,
  `src/core/repo.ts`, `src/core/paths.ts`.
- Reference discipline, atomic writes, compare and swap:
  `src/core/refs.ts` (`writeJsonAtomic`, `saveRefs`, `casRefs`).
- Repo and layer discovery: `src/locate.ts`.

Operations:

- `init`: `src/domain-init.ts` (`initRepository`).
- Layer create, clone, child, open, close, rename, list, status, delete,
  flush and checkpoint: `src/domain-layers.ts`.
- Refresh with three way merge: `refreshLayer` in
  `src/domain-layers.ts`.
- Publish with CAS advance: `publishLayer` in `src/domain-compose.ts`.
- Stack with deterministic order: `stackLayers` in
  `src/domain-compose.ts`.
- Merge and conflict classification (`both-write`, `delete-modify`,
  `type-clash`, `ancestor-clash`): `structuralCompatible` in
  `src/core/objects.ts`.

Agent context:

- Sessions, appends, completion, per layer status and collection:
  `src/domain-context.ts`. Publish gating on `missing` context with
  `--allow-missing-context` override: `src/domain-compose.ts`.

Verification and maintenance:

- Integrity checking (`verify`, `--full` tree walk):
  `verifyRepo` in `src/domain-verify.ts`.
- Reachability GC with `dry-run`: `gcRepo` in `src/domain-verify.ts`.
- Diagnostics bundle: `diagnostics bundle` branch in `src/cli.ts`.

CLI surface and errors:

- Command parsing, flags, JSON output: `src/cli.ts`.
- Structured errors `{ ok: false, error: { code, message, repo, layer,
  operation, paths, retryable, hint } }`, exit `2` on `E_CONFLICT` and
  `E_STALE`, `1` otherwise: `runCli` and `jvErrorJson` in `src/cli.ts`.
  Codes defined in `src/core/types.ts`.

## Golden vectors pointer

v1 ships no checked in golden vector fixtures. The canonical definition of
correct encoding is:

- `src/core/cbor.ts` for the deterministic CBOR subset and envelope.
- `src/core/objects.ts` for each of the 9 object codecs.
- `ObjectStore.read` in `src/core/store.ts` for the acceptance rule: the
  BLAKE3-256 of the stored bytes must equal the file name, and the decoded
  type tag must equal the expected type on `readChecked`.

Any future `tests/golden/` fixtures should assert exact byte encodings for
one object of each type plus `objectId` hex strings, cross checked against
an independent CBOR and BLAKE3 implementation. Until those fixtures land,
`jvcli verify --full` plus hash on read is the executable conformance
check.

## Verification story

`jvcli verify --full` walks every root of trust and reports the first
failure as `E_CORRUPT_OBJECT`:

- Current world pointer and every `worldsBySeq` entry decode as type 3
  with matching sequence numbers.
- Every world root, previous world link, publication link, and context
  manifest link resolves to the expected type.
- Every live layer checkpoint decodes as type 4 with matching layer id,
  anchor, root, previous checkpoint, record, and context links.
- Every session manifest decodes as type 6 and every cited context object
  decodes as type 5.
- With `--full`, every tree in every world and checkpoint is walked and
  every file entry blob payload is read.
- Active layer workspaces must exist on disk.

Journal fault injection points (`.javelin/journal/<operationId>.json`):

- `prepared`: operation accepted but no durable result yet. Safe to retry
  the same command. For publish, reusing `--operation-id` resumes instead
  of duplicating work.
- `objects_durable` (publish only): merged tree, publication, and world
  objects are in the store but `refs.json` has not been swapped. Crash here
  leaves the old world current; retry revalidates and either completes the
  CAS or reports a fresh conflict.
- `accepted`: refs swap succeeded. The world has advanced. Retry returns
  `status: "recovered"` with the same world id.
- `finalized`: terminal success marker for publish, stack, refresh, and
  delete.
- `conflict`: terminal non success marker carrying `conflicts` paths for
  publish and refresh. Resolve in the workspace and retry as a new
  operation.

To simulate a crash, set `JVCLI_FAULT` to a comma separated list of
injection points: `publish:after-merge-durable` (merged tree journaled as
`objects_durable`, before publication bytes exist),
`publish:after-world-created` (publication plus world journaled as
`world_created`), `publish:after-accepted`. The command fails
with retryable `E_INTERRUPTED` at that boundary. Then rerun `verify --full`
and retry the command with the same `--operation-id`. A healthy repo verifies
clean and the retry either completes or reports a
deterministic conflict. Retries reuse the journaled checkpoint and root after
revalidating them against the recomputed merge, so post-crash workspace dirt
never leaks into the recovered world. `tests/recovery.test.ts` covers all
three points plus the stale-retry case.

Conflict semantics: merges are three way over flattened path maps with a
common anchor. Identical changes on both sides merge silently. Any path
changed differently on each side is a conflict: concurrent writes give
`both-write`, write versus delete gives `delete-modify`, file versus
symlink or directory changes give `type-clash`, and nested changes under a
changed directory give `ancestor-clash`. Publish, refresh, and stack all
surface conflicts as `E_CONFLICT` (exit `2`) with sorted `paths`.

## Honest gaps

1. Platform backends: FSKit, OverlayFS, and ProjFS are not implemented.
   Workspaces are plain directories on all platforms.
2. No environment cache: status rescans the workspace every call, so large
   trees pay full scan cost on each invocation.
3. No remote protocol: no fetch, push, clone from URL, or multi machine
   sync. Worlds are local only.
4. No golden vector fixtures: canonical bytes are defined by code, not by
   checked in test vectors.
5. `layer child` is an alias of `layer clone` (origin kind 2 in both
   cases). No separate child specific semantics exist in v1.
6. GC is a single foreground pass per invocation with no persistent
   epochs, no incremental collection, and no journal pruning.
7. Context completeness levels 0, 1, and 2 are used (open, complete,
   interrupted). Level 3 is reserved and never written.
8. Diagnostics bundle is informational only (counts plus platform
   strings). It carries no log redaction policy and no object samples.
9. No git interoperation: jvcli neither reads nor writes git metadata.
   Git is used only for the development workflow of this repository.
