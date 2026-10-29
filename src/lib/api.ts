import { invoke } from "@tauri-apps/api/core";

/** Mirrors `dawg_core::wav::WavFormat`. */
export interface WavFormat {
  channels: number;
  sampleRate: number;
  bits: number;
  containerBytes: number;
  float: boolean;
}

/** Mirrors `dawg_core::session::ClipState`. Frames throughout. */
export interface ClipState {
  start: number;
  offset: number;
  len: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
}

/** Mirrors `dawg_core::file::Codec`. */
export type Codec = "wav" | "mp3";

/** Mirrors `dawg_core::session::SessionState`. */
export interface SessionState {
  path: string;
  name: string;
  codec: Codec;
  /** For MP3, `bits` and `containerBytes` are 0. */
  format: WavFormat;
  /** MP3 average bitrate. */
  kbps: number | null;
  frames: number;
  clip: ClipState;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  extraChunks: string[];
  truncated: boolean;
}

/** Mirrors `dawg_core::session::SavePreview`. */
export interface SavePreview {
  framesBefore: number;
  framesAfter: number;
  cutStart: number;
  cutEnd: number;
  /** null when the result is silent. */
  peakDb: number | null;
  clipped: boolean;
  untouched: boolean;
}

/** Mirrors `dawg_core::Command` (serde tag "type"). */
export type Command =
  | { type: "trim_clip"; track: number; clip: number; start: number; offset: number; len: number }
  | { type: "set_clip_gain"; track: number; clip: number; gain_db: number }
  | { type: "set_clip_fades"; track: number; clip: number; fade_in: number; fade_out: number };

/** Errors from the Rust side carry a kind to branch on. */
export interface ApiError {
  kind: string;
  message: string;
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export function apiMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface Replaced {
  original: string;
  backup: string;
}

export const api = {
  startupFile: () => invoke<string | null>("startup_file"),
  openFile: (path: string) => invoke<SessionState>("open_file", { path }),
  sessionState: () => invoke<SessionState | null>("session_state"),
  apply: (command: Command, transient: boolean) =>
    invoke<SessionState>("apply", { command, transient }),
  endGesture: () => invoke<SessionState>("end_gesture"),
  undo: () => invoke<SessionState>("undo"),
  redo: () => invoke<SessionState>("redo"),
  /** `buckets` (min, max) pairs over source frames `from..to`. */
  peaks: async (from: number, to: number, buckets: number) =>
    new Float32Array(await invoke<ArrayBuffer>("peaks", { from, to, buckets })),
  play: (from: number, to: number) => invoke<void>("play", { from, to }),
  stop: () => invoke<void>("stop"),
  transport: () => invoke<{ playing: boolean; position: number }>("transport"),
  savePreview: () => invoke<SavePreview>("save_preview"),
  replaceOriginal: () =>
    invoke<{ state: SessionState; backup: string }>("replace_original"),
  saveAs: (path: string) => invoke<void>("save_as", { path }),
  lastReplace: () => invoke<Replaced | null>("last_replace"),
  restoreLastReplace: () => invoke<SessionState | null>("restore_last_replace"),
};
