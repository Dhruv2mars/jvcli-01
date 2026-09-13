import { normalizePath } from "../paths.js";
import type { FileView, LayerId, ObjectId } from "../types.js";
import type { FlushOut, View, WorkspaceBackend } from "./backend.js";

interface State {
  readonly files: Map<string, FileView>;
  readonly symlinks: Map<string, string>;
  mutated: boolean;
}

export class MemoryBackend implements WorkspaceBackend {
  readonly #layers = new Map<string, State>();

  #ensure(layer: LayerId): State {
    const hit = this.#layers.get(layer);
    if (hit !== undefined) return hit;
    const fresh: State = { files: new Map(), symlinks: new Map(), mutated: false };
    this.#layers.set(layer, fresh);
    return fresh;
  }

  async createWorkspace(layer: LayerId, _root: ObjectId, base: View): Promise<void> {
    this.#layers.set(layer, { files: new Map(base.files), symlinks: new Map(base.symlinks), mutated: false });
  }

  async openWorkspace(layer: LayerId, _root: ObjectId): Promise<void> {
    this.#ensure(layer);
  }

  async closeWorkspace(layer: LayerId): Promise<void> {
    this.#layers.delete(layer);
  }

  async destroyWorkspace(layer: LayerId): Promise<void> {
    this.#layers.delete(layer);
  }

  async readView(layer: LayerId, path: string): Promise<FileView | null> {
    const p = normalizePath(path);
    return this.#layers.get(layer)?.files.get(p) ?? null;
  }

  async enumerateView(layer: LayerId): Promise<readonly string[]> {
    const st = this.#layers.get(layer);
    if (st === undefined) return [];
    return [...new Set([...st.files.keys(), ...st.symlinks.keys()])].sort();
  }

  async recordWrite(layer: LayerId, path: string, v: FileView | null): Promise<void> {
    const st = this.#ensure(layer);
    const p = normalizePath(path);
    if (v === null) {
      st.files.delete(p);
      st.symlinks.delete(p);
    } else {
      st.files.set(p, v);
    }
    st.mutated = true;
  }

  async recordDelete(layer: LayerId, path: string): Promise<void> {
    const st = this.#ensure(layer);
    const p = normalizePath(path);
    st.files.delete(p);
    st.symlinks.delete(p);
    st.mutated = true;
  }

  async recordRename(layer: LayerId, from: string, to: string): Promise<void> {
    const st = this.#ensure(layer);
    const f = normalizePath(from);
    const t = normalizePath(to);
    const file = st.files.get(f);
    if (file !== undefined) {
      st.files.delete(f);
      st.files.set(t, file);
    } else {
      const link = st.symlinks.get(f);
      if (link !== undefined) {
        st.symlinks.delete(f);
        st.symlinks.set(t, link);
      }
    }
    st.mutated = true;
  }

  async flushWorkspace(layer: LayerId): Promise<FlushOut> {
    const st = this.#ensure(layer);
    const out: FlushOut = { files: new Map(st.files), symlinks: new Map(st.symlinks), dirty: st.mutated };
    st.mutated = false;
    return out;
  }

  recoverWorkspace(layer: LayerId, root: ObjectId, base: View): Promise<void> {
    return this.createWorkspace(layer, root, base);
  }
}
