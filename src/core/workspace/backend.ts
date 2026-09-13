import type { Files, FileView, LayerId, ObjectId, Symlinks } from "../types.js";

export interface View {
  readonly files: Files;
  readonly symlinks: Symlinks;
}

export interface FlushOut extends View {
  readonly dirty: boolean;
}

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
