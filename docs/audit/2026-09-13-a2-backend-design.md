# A2: Portable workspace backend contract (design only)

## 1. Interface (uses branded ids from `src/core/types.ts`)
```ts
// src/core/workspace/backend.ts
import type { Files, FileView, LayerId, ObjectId, Symlinks } from "../types.js";
export interface View { readonly files: Files; readonly symlinks: Symlinks; }
export interface FlushOut extends View { readonly dirty: boolean; }
export interface WorkspaceBackend {
  createWorkspace(layer: LayerId, root: ObjectId, base: View): Promise<void>;
  openWorkspace(layer: LayerId, root: ObjectId): Promise<void>;
  closeWorkspace(layer: LayerId): Promise<void>;
  destroyWorkspace(layer: LayerId): Promise<void>;
  readView(layer: LayerId, path: string): Promise<FileView | null>;
  enumerateView(layer: LayerId): Promise<readonly string[]>;
  recordWrite(layer: LayerId, path: string, v: FileView | null): Promise<void>;
  recordDelete(layer: LayerId, path: string): Promise<void>;
  recordRename(layer: LayerId, from: string, to: string): Promise<void>;
  flushWorkspace(layer: LayerId): Promise<FlushOut>;
  recoverWorkspace(layer: LayerId, root: ObjectId, base: View): Promise<void>;
}
```

## 2. Placement and imports
- New file `src/core/workspace/backend.ts` (interface + `View` only).
- Impls: `src/core/workspace/fs.ts` (`FsBackend`, wraps `scan.ts`), `src/core/workspace/memory.ts` (`MemoryBackend`, `Map` overlay).
- Imports: `type`-only from `../types.js`, `../paths.js` (normalize/ignore); `fs.ts` alone imports `../scan.js`; domain imports `type { WorkspaceBackend }`; `verbatimModuleSyntax` safe. No `Effect` needed.

## 3. `flushLayer` / `checkpointLayer` integration (no caller break)
- Keep `flushLayer(repo, selector)` and `checkpointLayer(repo, id, rec, ctx)` signatures; add internal `flushVia(repo, ref, be: WorkspaceBackend)`.
- Default `be = fsBackendFor(repo)`; FS impl: `flushWorkspace` = coalesced `record_*` overlay + conditional `scanDirectory` (dirty fast-path via `enumerateView` + mtime), caller still does `buildTreeFromFiles` + `TreeStager.flush(store)` + checkpoint encode. Memory impl same caller path.
- `materializeFromRoot` becomes `be.createWorkspace(id, root, {files, symlinks})`; `openLayer`/`closeLayer` delegate to `open/closeWorkspace`; `layerStatus` uses `enumerateView` + `hashTree`.

## 4. Conformance suite
- File `tests/workspace-conformance.ts`: `runConformance(make: () => WorkspaceBackend)` executed twice (fs-tmpdir, memory).
- Scenarios: empty/nested/exec-bit/symlink round-trip; write/delete/rename; coalesced writes (N writes one flush); watcher-overflow flag → targeted re-read of listed paths; destroy + recover from checkpoint root.
- Equality predicate: `hashTree(got.files, got.symlinks) === hashTree(want.files, want.symlinks)` (so `ObjectId` equal, Spec 9.3) AND byte-equal `readView` per path AND equal `enumerateView` sets.

## 5. Alternatives rejected
- A: pass raw FS paths into backends — rejected: leaks mount/overlay layout and breaks ProjFS virtualization.
- B: watcher events as source of truth — rejected: overflows force full rescan, violating Spec 11.2 last-resort rule (coalesce + targeted first).
```
