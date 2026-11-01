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
  /** Timeline frames per source frame (1 = as recorded). */
  stretch: number;
  /** Semitones. */
  pitch: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
  /** Plays backwards; `offset` and the envelope count from the source's end. */
  reversed: boolean;
}

/** Mirrors `dawg_core::FadeCurve`. */
export type FadeCurve = "linear" | "exp" | "s";

/** Mirrors `dawg_core::eq::BandKind`. */
export type BandKind = "bell" | "low_shelf" | "high_shelf" | "low_cut" | "high_cut" | "notch" | "band_pass";

/** Mirrors `dawg_core::EqBand`. */
export interface EqBand {
  kind: BandKind;
  /** Hz. */
  freq: number;
  /** Bells and shelves. */
  gainDb: number;
  q: number;
  /** Cuts: dB per octave, one of 6, 12, 18, 24, 36, 48. */
  slope: number;
  on: boolean;
}

/** Mirrors `dawg_core::session::TrackState`. */
export interface TrackState {
  id: number;
  /** Clip palette index; null colours by its category, else by position. */
  color: number | null;
  /** A `lib/categories.ts` id. */
  category: string | null;
  name: string;
  gainDb: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  clips: ClipState[];
  eq: EqBand[];
  eqBypass: boolean;
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
  /** A project's file that wasn't found; its clips play silence. */
  missing: boolean;
}

/** Mirrors `dawg_core::file::Codec`. */
export type Codec = "wav" | "mp3";

/** Mirrors `dawg_core::session::SessionState`. */
export interface SessionState {
  /** An audio file being edited ("Edit in dawg") rather than a project. */
  scratch: boolean;
  /** The audio file a scratch session edits. */
  path: string | null;
  /** The project's .dawg file, once saved. */
  project: string | null;
  /** The audio file's name, the project's, or "Untitled". */
  name: string;
  /** For a project, what a mixdown defaults to. */
  codec: Codec;
  /** For MP3, `bits` and `containerBytes` are 0. */
  format: WavFormat;
  /** MP3 average bitrate. */
  kbps: number | null;
  frames: number;
  /** The session's sample rate. */
  rate: number;
  tracks: TrackState[];
  /** Master volume. */
  masterDb: number;
  /** Tempo of the bars-and-beats grid. */
  bpm: number;
  sources: SourceState[];
  /** What a mixdown covers: first clip heard to the end of the last. */
  start: number;
  end: number;
  /** Export saves the original file's clip as is, not a mixdown. */
  simple: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Edits that can be undone, oldest first. */
  history: HistoryEntry[];
  /** Undone edits that can be redone, the next one first. */
  future: HistoryEntry[];
  extraChunks: string[];
  truncated: boolean;
}

/** Mirrors `dawg_core::session::ExportOptions`; null keeps the default. */
export interface ExportOptions {
  /** Timeline frames to mix; default first clip heard to the last's end. */
  range: [number, number] | null;
  /** WAV depth: 16, 24 or 32 (float). */
  bits: number | null;
  rate: number | null;
  kbps: number | null;
}

/** Mirrors `dawg_core::session::HistoryEntry`. */
export interface HistoryEntry {
  label: string;
  /** ms since the Unix epoch. */
  at: number;
  /** The icon: the kind of edit ("eq", "volume", "ai", …). */
  kind: string;
  /** Where it happened, outermost first: ["Vocals", "EQ", "Band 2 Bell"]. */
  place: string[];
  /** The values before and after: "Q 9.49 → 3.14". */
  change: string;
  /** Edits folded into the step by a run of quick nudges. */
  edits: number;
  /** Separate changes `change` sums up, when it is a summary. */
  changes: number;
}

/** Mirrors `dawg_core::session::Placement`. */
export interface Placement {
  /** End to end on this track; null puts each file on a new track. */
  track: number | null;
  start: number;
  /** Each file's category, from its Browser labels, by position in the
   * list of paths. A track without one takes the first that lands on it. */
  categories?: (string | null)[];
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
  | {
      type: "set_clip_fades";
      clip: number;
      fade_in: number;
      fade_out: number;
      curve_in?: FadeCurve;
      curve_out?: FadeCurve;
    }
  | { type: "reverse_clip"; clip: number; reversed: boolean }
  | { type: "set_envelope"; clip: number; points: EnvPoint[] }
  | { type: "stretch_clip"; clip: number; stretch: number; start?: number }
  | { type: "set_clip_pitch"; clip: number; semitones: number }
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
  | { type: "set_track_eq"; track: number; bands: EqBand[]; bypass?: boolean }
  | { type: "set_master_gain"; gain_db: number }
  | { type: "set_tempo"; bpm: number }
  | { type: "move_track"; track: number; index: number }
  | { type: "set_track_color"; track: number; color: number | null }
  | { type: "set_track_category"; track: number; category: string | null }
  | { type: "batch"; commands: Command[]; label?: string };

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

/** Mirrors `dawg_core::player::Spectrum`: `db[i]` is at
 * `fromHz × (toHz / fromHz)^(i / (db.length − 1))`. */
export interface Spectrum {
  fromHz: number;
  toHz: number;
  db: number[];
}

/** Mirrors `commands::TabInfo` in the app crate: a tab in the title bar. */
export interface TabInfo {
  id: number;
  name: string;
  scratch: boolean;
  dirty: boolean;
  /** The audio file a scratch tab edits, or the project's file. */
  path: string | null;
}

/** Mirrors `commands::Front`: the tabs and the one in front, with its state. */
export interface Front {
  tabs: TabInfo[];
  active: number | null;
  state: SessionState | null;
  /** It was already open, so its tab came to the front instead. */
  existing: boolean;
}

/** Mirrors `autosave::Recovered` in the app crate. */
export interface RecoveryNote {
  /** Names it for `recover`. */
  key: string;
  name: string;
  project: string | null;
  /** ms since the Unix epoch. */
  savedAt: number;
}

/** Mirrors `recent::Recent` in the app crate. */
export interface RecentProject {
  path: string;
  name: string;
  exists: boolean;
}

/** The Browser's preview pane. */
export interface PreviewInfo {
  seconds: number;
  rate: number;
  channels: number;
  format: string;
  peakDb: number | null;
  peaks: number[];
}

export const api = {
  startupFile: () => invoke<string | null>("startup_file"),
  /** A WAV or MP3 as a scratch session, or a .dawg project, in a tab of its
   * own (or the tab it's already open in). */
  openFile: (path: string) => invoke<Front>("open_file", { path }),
  /** An empty project in a new tab. */
  newProject: () => invoke<Front>("new_project"),
  tabs: () => invoke<Front>("tabs"),
  /** Brings a tab to the front; playback stops. */
  switchTab: (id: number) => invoke<Front>("switch_tab", { id }),
  /** Closes a tab, unsaved edits and all. */
  closeTab: (id: number) => invoke<Front>("close_tab", { id }),
  moveTab: (id: number, index: number) => invoke<Front>("move_tab", { id, index }),
  /** Saves as a project at `path`, or where it was last saved. */
  saveProject: (path: string | null) => invoke<SessionState>("save_project", { path }),
  relinkSource: (source: number, path: string) =>
    invoke<{ state: SessionState; relinked: number }>("relink_source", { source, path }),
  recentProjects: () => invoke<RecentProject[]>("recent_projects"),
  forgetRecentProject: (path: string) => invoke<void>("forget_recent_project", { path }),
  sessionState: () => invoke<SessionState | null>("session_state"),
  apply: (command: Command, transient: boolean) =>
    invoke<SessionState>("apply", { command, transient }),
  endGesture: () => invoke<SessionState>("end_gesture"),
  /** A folder's subfolders and audio files, by name. */
  listDir: (path: string) => invoke<{ dirs: string[]; files: string[] }>("list_dir", { path }),
  /** Audio files under `roots` whose names hold every word of `query`. */
  searchFiles: (roots: string[], query: string) => invoke<string[]>("search_files", { roots, query }),
  previewInfo: (path: string, buckets: number) => invoke<PreviewInfo>("preview_info", { path, buckets }),
  /** Plays a file on its own from `from` seconds; the session stays put. */
  previewPlay: (path: string, from: number) => invoke<void>("preview_play", { path, from }),
  previewStop: () => invoke<void>("preview_stop"),
  previewStatus: () => invoke<{ playing: boolean; seconds: number }>("preview_status"),
  /** The installed dawg-cli, if it's next to the app. */
  cliPath: () => invoke<string | null>("cli_path"),
  /** What an agent's `get_selection` sees: clip ids and the ruler range. */
  setSelection: (clips: number[], range: [number, number] | null) =>
    invoke<void>("set_selection", { clips, range }),
  undo: () => invoke<SessionState>("undo"),
  redo: () => invoke<SessionState>("redo"),
  /** Undoes or redoes until `done` edits of the history are applied. */
  jumpHistory: (done: number) => invoke<SessionState>("jump_history", { done }),
  importFiles: (paths: string[], at: Placement) =>
    invoke<{ state: SessionState; imported: Imported }>("import_files", { paths, at }),
  /** `buckets` (min, max) pairs over frames `from..to` of a tab's source. */
  peaks: async (tab: number | null, source: number, from: number, to: number, buckets: number) =>
    new Float32Array(await invoke<ArrayBuffer>("peaks", { tab, source, from, to, buckets })),
  /** Plays `from..to`; with `looping`, jumps back there at `to` until stopped. */
  play: (from: number, to: number, looping: number | null) => invoke<void>("play", { from, to, looping }),
  /** Moves where the playback in progress stops or loops back, without seeking
   * (it jumps to `looping` only if the playhead is outside the loop). */
  setBounds: (to: number, looping: number | null) => invoke<void>("set_bounds", { to, looping }),
  stop: () => invoke<void>("stop"),
  transport: () =>
    invoke<{ playing: boolean; position: number; levels: [number, number][]; master: [number, number] }>("transport"),
  /** A track's spectrum after its EQ, from what played since the last call
   * (null when nothing did); `null` stops listening. */
  spectrum: (track: number | null) => invoke<Spectrum | null>("spectrum", { track }),
  savePreview: () => invoke<SavePreview>("save_preview"),
  replaceOriginal: () =>
    invoke<{ state: SessionState; backup: string }>("replace_original"),
  saveAs: (path: string, options: ExportOptions | null = null) => invoke<void>("save_as", { path, options }),
  /** Loudest peak of the mixdown over `range` (or every clip heard), dBFS. */
  mixPeak: (range: [number, number] | null) => invoke<number | null>("mix_peak", { range }),
  lastReplace: () => invoke<Replaced | null>("last_replace"),
  restoreLastReplace: () => invoke<SessionState | null>("restore_last_replace"),
  /** Snapshots unsaved edits for crash recovery (clears it when saved). */
  autosave: () => invoke<void>("autosave"),
  clearAutosave: () => invoke<void>("clear_autosave"),
  /** What earlier runs left unsaved. */
  recovery: () => invoke<RecoveryNote[]>("recovery"),
  /** Opens those, each in a tab of its own. */
  recover: (keys: string[]) => invoke<Front>("recover", { keys }),
  discardRecovery: () => invoke<void>("discard_recovery"),
  /** Shows the file in Explorer. */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
};
