import { Data } from "effect";

export type Hex32 = string & { readonly _brand: "Hex32" };
export type Hex16 = string & { readonly _brand: "Hex16" };
export type RepoId = Hex16;
export type LayerId = Hex16;
export type SessionId = Hex16;
export type OperationId = Hex16;

export type ObjectId = Hex32;

export const OBJECT_BLOB = 1;
export const OBJECT_TREE = 2;
export const OBJECT_WORLD_VERSION = 3;
export const OBJECT_LAYER_CHECKPOINT = 4;
export const OBJECT_CONTEXT_OBJECT = 5;
export const OBJECT_CONTEXT_MANIFEST = 6;
export const OBJECT_PUBLICATION_RECORD = 7;
export const OBJECT_REFRESH_RECORD = 8;
export const OBJECT_STACK_RECORD = 9;

export const FORMAT_V1 = 1;

export type ObjectType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type LayerState = "active" | "closed" | "consumed" | "published" | "deleted";

export type TreeEntryKind = "file" | "dir" | "symlink";

export interface TreeEntryInput {
  readonly name: string;
  readonly kind: TreeEntryKind;
  readonly target: string;
  readonly executable: boolean;
}

export interface FileView {
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export type Files = ReadonlyMap<string, FileView>;

export type Symlinks = ReadonlyMap<string, string>;

export class JvError extends Data.TaggedError("JvError")<{
  readonly code: string;
  readonly message: string;
  readonly layerId: string | undefined;
  readonly operationId: string | undefined;
  readonly paths: ReadonlyArray<string> | undefined;
  readonly retryable: boolean;
  readonly hint: string | undefined;
}> {}

export const fail = (
  code: string,
  message: string,
  extra?: { layerId?: string; operationId?: string; paths?: ReadonlyArray<string>; hint?: string; retryable?: boolean }
): JvError =>
  new JvError({
    code,
    message,
    layerId: extra?.layerId,
    operationId: extra?.operationId,
    paths: extra?.paths,
    hint: extra?.hint,
    retryable: extra?.retryable ?? false
  });

export const CODES = {
  notRepository: "E_NOT_REPOSITORY",
  notLayerWorkspace: "E_NOT_LAYER",
  unsupportedFormat: "E_UNSUPPORTED_FORMAT",
  corruptObject: "E_CORRUPT_OBJECT",
  invalidPath: "E_INVALID_PATH",
  unsupportedPath: "E_UNSUPPORTED_PATH",
  invalidIgnore: "E_INVALID_IGNORE",
  ambiguousLayer: "E_AMBIGUOUS_LAYER",
  layerNotFound: "E_LAYER_NOT_FOUND",
  layerState: "E_LAYER_STATE",
  agentClaimed: "E_AGENT_CLAIMED",
  conflict: "E_CONFLICT",
  stale: "E_STALE",
  missingContext: "E_MISSING_CONTEXT",
  busy: "E_BUSY",
  backendUnavailable: "E_BACKEND_UNAVAILABLE",
  io: "E_IO",
  interrupted: "E_INTERRUPTED",
  noSpace: "E_NO_SPACE"
} as const;
