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
import { clamp } from "@/lib/format";

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
  | { kind: "track"; track: TrackState };

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
  /** Envelope lines take clicks (E toggles). */
  envEdit: boolean;
  toast: Toast | null;
  dialog: Dialog;
  /** A file is loading or saving. */
  busy: string | null;
  /** Bumped whenever the session's audio is (re)loaded from disk. */
  fileRev: number;

  open: (path: string) => Promise<void>;
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
  /** Ends a drag with its last command as one undo step. */
  commit: () => Promise<void>;
  apply: (cmd: Command) => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  select: (clip: number | null, toggle?: boolean) => void;
  selectAll: () => void;
  deleteClips: (ids: number[]) => Promise<void>;
  duplicateSelected: () => Promise<void>;
  splitAtPlayhead: () => Promise<void>;
  addTrack: () => Promise<void>;
  setPlayhead: (frame: number) => void;
  setRange: (r: Range | null) => void;
  cropToRange: () => Promise<void>;
  toggleEnvEdit: () => void;
  togglePlay: () => Promise<void>;
  stop: () => Promise<void>;
  /** Called while playing to follow the engine. */
  poll: () => Promise<void>;
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
function enqueue<T>(job: () => Promise<T>): Promise<T> {
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

/** Every clip of the session, with its track. */
export function allClips(s: SessionState): { track: TrackState; clip: ClipState }[] {
  return s.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));
}

export function findClip(s: SessionState, id: number): { track: TrackState; clip: ClipState } | null {
  return allClips(s).find((c) => c.clip.id === id) ?? null;
}

/** End of the last clip, muted or not, or of the original file. */
export function timelineEnd(s: SessionState): number {
  let end = s.frames;
  for (const { clip } of allClips(s)) end = Math.max(end, clip.start + clip.len);
  return end;
}

/** The tracks as they should be drawn right now, with any drag applied. */
export function shownTracks(s: SessionState, draft: Draft | null): TrackState[] {
  if (!draft) return s.tracks;
  if (draft.kind === "track") {
    return s.tracks.map((t) => (t.id === draft.track.id ? { ...draft.track, clips: t.clips } : t));
  }
  const id = draft.clip.id;
  return s.tracks.map((t) => {
    const clips = t.clips.filter((c) => c.id !== id);
    if (t.id === draft.track) clips.push(draft.clip);
    return clips.length === t.clips.length && t.id !== draft.track ? t : { ...t, clips };
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
  range: null,
  envEdit: true,
  toast: null,
  dialog: null,
  busy: null,
  fileRev: 0,

  open: async (path) => {
    await get().stop();
    set({ busy: "Opening…" });
    try {
      const s = await enqueue(() => api.openFile(path));
      set({
        session: s,
        draft: null,
        range: null,
        selected: allClips(s).map((c) => c.clip.id),
        playhead: 0,
        startPoint: 0,
        fileRev: get().fileRev + 1,
      });
      get().fit();
    } catch (e) {
      get().showToast(`Couldn't open ${path}: ${apiMessage(e)}`, { error: true });
    } finally {
      set({ busy: null });
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
    const maxFpp = (timelineEnd(session) * 2) / width;
    const fpp = clamp(view.fpp * factor, 1 / 16, Math.max(maxFpp, 1));
    const anchor = view.start + px * view.fpp;
    set({ view: { fpp, start: 0 } });
    get().scrollTo(anchor - px * fpp);
  },

  scrollTo: (start) => {
    const { view, session, width } = get();
    if (!session) return;
    // Room past the end to move clips into.
    const max = Math.max(0, timelineEnd(session) * 1.5 - width * view.fpp);
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
      set({ session: s, draft: null });
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
    const f = Math.round(clamp(frame, 0, timelineEnd(session)));
    set({ playhead: f, startPoint: f });
    if (playing) void get().togglePlay().then(() => get().togglePlay());
  },

  setRange: (r) => set({ range: r && r.b - r.a >= 1 ? r : null }),

  cropToRange: async () => {
    const { session, range, selected } = get();
    if (!session) return;
    if (!range) {
      get().showToast("Drag across the ruler to pick what to keep, then crop");
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
        commands.push({ type: "trim_clip", clip: c.id, start: s, offset: c.offset + (s - c.start), len: e - s });
      }
    }
    if (commands.every((c) => c.type === "delete_clip")) {
      get().showToast("The range doesn't overlap any clip");
      return;
    }
    if (await get().apply({ type: "batch", commands })) set({ range: null, playhead: a, startPoint: a });
  },

  toggleEnvEdit: () => {
    const on = !get().envEdit;
    set({ envEdit: on });
    get().showToast(on ? "Envelope editing on" : "Envelope editing off (E turns it back on)");
  },

  togglePlay: async () => {
    const { session, playing, range, startPoint } = get();
    if (!session) return;
    if (playing) {
      await get().stop();
      return;
    }
    const end = timelineEnd(session);
    let from = startPoint;
    let to = end;
    if (range) {
      from = Math.round(range.a);
      to = Math.round(range.b);
    } else if (from >= end) {
      from = session.start;
    }
    try {
      await api.play(from, to);
      set({ playing: true, playhead: from });
    } catch (e) {
      get().showToast(`Can't play: ${apiMessage(e)}`, { error: true });
    }
  },

  stop: async () => {
    if (!get().playing) return;
    await api.stop().catch(() => undefined);
    set({ playing: false, playhead: get().range ? Math.round(get().range!.a) : get().startPoint });
  },

  poll: async () => {
    if (!get().playing) return;
    const t = await api.transport();
    if (!get().playing) return;
    if (t.playing) set({ playhead: t.position });
    else set({ playing: false, playhead: get().range ? Math.round(get().range!.a) : get().startPoint });
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
    set({ session: s, draft: null, selected: get().selected.filter((id) => ids.has(id)) });
  },

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

/** The tracks as they should be drawn right now. */
export function useTracks(): TrackState[] {
  const session = useSession((s) => s.session);
  const draft = useSession((s) => s.draft);
  return session ? shownTracks(session, draft) : [];
}
