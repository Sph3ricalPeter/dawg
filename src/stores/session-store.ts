import { create } from "zustand";
import {
  api,
  apiMessage,
  type ClipState,
  type Command,
  type Front,
  type TabInfo,
  type Placement,
  type SessionState,
  type TrackState,
} from "@/lib/api";
import { clamp, shiftEnvelope, srcAt } from "@/lib/format";
import { Clock } from "@/lib/frame-loop";
import { SNAPS, snapFrames, type Snap, type Units } from "@/lib/grid";
import { choice, setSetting, setting } from "@/lib/settings";
import { follow, recall, touched, tracksScroll, UNTITLED, viewKey, type SavedView } from "@/lib/view-memory";
import { categoryById, categoryOfLabels } from "@/lib/categories";
import { useLibrary } from "@/stores/library-store";

const SNAP_VALUES = SNAPS.map((s) => s.v);


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
  /** Closing the window with several tabs unsaved. */
  | { type: "quit"; tabs: TabInfo[] }
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
  /** Open sessions, in tab order. The front one's name and dirty mark come
   * from `session`; the others' as they were when it was last in front. */
  tabs: TabInfo[];
  /** The tab in front, whose session is `session`. */
  activeTab: number | null;
  /** Brings a tab to the front, as it was left; playback stops. */
  switchTab: (id: number) => Promise<void>;
  /** Closes a tab, asking first about unsaved edits. */
  closeTab: (id: number) => Promise<void>;
  /** Closes a tab without asking. */
  dropTab: (id: number) => Promise<void>;
  moveTab: (id: number, index: number) => Promise<void>;
  /** Catches up with tabs opened elsewhere (by an agent). */
  syncTabs: () => Promise<void>;
  session: SessionState | null;
  draft: Draft | null;
  /** Selected clip ids. */
  selected: number[];
  view: View;
  /** Lane width in CSS pixels. */
  width: number;
  /** Track heights the user set, by track id; the rest use the default. */
  heights: Record<number, number>;
  setHeights: (h: Record<number, number> | ((h: Record<number, number>) => Record<number, number>)) => void;
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
  /** Opens what earlier runs left unsaved, each in a tab. */
  recover: (keys: string[]) => Promise<void>;
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
  /** Restarts playback from the playhead, after the playhead moved. */
  replay: () => Promise<void>;
  /** Moves the loop or end of the playback in progress without restarting
   * it, after the range, loop or song end changed. */
  retarget: () => Promise<void>;
  cropToRange: () => Promise<void>;
  toggleEnvEdit: () => void;
  togglePlay: () => Promise<void>;
  stop: () => Promise<void>;
  /** Called while playing to follow the engine. */
  poll: () => Promise<void>;
  /** Each track's meter level (linear peak, left and right, since the last poll),
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

/** Shortest clip a trim can leave, in frames (`dawg_core::command::MIN_CLIP`). */
export const MIN_LEN = 16;

/** Shortest range that loops, in seconds. A shorter one (the first moments
 * of a Ctrl+drag) would only buzz, so playback ignores it. */
const MIN_LOOP_SECONDS = 0.05;

/** What playback covers: up to `to`, then back to `loopFrom` (or stop when
 * that's null). Null when there is nothing to play. */
function bounds(st: { session: SessionState | null; range: Range | null; loop: boolean }): {
  to: number;
  loopFrom: number | null;
} | null {
  const s = st.session;
  if (!s) return null;
  const minLoop = MIN_LOOP_SECONDS * s.format.sampleRate;
  if (st.range && st.loop && st.range.b - st.range.a >= minLoop) return { to: Math.round(st.range.b), loopFrom: Math.round(st.range.a) };
  const end = songEnd(s);
  if (end <= 0) return null;
  return { to: end, loopFrom: st.loop ? 0 : null };
}

/** The playhead as drawn while playing: it runs on between the engine's
 * reports at the session's rate and wraps at the loop, so it moves at the
 * display's refresh rate rather than the poll's. */
export const playClock = new Clock();
let clockBounds: { to: number; loopFrom: number | null } | null = null;
playClock.setWrap((p) => {
  const b = clockBounds;
  if (!b) return p;
  if (b.loopFrom !== null && p >= b.to && b.to > b.loopFrom) return b.loopFrom + ((p - b.loopFrom) % (b.to - b.loopFrom));
  return Math.min(p, b.to);
});

/** Restarts the drawn playhead from `from` with the current play bounds. */
function startClock(st: { session: SessionState | null; range: Range | null; loop: boolean }, from: number) {
  clockBounds = bounds(st);
  playClock.rate = st.session?.rate ?? 48_000;
  playClock.reset(from);
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
/** The zoom range in frames per pixel: a sample per 16 px in, out to the
 * whole song or ten minutes, whichever is longer. */
export function fppRange(session: SessionState, width: number): [number, number] {
  const maxFpp = Math.max(timelineEnd(session) * 2, session.rate * 600) / width;
  return [1 / 16, Math.max(maxFpp, 1)];
}

/** Where the view's start may go at `fpp`: 0 up to the timeline's end. */
export function maxStart(session: SessionState, width: number, fpp: number): number {
  return Math.max(0, timelineLimit(session) - width * fpp);
}

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
  tabs: [],
  activeTab: null,

  switchTab: async (id) => {
    if (id === get().activeTab || !get().tabs.some((t) => t.id === id)) return;
    await get().commit();
    await get().stop();
    try {
      show(await enqueue(() => api.switchTab(id)));
    } catch (e) {
      get().showToast(apiMessage(e), { error: true });
    }
  },

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const front = id === get().activeTab;
    const dirty = front ? !!get().session?.dirty : tab.dirty;
    if (!dirty) {
      await get().dropTab(id);
      return;
    }
    // Asks with the tab in front, so its name and edits are what's shown.
    if (!front) await get().switchTab(id);
    if (get().activeTab !== id) return;
    get().guard("close this tab", () => void get().dropTab(id));
  },

  dropTab: async (id) => {
    if (id === get().activeTab) {
      await get().commit();
      await get().stop();
    }
    try {
      const f = await enqueue(() => api.closeTab(id));
      memos.delete(id);
      show(f);
    } catch (e) {
      get().showToast(apiMessage(e), { error: true });
    }
  },

  moveTab: async (id, index) => {
    const tabs = get().tabs.filter((t) => t.id !== id);
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
    set({ tabs });
    try {
      const f = await enqueue(() => api.moveTab(id, index));
      set({ tabs: f.tabs });
    } catch {
      // The row is only cosmetic until the next change.
    }
  },

  syncTabs: async () => {
    const f = await enqueue(() => api.tabs());
    if (f.active !== get().activeTab) await get().stop();
    show(f);
  },

  session: null,
  draft: null,
  selected: [],
  view: { start: 0, fpp: 100 },
  width: 800,
  heights: {},
  setHeights: (h) => set({ heights: typeof h === "function" ? h(get().heights) : h }),
  playhead: 0,
  startPoint: 0,
  playing: false,
  levels: [],
  master: [0, 0],
  masterPeak: 0,
  resetMasterPeak: () => set({ masterPeak: 0 }),
  range: null,
  loop: setting<unknown>("loop", true) !== false,
  scrubbing: false,
  envEdit: setting<unknown>("envEdit", true) !== false,
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
    await get().commit();
    await get().stop();
    set({ busy: "Opening…" });
    try {
      const f = await enqueue(() => api.openFile(path));
      show(f);
      if (f.existing && f.state) get().showToast(`${f.state.name} is already open`);
      return true;
    } catch (e) {
      get().showToast(`Couldn't open ${path}: ${apiMessage(e)}`, { error: true });
      return false;
    } finally {
      set({ busy: null });
    }
  },

  recover: async (keys) => {
    await get().commit();
    await get().stop();
    try {
      show(await enqueue(() => api.recover(keys)), true);
    } catch (e) {
      get().showToast(`Couldn't recover: ${apiMessage(e)}`, { error: true });
    }
  },

  newProject: async () => {
    await get().commit();
    await get().stop();
    try {
      show(await enqueue(() => api.newProject()));
    } catch (e) {
      get().showToast(`Couldn't start a project: ${apiMessage(e)}`, { error: true });
    }
  },

  importFiles: async (paths, at) => {
    if (!get().session || !paths.length) return;
    set({ busy: paths.length > 1 ? `Adding ${paths.length} files…` : "Adding…" });
    try {
      // Each file's category from its Browser labels: a track without one
      // takes the first that lands on it.
      const lib = useLibrary.getState();
      const categories = paths.map((p) => categoryOfLabels(lib.labelsOf(p)));
      const before = new Map(get().session!.tracks.map((t) => [t.id, t]));
      const r = await enqueue(() => api.importFiles(paths, { ...at, categories }));
      const grew = timelineEnd(r.state) > timelineEnd(get().session!);
      set({ session: r.state, draft: null, selected: r.imported.clips });
      const sorted = r.state.tracks.filter((t) => t.category && !before.get(t.id)?.category);
      if (sorted.length === 1) {
        const t = sorted[0];
        // Clearing keeps the clip: the category goes, and the old name comes back.
        const name = before.get(t.id)?.name ?? `Track ${r.state.tracks.indexOf(t) + 1}`;
        get().showToast(`${name} is ${categoryById(t.category)?.name ?? t.category} now, from its file's label`, {
          action: {
            label: "Clear",
            run: () =>
              void get().apply({
                type: "batch",
                label: "Track category",
                commands: [
                  { type: "set_track_category", track: t.id, category: null },
                  ...(name !== t.name ? [{ type: "rename_track" as const, track: t.id, name }] : []),
                ],
              }),
          },
        });
      }
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
    // A file opened before the lanes were measured fits now, unless it came
    // back with the view it was left with.
    if (first && !restored) get().fit();
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
    const fpp = clamp(view.fpp * factor, ...fppRange(session, width));
    const anchor = view.start + px * view.fpp;
    set({ view: { fpp, start: 0 } });
    get().scrollTo(anchor - px * fpp);
  },

  scrollTo: (start) => {
    const { view, session, width } = get();
    if (!session) return;
    set({ view: { ...view, start: clamp(start, 0, maxStart(session, width, view.fpp)) } });
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

  historyOpen: setting<unknown>("historyOpen", false) === true,
  exportOpen: false,
  units: choice<Units>("units", ["bars", "time"], "bars"),
  snap: choice<Snap>("snap", SNAP_VALUES, "line"),
  snapScratch: choice<Snap>("snapScratch", SNAP_VALUES, "off"),
  setUnits: (units) => {
    setSetting("units", units);
    set({ units });
  },
  setSnap: (snap) => {
    if (get().session?.scratch) {
      setSetting("snapScratch", snap);
      set({ snapScratch: snap });
    } else {
      setSetting("snap", snap);
      set({ snap });
    }
  },
  toggleHistory: (open) => {
    const historyOpen = open ?? !get().historyOpen;
    setSetting("historyOpen", historyOpen);
    set({ historyOpen });
  },

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
    if (get().playing && (had !== null || get().range !== null)) void get().retarget();
  },

  rangeLoop: () => {
    const { range, playhead } = get();
    if (!range) return;
    set({ loop: true });
    setSetting("loop", true);
    if (playhead < range.a || playhead >= range.b) {
      const a = Math.round(range.a);
      set({ playhead: a, startPoint: a });
    }
    if (get().playing) void get().retarget();
  },

  toggleLoop: () => {
    set({ loop: !get().loop });
    setSetting("loop", get().loop);
    if (get().playing) void get().retarget();
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
    startClock(get(), from);
  },

  retarget: async () => {
    if (!get().playing) return;
    const b = bounds(get());
    if (!b) {
      await get().stop();
      return;
    }
    const at = get().playhead;
    const outside = at >= b.to || (b.loopFrom !== null && at < b.loopFrom);
    // Past the end with nothing to loop back to: start over, as before.
    if (outside && b.loopFrom === null) {
      await get().replay();
      return;
    }
    // Playback carries on where it is; seeking on every move of a dragged
    // range restarted the same few milliseconds over and over (a buzz).
    await api.setBounds(b.to, b.loopFrom).catch(() => undefined);
    clockBounds = b;
    if (outside && b.loopFrom !== null) {
      set({ playhead: b.loopFrom });
      startClock(get(), b.loopFrom);
    }
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
        const offset = srcAt(c, s - c.start);
        commands.push({ type: "trim_clip", clip: c.id, start: s, offset, len: e - s });
        // As with dragging the left edge, the envelope moves with the cut.
        if (offset !== c.offset && c.envelope.length) {
          const frames = session.sources.find((x) => x.id === c.source)?.frames ?? offset + e - s;
          commands.push({ type: "set_envelope", clip: c.id, points: shiftEnvelope(c.envelope, offset - c.offset, frames) });
        }
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
    setSetting("envEdit", on);
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
      startClock(get(), from);
    } catch (e) {
      get().showToast(`Can't play: ${apiMessage(e)}`, { error: true });
    }
  },

  stop: async () => {
    if (!get().playing) return;
    await api.stop().catch(() => undefined);
    // Stop returns to where playback started (UX spec, Space).
    playClock.stop();
    set({ playing: false, playhead: get().startPoint, levels: [], master: [0, 0] });
  },

  poll: async () => {
    if (!get().playing) return;
    const t = await api.transport();
    if (!get().playing) return;
    if (!t.playing) {
      playClock.stop();
      set({ playing: false, playhead: get().startPoint, levels: [], master: [0, 0] });
      return;
    }
    // Peaks since the last poll; the meters fall back between them as they
    // draw (see Meter and Master).
    const levels = t.levels;
    const master = t.master;
    const masterPeak = Math.max(get().masterPeak, t.master[0], t.master[1]);
    if (get().scrubbing) {
      set({ levels, master, masterPeak });
      return;
    }
    clockBounds = bounds(get());
    const b = clockBounds;
    playClock.report(t.position, b && b.loopFrom !== null ? b.to - b.loopFrom : null);
    set({ playhead: t.position, levels, master, masterPeak });
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
    if (s && before && songEnd(s) !== songEnd(before)) void get().retarget();
  },

  reloaded: (s) => {
    set({
      session: s,
      draft: null,
      range: null,
      selected: s?.simple ? allClips(s).map((c) => c.clip.id) : get().selected,
      fileRev: ++revSeq,
    });
    if (s?.simple) {
      set({ playhead: 0, startPoint: 0 });
      get().fit();
    }
    get().adopt(s);
  },
}));

/** Bumped for every (re)load of a tab's audio: with the tab id, it keys the
 * waveform cache, so a tab brought back to the front draws at once. */
let revSeq = 0;

/** What each tab in the back was left showing. */
interface Memo {
  view: View;
  playhead: number;
  range: Range | null;
  selected: number[];
  heights: Record<number, number>;
  scrollTop: number;
  eqTrack: number | null;
  fileRev: number;
}
const memos = new Map<number, Memo>();

/** Shows the tab in front after a tab change: as it was left if it has been
 * in front before, else as just opened. */
function show(f: Front, recovered = false) {
  const st = useSession.getState();
  if (st.activeTab !== null && st.session && f.active !== st.activeTab && f.tabs.some((t) => t.id === st.activeTab)) {
    memos.set(st.activeTab, {
      view: st.view,
      playhead: st.startPoint,
      range: st.range,
      selected: st.selected,
      heights: st.heights,
      scrollTop: tracksScroll.top,
      eqTrack: st.eqTrack,
      fileRev: st.fileRev,
    });
  }
  for (const id of memos.keys()) if (!f.tabs.some((t) => t.id === id)) memos.delete(id);
  const same = f.active === st.activeTab;
  useSession.setState({ tabs: f.tabs, activeTab: f.active, clipPanel: null });
  const s = f.state;
  if (!s) {
    follow(null, readView);
    useSession.setState({ session: null, draft: null, range: null, selected: [], playhead: 0, startPoint: 0, eqTrack: null });
    return;
  }
  // The same tab again (a file that was already open in front).
  if (same && !f.existing && st.session) {
    start(s, recovered);
    return;
  }
  if (same) {
    st.adopt(s);
    return;
  }
  const m = f.active !== null ? memos.get(f.active) : undefined;
  if (!m) {
    start(s, recovered);
    useSession.setState({ eqTrack: null });
    return;
  }
  memos.delete(f.active!);
  restored = true;
  tracksScroll.top = m.scrollTop;
  tracksScroll.pending = m.scrollTop;
  const ids = new Set(allClips(s).map((c) => c.clip.id));
  useSession.setState({
    session: s,
    draft: null,
    view: m.view,
    range: m.range,
    playhead: m.playhead,
    startPoint: m.playhead,
    selected: m.selected.filter((id) => ids.has(id)),
    heights: m.heights,
    eqTrack: m.eqTrack,
    fileRev: m.fileRev,
  });
}

/** Where the session's view is remembered (see `lib/view-memory`). */
function keyOf(s: SessionState | null): string | null {
  if (!s) return null;
  return viewKey(s.project ?? (s.scratch ? s.path : null)) ?? UNTITLED;
}

/** What `lib/view-memory` saves for the session shown now. */
function readView(): Omit<SavedView, "at"> {
  const st = useSession.getState();
  return {
    start: st.view.start,
    fpp: st.view.fpp,
    scrollTop: tracksScroll.top,
    playhead: st.startPoint,
    range: st.range,
    heights: st.heights,
  };
}

/** The open file came back with its saved view, so it isn't fitted. */
let restored = false;

/** A session just opened or started: a scratch file comes up selected, a
 * project as it was left, and either with the view it had last time
 * (an Untitled project's only when it's recovered). */
function start(s: SessionState, recovered = false) {
  const key = keyOf(s);
  // Saves what the last session had waiting before it goes.
  follow(key, readView);
  const v = key && (key !== UNTITLED || recovered) ? recall(key) : null;
  const st = useSession.getState();
  const limit = timelineLimit(s);
  const playhead = v ? Math.round(clamp(v.playhead, 0, limit)) : 0;
  const ids = new Set(s.tracks.map((t) => t.id));
  const heights: Record<number, number> = {};
  for (const [id, h] of Object.entries(v?.heights ?? {})) if (ids.has(Number(id))) heights[Number(id)] = h;
  restored = !!v;
  tracksScroll.top = v?.scrollTop ?? 0;
  tracksScroll.pending = tracksScroll.top;
  useSession.setState({
    session: s,
    draft: null,
    range: v?.range ? { a: clamp(v.range.a, 0, limit), b: clamp(v.range.b, 0, limit) } : null,
    selected: s.scratch ? allClips(s).map((c) => c.clip.id) : [],
    playhead,
    startPoint: playhead,
    heights,
    fileRev: ++revSeq,
  });
  if (v) {
    const fpp = clamp(v.fpp, ...fppRange(s, st.width));
    useSession.setState({ view: { fpp, start: clamp(v.start, 0, maxStart(s, st.width, fpp)) } });
  } else {
    useSession.getState().fit();
  }
}

// Remembers the view as it changes: zoom, scroll, the playhead where it was
// put, the range and track heights. A save after "Save as" moves to the
// project's own key.
useSession.subscribe((st, prev) => {
  if (!st.session) return;
  if (st.session !== prev.session) follow(keyOf(st.session), readView);
  if (
    st.view !== prev.view ||
    st.startPoint !== prev.startPoint ||
    st.range !== prev.range ||
    st.heights !== prev.heights ||
    st.session.project !== prev.session?.project
  ) {
    touched();
  }
});

/** The tracks as they should be drawn right now. */
export function useTracks(): TrackState[] {
  const session = useSession((s) => s.session);
  const draft = useSession((s) => s.draft);
  return session ? shownTracks(session, draft) : [];
}
