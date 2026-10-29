import { invoke } from "@tauri-apps/api/core";

/** Mirrors `dawg_core::wav::WavFormat`. */
export interface WavFormat {
  channels: number;
  sampleRate: number;
  bits: number;
  containerBytes: number;
  float: boolean;
}

/** Mirrors `dawg_core::EnvPoint`: a source frame and a linear gain (0 to 1.25). */
export interface EnvPoint {
  at: number;
  gain: number;
}

/** Mirrors `dawg_core::session::ClipState`. Frames throughout. */
export interface ClipState {
  id: number;
  source: number;
  start: number;
  offset: number;
  len: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  envelope: EnvPoint[];
}

/** Mirrors `dawg_core::session::TrackState`. */
export interface TrackState {
  id: number;
  name: string;
  gainDb: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  clips: ClipState[];
}

/** Mirrors `dawg_core::session::SourceState`. */
export interface SourceState {
  id: number;
  name: string;
  path: string;
  /** At the session's rate. */
  frames: number;
  channels: number;
  /** The file's own rate. */
  rate: number;
}

/** Mirrors `dawg_core::file::Codec`. */
export type Codec = "wav" | "mp3";

/** Mirrors `dawg_core::session::SessionState`. */
export interface SessionState {
  /** The file the session was opened from. */
  path: string;
  name: string;
  codec: Codec;
  /** For MP3, `bits` and `containerBytes` are 0. */
  format: WavFormat;
  /** MP3 average bitrate. */
  kbps: number | null;
  frames: number;
  /** The session's sample rate. */
  rate: number;
  tracks: TrackState[];
  sources: SourceState[];
  /** What a mixdown covers: first clip heard to the end of the last. */
  start: number;
  end: number;
  /** Export saves the original file's clip as is, not a mixdown. */
  simple: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  extraChunks: string[];
  truncated: boolean;
}

/** Mirrors `dawg_core::session::Placement`. */
export interface Placement {
  /** End to end on this track; null puts each file on a new track. */
  track: number | null;
  start: number;
}

/** Mirrors `dawg_core::session::Imported`. */
export interface Imported {
  clips: number[];
  failed: [string, string][];
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

/** Mirrors `dawg_core::Command` (serde tag "type"). Tracks and clips by id. */
export type Command =
  | { type: "trim_clip"; clip: number; start: number; offset: number; len: number }
  | { type: "move_clip"; clip: number; track: number; start: number }
  | { type: "set_clip_gain"; clip: number; gain_db: number }
  | { type: "set_clip_fades"; clip: number; fade_in: number; fade_out: number }
  | { type: "set_envelope"; clip: number; points: EnvPoint[] }
  | { type: "add_clip"; source: number; track: number; start: number }
  | { type: "delete_clip"; clip: number }
  | { type: "split_clip"; clip: number; at: number }
  | { type: "duplicate_clip"; clip: number }
  | { type: "add_track"; name: string }
  | { type: "delete_track"; track: number }
  | { type: "rename_track"; track: number; name: string }
  | {
      type: "set_track_mix";
      track: number;
      gain_db?: number;
      pan?: number;
      muted?: boolean;
      solo?: boolean;
    }
  | { type: "batch"; commands: Command[] };

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
  importFiles: (paths: string[], at: Placement) =>
    invoke<{ state: SessionState; imported: Imported }>("import_files", { paths, at }),
  /** `buckets` (min, max) pairs over frames `from..to` of a source. */
  peaks: async (source: number, from: number, to: number, buckets: number) =>
    new Float32Array(await invoke<ArrayBuffer>("peaks", { source, from, to, buckets })),
  /** Plays `from..to`; with `looping`, jumps back there at `to` until stopped. */
  play: (from: number, to: number, looping: number | null) => invoke<void>("play", { from, to, looping }),
  stop: () => invoke<void>("stop"),
  transport: () => invoke<{ playing: boolean; position: number; levels: [number, number][] }>("transport"),
  savePreview: () => invoke<SavePreview>("save_preview"),
  replaceOriginal: () =>
    invoke<{ state: SessionState; backup: string }>("replace_original"),
  saveAs: (path: string) => invoke<void>("save_as", { path }),
  lastReplace: () => invoke<Replaced | null>("last_replace"),
  restoreLastReplace: () => invoke<SessionState | null>("restore_last_replace"),
};
