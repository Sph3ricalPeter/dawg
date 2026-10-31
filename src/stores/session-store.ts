import { create } from "zustand";
import {
  api,
  apiMessage,
  type ClipState,
  type Command,
  type Placement,
  type SessionState,
  type TrackState,
} from "@/lib/api";
import { clamp, srcAt } from "@/lib/format";
import { SNAPS, snapFrames, type Snap, type Units } from "@/lib/grid";

const SNAP_VALUES = SNAPS.map((s) => s.v);

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a convenience.
  }
}

/** The units and snap in effect: a scratch session counts in time, with its
 * own snap. */
export function gridOf(s: { session: SessionState | null; units: Units; snap: Snap; snapScratch: Snap }): { units: Units; snap: Snap } {
  const scratch = !!s.session?.scratch;
  return { units: scratch ? "time" : s.units, snap: scratch ? s.snapScratch : s.snap };
}

/** Frames between snap points at the current zoom, or null with snap off. */
export function snapStep(): number | null {
  const s = useSession.getState();
  if (!s.session) return null;
  const g = gridOf(s);
  return snapFrames(g.snap, g.units, s.session.rate, s.session.bpm, s.view.fpp);
}

/** Visible window onto the timeline. */
export interface View {
  /** Timeline frame at the left edge (may be fractional). */
  start: number;
  /** Frames per pixel. */
  fpp: number;
}

/** A time range on the timeline, `a < b`, in frames. */
export interface Range {
  a: number;
  b: number;
}

export interface Toast {
  id: number;
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void };
}

export type Dialog =
  | {
      type: "discard";
      /** What happens after the user agrees to lose their edits. */
      then: () => void;
      verb: string;
    }
  | null;

/** What a drag in progress shows before the engine has it. */
export type Draft =
  /** A clip as it is being moved, trimmed or reshaped; `track` is where it
   * sits now. `ghost` shows the source audio the clip leaves out. */
  | { kind: "clip"; track: number; clip: ClipState; ghost?: boolean }
  /** Several clips being moved together. */
  | { kind: "clips"; items: { track: number; clip: ClipState }[] }
  | { kind: "track"; track: TrackState }
  /** The master volume, in dB. */
  | { kind: "master"; db: number }
  | { kind: "tempo"; bpm: number };

interface SessionStore {
  session: SessionState | null;
  draft: Draft | null;
  /** Selected clip ids. */
  selected: number[];
  view: View;
  /** Lane width in CSS pixels. */
  width: number;
  playhead: number;
  /** Where Stop returns to. */
  startPoint: number;
  playing: boolean;
  range: Range | null;
  /** Playback loops: the range if there is one, else 0 to the last clip's
   * end (L toggles). */
  loop: boolean;
  /** The playhead is being dragged on the ruler. */
  scrubbing: boolean;
  /** Envelope lines take clicks (E toggles). */
  envEdit: boolean;
  toast: Toast | null;
  dialog: Dialog;
  /** A file is loading or saving. */
  busy: string | null;
  /** Bumped whenever the session's audio is (re)loaded from disk. */
  fileRev: number;
  /** The track whose EQ is open under the playlist. */
  eqTrack: number | null;
  openEq: (track: number | null) => void;
  /** The clip settings popover: which clip, at a window point. */
  clipPanel: { clip: number; x: number; y: number } | null;
  openClipPanel: (clip: number, x: number, y: number) => void;
  closeClipPanel: () => void;

  /** Opens a WAV or MP3 as a scratch session, or a .dawg project. True
   * when it did. */
  open: (path: string) => Promise<boolean>;
  /** Starts an empty, untitled project. */
  newProject: () => Promise<void>;
  /** Opens what an earlier run left unsaved. */
  recover: () => Promise<void>;
  /** Adds files to the open session. */
  importFiles: (paths: string[], at: Placement) => Promise<void>;
  /** Ask first if there are unsaved edits. */
  guard: (verb: string, then: () => void) => void;
  setWidth: (w: number) => void;
  fit: () => void;
  zoomAt: (px: number, factor: number) => void;
  scrollTo: (start: number) => void;
  /** A drag step: shown at once, sent to the engine as a transient edit. */
  drag: (cmd: Command, draft: Draft) => void;
  /** A drag step shown at once but sent to the engine only when it ends:
   * for edits the engine takes a moment over (stretch, pitch). */
  sketch: (cmd: Command, draft: Draft) => void;
  /** Ends a drag with its last command as one undo step. */
  commit: () => Promise<void>;
  apply: (cmd: Command) => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Undoes or redoes until `done` edits of the history are applied. */
  jumpHistory: (done: number) => Promise<void>;
  historyOpen: boolean;
  /** The Export dialog for a mixdown. */
  exportOpen: boolean;
  /** Ruler and LCD units in a project (a scratch session shows time). */
  units: Units;
  /** Snap in a project, and in a scratch session. */
  snap: Snap;
  snapScratch: Snap;
  setUnits: (u: Units) => void;
  setSnap: (s: Snap) => void;
  toggleHistory: (open?: boolean) => void;
  select: (clip: number | null, toggle?: boolean) => void;
  selectAll: () => void;
  setSelected: (ids: number[]) => void;
  deleteClips: (ids: number[]) => Promise<void>;
  duplicateSelected: () => Promise<void>;
  splitAtPlayhead: () => Promise<void>;
  addTrack: () => Promise<void>;
  setPlayhead: (frame: number) => void;
  /** Moves the playhead while scrubbing, without touching playback. */
  scrub: (frame: number | null) => void;
  setRange: (r: Range | null) => void;
  /** A range made on the ruler: looping turns on and the playhead moves
   * into it, as in the mockup. */
  rangeLoop: () => void;
  toggleLoop: () => void;
  /** Restarts playback from the playhead when what it plays changed. */
  replay: () => Promise<void>;
  cropToRange: () => Promise<void>;
  toggleEnvEdit: () => void;
  togglePlay: () => Promise<void>;
  stop: () => Promise<void>;
  /** Called while playing to follow the engine. */
  poll: () => Promise<void>;
  /** Each track's meter level (linear peak, left and right, with fall-off),
   * in track order; empty while stopped. */
  levels: [number, number][];
  /** The master output's level, and its loudest peak since playback began. */
  master: [number, number];
  masterPeak: number;
  resetMasterPeak: () => void;
  showToast: (text: string, opts?: { error?: boolean; action?: Toast["action"] }) => void;
  hideToast: () => void;
  setDialog: (d: Dialog) => void;
  adopt: (s: SessionState | null) => void;
  /** The session's file was rewritten (Replace, Restore). */
  reloaded: (s: SessionState | null) => void;
  /** A session opened elsewhere (by an agent): shown as if just opened. */
  opened: (s: SessionState) => void;
}

/** Edits go to Rust one at a time and in order; a drag only sends its
 * latest step. */
let chain: Promise<unknown> = Promise.resolve();
export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job);
  chain = p.catch(() => undefined);
  return p;
}
/** The newest drag step not yet sent, and the last one of the drag. */
let pending: Command | null = null;
let lastDrag: Command | null = null;
let toastSeq = 0;
/** Meter fall-off per transport poll (about 30 ms). */
const METER_FALL = 0.75;

/** Shortest clip a trim can leave, in frames (`dawg_core::command::MIN_CLIP`). */
export const MIN_LEN = 16;

/** What playback covers: up to `to`, then back to `loopFrom` (or stop when
 * that's null). Null when there is nothing to play. */
function bounds(st: { session: SessionState | null; range: Range | null; loop: boolean }): {
  to: number;
  loopFrom: number | null;
} | null {
  const s = st.session;
  if (!s) return null;
  if (st.range && st.loop) return { to: Math.round(st.range.b), loopFrom: Math.round(st.range.a) };
  const end = songEnd(s);
  if (end <= 0) return null;
  return { to: end, loopFrom: st.loop ? 0 : null };
}

/** Every clip of the session, with its track. */
export function allClips(s: SessionState): { track: TrackState; clip: ClipState }[] {
  return s.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));
}

export function findClip(s: SessionState, id: number): { track: TrackState; clip: ClipState } | null {
  return allClips(s).find((c) => c.clip.id === id) ?? null;
}

/** End of the last clip, muted or not: where playback loops back. */
export function songEnd(s: SessionState): number {
  let end = 0;
  for (const { clip } of allClips(s)) end = Math.max(end, clip.start + clip.len);
  return end;
}

/** How far right the timeline goes, in seconds: far enough to feel endless. */
export const TIMELINE_SECONDS = 24 * 3600;

/** Last frame the view, playhead and range can reach. */
export function timelineLimit(s: SessionState): number {
  return Math.max(timelineEnd(s) * 1.5, TIMELINE_SECONDS * s.rate);
}

/** How much the scrollbar spans: the clips with room after them, and always
 * more past what's shown, so scrolling right never runs out. */
export function scrollSpan(s: SessionState, view: View, width: number): number {
  const shown = width * view.fpp;
  return Math.min(timelineLimit(s), Math.max(timelineEnd(s) * 1.5, view.start + shown * 2));
}

/** End of the last clip, muted or not, or of the original file. */
export function timelineEnd(s: SessionState): number {
  let end = s.frames;
  for (const { clip } of allClips(s)) end = Math.max(end, clip.start + clip.len);
  return end;
}

/** The tracks as they should be drawn right now, with any drag applied. */
export function shownTracks(s: SessionState, draft: Draft | null): TrackState[] {
  if (!draft || draft.kind === "master" || draft.kind === "tempo") return s.tracks;
  if (draft.kind === "track") {
    return s.tracks.map((t) => (t.id === draft.track.id ? { ...draft.track, clips: t.clips } : t));
  }
  const items = draft.kind === "clip" ? [{ track: draft.track, clip: draft.clip }] : draft.items;
  const ids = new Set(items.map((it) => it.clip.id));
  return s.tracks.map((t) => {
    const mine = items.filter((it) => it.track === t.id).map((it) => it.clip);
    if (!mine.length && !t.clips.some((c) => ids.has(c.id))) return t;
    return { ...t, clips: [...t.clips.filter((c) => !ids.has(c.id)), ...mine] };
  });
}

export const useSession = create<SessionStore>((set, get) => ({
  session: null,
  draft: null,
  selected: [],
  view: { start: 0, fpp: 100 },
  width: 800,
  playhead: 0,
  startPoint: 0,
  playing: false,
  levels: [],
  master: [0, 0],
  masterPeak: 0,
  resetMasterPeak: () => set({ masterPeak: 0 }),
  range: null,
  loop: true,
  scrubbing: false,
  envEdit: true,
  toast: null,
  dialog: null,
  busy: null,
  fileRev: 0,
  eqTrack: null,
  openEq: (track) => set({ eqTrack: track }),
  clipPanel: null,
  openClipPanel: (clip, x, y) => {
    const sel = get().selected;
    if (!sel.includes(clip)) set({ selected: [clip] });
    set({ clipPanel: { clip, x, y } });
  },
  closeClipPanel: () => set({ clipPanel: null }),

  open: async (path) => {
    await get().stop();
    set({ busy: "Opening…" });
    try {
      start(await enqueue(() => api.openFile(path)));
      return true;
    } catch (e) {
      get().showToast(`Couldn't open ${path}: ${apiMessage(e)}`, { error: true });
      return false;
    } finally {
      set({ busy: null });
    }
  },

  recover: async () => {
    await get().stop();
    try {
      start(await enqueue(() => api.recover()));
    } catch (e) {
      get().showToast(`Couldn't recover: ${apiMessage(e)}`, { error: true });
    }
  },

  newProject: async () => {
    await get().stop();
    try {
      start(await enqueue(() => api.newProject()));
    } catch (e) {
      get().showToast(`Couldn't start a project: ${apiMessage(e)}`, { error: true });
    }
  },

  importFiles: async (paths, at) => {
    if (!get().session || !paths.length) return;
    set({ busy: paths.length > 1 ? `Adding ${paths.length} files…` : "Adding…" });
    try {
      const r = await enqueue(() => api.importFiles(paths, at));
      const grew = timelineEnd(r.state) > timelineEnd(get().session!);
      set({ session: r.state, draft: null, selected: r.imported.clips });
      if (grew) get().fit();
      const failed = r.imported.failed;
      if (failed.length) {
        const name = (p: string) => p.split(/[\\/]/).pop();
        const list = failed.map(([p, why]) => `${name(p)} (${why})`).join(", ");
        get().showToast(`Couldn't add ${list}`, { error: true });
      }
    } catch (e) {
      get().showToast(`Couldn't add files: ${apiMessage(e)}`, { error: true });
    } finally {
      set({ busy: null });
    }
  },

  guard: (verb, then) => {
    if (get().session?.dirty) set({ dialog: { type: "discard", verb, then } });
    else then();
  },

  setWidth: (w) => {
    const first = get().width === 800 && w !== 800;
    set({ width: Math.max(50, w) });
    if (first) get().fit();
  },

  fit: () => {
    const { session, width } = get();
    if (!session) return;
    // A little room after the end so the last clip's edge is easy to grab.
    const fpp = Math.max(1 / 16, (Math.max(timelineEnd(session), session.rate) * 1.03) / width);
    set({ view: { start: 0, fpp } });
  },

  zoomAt: (px, factor) => {
    const { view, session, width } = get();
    if (!session) return;
    // Zoom out to the whole song, or ten minutes when that's longer.
    const maxFpp = Math.max(timelineEnd(session) * 2, session.rate * 600) / width;
    const fpp = clamp(view.fpp * factor, 1 / 16, Math.max(maxFpp, 1));
    const anchor = view.start + px * view.fpp;
    set({ view: { fpp, start: 0 } });
    get().scrollTo(anchor - px * fpp);
  },

  scrollTo: (start) => {
    const { view, session, width } = get();
    if (!session) return;
    const max = Math.max(0, timelineLimit(session) - width * view.fpp);
    set({ view: { ...view, start: clamp(start, 0, max) } });
  },

  drag: (cmd, draft) => {
    if (!get().session) return;
    set({ draft });
    lastDrag = cmd;
    const fresh = pending === null;
    pending = cmd;
    if (!fresh) return;
    void enqueue(async () => {
      const c = pending;
      pending = null;
      if (c) await api.apply(c, true);
    }).catch(() => undefined);
  },

  sketch: (cmd, draft) => {
    if (!get().session) return;
    set({ draft });
    lastDrag = cmd;
  },

  commit: async () => {
    const cmd = lastDrag;
    lastDrag = null;
    pending = null;
    if (!cmd) {
      set({ draft: null });
      return;
    }
    try {
      const s = await enqueue(() => api.apply(cmd, false));
      get().adopt(s);
    } catch (e) {
      set({ draft: null });
      get().showToast(apiMessage(e), { error: true });
      get().adopt(await api.sessionState());
    }
  },

  apply: async (cmd) => {
    try {
      const s = await enqueue(() => api.apply(cmd, false));
      get().adopt(s);
      return true;
    } catch (e) {
      get().showToast(apiMessage(e), { error: true });
      return false;
    }
  },

  undo: async () => {
    if (!get().session?.canUndo) return;
    get().adopt(await enqueue(() => api.undo()));
  },

  redo: async () => {
    if (!get().session?.canRedo) return;
    get().adopt(await enqueue(() => api.redo()));
  },

  jumpHistory: async (done) => {
    get().adopt(await enqueue(() => api.jumpHistory(done)));
  },

  historyOpen: false,
  exportOpen: false,
  units: remembered<Units>("dawg.units", ["bars", "time"], "bars"),
  snap: remembered<Snap>("dawg.snap", SNAP_VALUES, "line"),
  snapScratch: remembered<Snap>("dawg.snapScratch", SNAP_VALUES, "off"),
  setUnits: (units) => {
    remember("dawg.units", units);
    set({ units });
  },
  setSnap: (snap) => {
    if (get().session?.scratch) {
      remember("dawg.snapScratch", snap);
      set({ snapScratch: snap });
    } else {
      remember("dawg.snap", snap);
      set({ snap });
    }
  },
  toggleHistory: (open) => set((s) => ({ historyOpen: open ?? !s.historyOpen })),

  select: (clip, toggle = false) => {
    if (clip === null) {
      if (!toggle) set({ selected: [] });
      return;
    }
    const sel = get().selected;
    if (toggle) {
      set({ selected: sel.includes(clip) ? sel.filter((c) => c !== clip) : [...sel, clip] });
    } else if (!sel.includes(clip) || sel.length > 1) {
      set({ selected: [clip] });
    }
  },

  setSelected: (ids) => set({ selected: ids }),

  selectAll: () => {
    const s = get().session;
    if (s) set({ selected: allClips(s).map((c) => c.clip.id) });
  },

  deleteClips: async (ids) => {
    if (!ids.length) return;
    const ok = await get().apply({
      type: "batch",
      commands: ids.map((clip) => ({ type: "delete_clip" as const, clip })),
    });
    if (ok) {
      get().showToast(ids.length > 1 ? `Deleted ${ids.length} clips` : "Deleted the clip", {
        action: { label: "Undo", run: () => void get().undo() },
      });
    }
  },

  duplicateSelected: async () => {
    const ids = get().selected;
    if (!ids.length) {
      get().showToast("Select a clip to duplicate");
      return;
    }
    const before = new Set(allClips(get().session!).map((c) => c.clip.id));
    const ok = await get().apply({
      type: "batch",
      commands: ids.map((clip) => ({ type: "duplicate_clip" as const, clip })),
    });
    const s = get().session;
    if (ok && s) set({ selected: allClips(s).map((c) => c.clip.id).filter((id) => !before.has(id)) });
  },

  splitAtPlayhead: async () => {
    const { session, selected, playhead } = get();
    if (!session) return;
    // The selected clips under the playhead, or every clip there if none is.
    const under = allClips(session)
      .map((c) => c.clip)
      .filter((c) => playhead > c.start + MIN_LEN && playhead < c.start + c.len - MIN_LEN);
    const picked = under.filter((c) => selected.includes(c.id));
    const cut = picked.length ? picked : under;
    if (!cut.length) {
      get().showToast("Put the playhead inside a clip to split it");
      return;
    }
    await get().apply({
      type: "batch",
      commands: cut.map((c) => ({ type: "split_clip" as const, clip: c.id, at: Math.round(playhead) })),
    });
  },

  addTrack: async () => {
    const s = get().session;
    if (!s) return;
    await get().apply({ type: "add_track", name: `Track ${s.tracks.length + 1}` });
  },

  setPlayhead: (frame) => {
    const { session, playing } = get();
    if (!session) return;
    const f = Math.round(clamp(frame, 0, timelineLimit(session)));
    set({ playhead: f, startPoint: f, scrubbing: false });
    if (playing) void get().replay();
  },

  scrub: (frame) => {
    const { session } = get();
    if (!session || frame === null) {
      set({ scrubbing: false });
      return;
    }
    set({ scrubbing: true, playhead: Math.round(clamp(frame, 0, timelineLimit(session))) });
  },

  setRange: (r) => {
    const had = get().range;
    set({ range: r && r.b - r.a >= 1 ? r : null });
    if (get().playing && (had !== null || get().range !== null)) void get().replay();
  },

  rangeLoop: () => {
    const { range, playhead } = get();
    if (!range) return;
    set({ loop: true });
    if (playhead < range.a || playhead >= range.b) {
      const a = Math.round(range.a);
      set({ playhead: a, startPoint: a });
    }
    if (get().playing) void get().replay();
  },

  toggleLoop: () => {
    set({ loop: !get().loop });
    if (get().playing) void get().replay();
  },

  replay: async () => {
    if (!get().playing) return;
    const b = bounds(get());
    if (!b) {
      await get().stop();
      return;
    }
    let from = get().playhead;
    if (from >= b.to || (b.loopFrom !== null && from < b.loopFrom)) from = b.loopFrom ?? 0;
    await api.play(from, b.to, b.loopFrom).catch(() => undefined);
    set({ playhead: from });
  },

  cropToRange: async () => {
    const { session, range, selected } = get();
    if (!session) return;
    if (!range) {
      get().showToast("Ctrl+drag on the ruler to make a range first, then crop");
      return;
    }
    const a = Math.round(range.a);
    const b = Math.round(range.b);
    // The selected clips, or every clip; each keeps only what's in the range.
    const clips = allClips(session).map((c) => c.clip);
    const picked = clips.filter((c) => selected.includes(c.id));
    const commands: Command[] = [];
    for (const c of picked.length ? picked : clips) {
      const s = Math.max(a, c.start);
      const e = Math.min(b, c.start + c.len);
      if (e - s < MIN_LEN) {
        commands.push({ type: "delete_clip", clip: c.id });
      } else if (s !== c.start || e !== c.start + c.len) {
        commands.push({ type: "trim_clip", clip: c.id, start: s, offset: srcAt(c, s - c.start), len: e - s });
      }
    }
    if (commands.every((c) => c.type === "delete_clip")) {
      get().showToast("The range doesn't overlap any clip");
      return;
    }
    if (await get().apply({ type: "batch", commands, label: "Crop to range" })) set({ range: null, playhead: a, startPoint: a });
  },

  toggleEnvEdit: () => {
    const on = !get().envEdit;
    set({ envEdit: on });
    get().showToast(on ? "Envelope editing on" : "Envelope editing off (E turns it back on)");
  },

  togglePlay: async () => {
    const { session, playing, startPoint } = get();
    if (!session) return;
    if (playing) {
      await get().stop();
      return;
    }
    const b = bounds(get());
    if (!b) {
      get().showToast("There's nothing to play yet");
      return;
    }
    // From where the playhead was put, or the loop's start if that's
    // outside what plays.
    let from = startPoint;
    if (from >= b.to || (b.loopFrom !== null && from < b.loopFrom)) from = b.loopFrom ?? 0;
    try {
      await api.play(from, b.to, b.loopFrom);
      set({ playing: true, playhead: from, startPoint: from, masterPeak: 0 });
    } catch (e) {
      get().showToast(`Can't play: ${apiMessage(e)}`, { error: true });
    }
  },

  stop: async () => {
    if (!get().playing) return;
    await api.stop().catch(() => undefined);
    // Stop returns to where playback started (UX spec, Space).
    set({ playing: false, playhead: get().startPoint, levels: [] });
  },

  poll: async () => {
    if (!get().playing) return;
    const t = await api.transport();
    if (!get().playing) return;
    if (!t.playing) {
      set({ playing: false, playhead: get().startPoint, levels: [], master: [0, 0] });
      return;
    }
    // Peaks since the last poll, falling back gently between them.
    const old = get().levels;
    const levels = t.levels.map(([l, r], i): [number, number] => [
      Math.max(l, (old[i]?.[0] ?? 0) * METER_FALL),
      Math.max(r, (old[i]?.[1] ?? 0) * METER_FALL),
    ]);
    const m = get().master;
    const master: [number, number] = [Math.max(t.master[0], m[0] * METER_FALL), Math.max(t.master[1], m[1] * METER_FALL)];
    const masterPeak = Math.max(get().masterPeak, t.master[0], t.master[1]);
    set(get().scrubbing ? { levels, master, masterPeak } : { playhead: t.position, levels, master, masterPeak });
  },

  showToast: (text, opts) => {
    const id = ++toastSeq;
    set({ toast: { id, text, ...opts } });
    window.setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, opts?.error ? 8000 : opts?.action ? 7000 : 3500);
  },

  hideToast: () => set({ toast: null }),

  setDialog: (d) => set({ dialog: d }),

  adopt: (s) => {
    const ids = new Set(s ? allClips(s).map((c) => c.clip.id) : []);
    const before = get().session;
    set({ session: s, draft: null, selected: get().selected.filter((id) => ids.has(id)) });
    // The loop follows the last clip's end.
    if (s && before && songEnd(s) !== songEnd(before)) void get().replay();
  },

  opened: (s) => start(s),

  reloaded: (s) => {
    set({
      session: s,
      draft: null,
      range: null,
      selected: s?.simple ? allClips(s).map((c) => c.clip.id) : get().selected,
      fileRev: get().fileRev + 1,
    });
    if (s?.simple) {
      set({ playhead: 0, startPoint: 0 });
      get().fit();
    }
    get().adopt(s);
  },
}));

/** A session just opened or started: a scratch file comes up selected, a
 * project as it was left. */
function start(s: SessionState) {
  useSession.setState({
    session: s,
    draft: null,
    range: null,
    selected: s.scratch ? allClips(s).map((c) => c.clip.id) : [],
    playhead: 0,
    startPoint: 0,
    fileRev: useSession.getState().fileRev + 1,
  });
  useSession.getState().fit();
}

/** The tracks as they should be drawn right now. */
export function useTracks(): TrackState[] {
  const session = useSession((s) => s.session);
  const draft = useSession((s) => s.draft);
  return session ? shownTracks(session, draft) : [];
}
