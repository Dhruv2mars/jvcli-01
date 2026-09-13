# A3+A4 design package: `timeline` + spec-delta conservation

Sources read: src/cli.ts, src/domain-verify.ts, src/core/refs.ts, src/core/objects.ts (decoders), docs/conformance.md.

## 1. `timeline` command (derived, read-only; spec 5.13)

`jvcli timeline [--layer <id>] [--kind world|publish|checkpoint|refresh|stack|context|journal] [--limit <n>] [--json]`
Added to the `execute()` switch like `history`. Writes nothing to disk. If no source decodes, it errors `E_CORRUPT_OBJECT` only when a reachable root is unreadable, otherwise it degrades per row (journal row with `state: "unreadable"`), mirroring how `diagnostics` treats stale checkpoints (cli.ts:366-371).

### Row model
One flat row list, each row: `{ t, kind, id, layer, operation, detail }`.

- `world`: t = seq; detail = `{ seq, id, prev, publication, contexts: n }`.
- `publish`: t = seq of the world holding publicationId; detail = publication root/seq.
- `checkpoint`: t = anchor seq (via `cp.anchorId -> worldsBySeq` reverse map); detail = `{ layer, root }`.
- `refresh`/`stack`: t = checkpoint's anchor seq (recordId dispatch via `unwrapObject` type 8/9, same as `checkRecordBody`, domain-verify.ts:124).
- `context`: t = checkpoint's anchor seq (manifest from `layer.sessions`); detail = `{ session, completeness, objects: n }`.
- `journal`: t = `updatedAt` (ISO) when the payload's referenced ids do not resolve into the seq map; when they do resolve, t = that seq; `detail` = `{ op, kind, state }`.

### Ordering rule
Worlds carry no timestamps (objects.ts:308-337 confirms), so seq is the sole authoritative axis: rows sort by `(t.seq ?? null first-with-t, then t.at ISO)`. Bucket order within one seq: world < publish < checkpoint < refresh/stack < context < journal. Ties break by id lexicographic. Journals that resolve to no seq sort last by `updatedAt`, then `operationId`. Deterministic without wall-clock interpolation.

### Human output
`v<seq>  <kind>  <id.slice(0,12)>  [layer/short detail]` one line per row; unresolved journal rows as `pending  journal  <opid>  <kind>=<state>`.

### JSON output
`{ ok: true, rows: [...] }` with each row as the model above; no payload bodies, no workspace paths.

### Decoders reused per row kind
| kind | source | decoder |
|---|---|---|
| world | refs.worldsBySeq via store.readChecked(.., 3) | `decodeWorldVersion` |
| publish | world.publicationId, readChecked(.., 7) | `decodePublication` |
| checkpoint | layer.checkpoint chain, readChecked(.., 4) | `decodeCheckpoint` |
| refresh | cp.recordId type 8 | `decodeRefresh` |
| stack | cp.recordId type 9 | `decodeStack` |
| context | layer.sessions, readChecked(.., 6) | `decodeContextManifest` |
| journal | `listJournals` (refs.ts:134) | none (plain JSON cast) |

No new decoders, no new store access pattern beyond what `history`/`verify` already do.

## 2. Conservation checklist (remaining deltas, conformance.md "Honest gaps")

| # | delta | verdict | evidence |
|---|---|---|---|
| 1 | Platform backends (FSKit/OverlayFS/ProjFS) | drop | Declared out of scope for v1 in AGENTS.md and doc; no spec surface left uncovered that v1 claims. |
| 2 | Environment cache (status rescan cost) | defer | Perf only, not correctness; `bun benchmarks/run.ts` exists to baseline when landed. |
| 3 | Remote protocol (fetch/push/sync) | drop | Worlds are local-only per layout; no wire format in spec v1 mapping. |
| 4 | Golden vector fixtures | defer | Interim executable check exists (`verify --full` + hash-on-read, store.ts) and is stated in conformance. |
| 5 | `layer child` alias semantics | drop | Doc already records the alias (origin kind 2); no separate semantics to add. |
| 6a | Verify record bodies: publication cross-check lacks `priorId === world.prevId` and `checkpointId` resolution | keep | `checkPublicationBody` (domain-verify.ts:99-115) checks root/seq/context only; `p.priorId === w.prevId` is a two-line addition and closes the anchor loop gc already walks. |
| 6b | Verify record bodies: refresh `prevAnchorId` unchecked | keep | `checkRecordBody` checks prevCheckpointId but not refresh.prevAnchorId === anchor of prev checkpoint; same pattern, cheap. |
| 6c | GC quarantine | keep, done | Already implemented: 5s mtime cutoff quarantine (domain-verify.ts:267-281); conserve, do not redesign. |
| 6d | GC tmp sweep | keep | `writeJsonAtomic` (refs.ts:54) leaks `*.tmp-<pid>-<ts>` on crash and `.javelin/tmp/` is never swept; add mtime-cutoff sweep of both to gcRepo, reusing the quarantine cutoff. |
| 6e | Journal pruning policy | keep | gcRepo reads all journals forever (listJournals); prune only `finalized`/`accepted`/`conflict` past retention (7d, keep last 100), never `prepared`/`objects_durable`/`world_created`/`stale-retry` (recovery anchors per conformance.md:99-114). |
| 7 | Context completeness level 3 | defer | Reserved and never written; keep the reserve, no writer change needed. |
| 8 | Diagnostics redaction | keep | Bundle currently carries only counts/ids/platform (cli.ts:372-387); encode the policy as "ids and counts only, never payload bytes or paths" enforced by one test so future object samples cannot regress it. |
| 9 | Git interop | drop | AGENTS.md forbids git as a storage backend; conformance states it plainly. |

Conservation rule applied: 6c already satisfies its gap, so 6a/b/d/e are the only new verify/gc code; each is a contained addition to `domain-verify.ts` plus one behavior test.

## 3. Alternatives considered and rejected

1. **Persistent timeline index** (`.javelin/timeline.json` maintained by every domain write). Rejected: 5.13 allows a disposable index, but a maintained one adds a consistency burden to every writer for a read that is cheap to derive at repo scale, and a stale index is worse than no index. Derive on read.
2. **Timeline as a `--journal` flag on `history`**. Rejected: the history branch already has a `--world`/`--layer` fall-through (cli.ts:220-251); merging advisory journal rows into an authoritative refs view muddies both semantics and forces one output shape to serve two contracts. A separate command keeps `history` pure.
