import { create } from "zustand";
import { api, apiMessage, type ClipState, type Command, type SessionState } from "@/lib/api";
import { clamp } from "@/lib/format";

/** The one clip a scratch session edits. */
export const CLIP = { track: 0, clip: 0 } as const;

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

interface SessionStore {
  session: SessionState | null;
  /** The clip as a drag in progress shows it; null when not dragging. */
  draft: ClipState | null;
  view: View;
  /** Lane width in CSS pixels. */
  width: number;
  playhead: number;
  /** Where Stop returns to. */
  startPoint: number;
  playing: boolean;
  range: Range | null;
  toast: Toast | null;
  dialog: Dialog;
  /** A file is loading or saving. */
  busy: string | null;
  /** Bumped whenever the session's audio is (re)loaded from disk. */
  fileRev: number;

  open: (path: string) => Promise<void>;
  /** Ask first if there are unsaved edits. */
  guard: (verb: string, then: () => void) => void;
  setWidth: (w: number) => void;
  fit: () => void;
  zoomAt: (px: number, factor: number) => void;
  scrollTo: (start: number) => void;
  /** A drag step: shown at once, sent to the engine as a transient edit. */
  drag: (clip: ClipState) => void;
  /** Ends a drag with its final value as one undo step. */
  commit: () => Promise<void>;
  apply: (cmd: Command) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  setPlayhead: (frame: number) => void;
  setRange: (r: Range | null) => void;
  cropToRange: () => Promise<void>;
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
 * latest position. */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job);
  chain = p.catch(() => undefined);
  return p;
}
let latestDraft: Command | null = null;
let dragKind: Command["type"] | null = null;
let toastSeq = 0;

export function trimCommand(c: ClipState): Command {
  return { type: "trim_clip", ...CLIP, start: c.start, offset: c.offset, len: c.len };
}

function commandFor(kind: Command["type"], c: ClipState): Command {
  switch (kind) {
    case "trim_clip":
      return trimCommand(c);
    case "set_clip_gain":
      return { type: "set_clip_gain", ...CLIP, gain_db: c.gainDb };
    case "set_clip_fades":
      return { type: "set_clip_fades", ...CLIP, fade_in: c.fadeIn, fade_out: c.fadeOut };
  }
}

/** The commands that turn `from` into `to`. */
function diff(from: ClipState, to: ClipState): Command[] {
  const out: Command[] = [];
  if (from.start !== to.start || from.offset !== to.offset || from.len !== to.len) {
    out.push(trimCommand(to));
  }
  if (from.gainDb !== to.gainDb) {
    out.push({ type: "set_clip_gain", ...CLIP, gain_db: to.gainDb });
  }
  if (from.fadeIn !== to.fadeIn || from.fadeOut !== to.fadeOut) {
    out.push({ type: "set_clip_fades", ...CLIP, fade_in: to.fadeIn, fade_out: to.fadeOut });
  }
  return out;
}

/** Where the timeline ends: the end of the file, or of the clip if it was
 * moved past that. */
export function timelineEnd(s: SessionState): number {
  return Math.max(s.frames, s.clip.start + s.clip.len);
}

/** Shortest clip a trim can leave, in frames. */
export const MIN_LEN = 16;

export const useSession = create<SessionStore>((set, get) => ({
  session: null,
  draft: null,
  view: { start: 0, fpp: 100 },
  width: 800,
  playhead: 0,
  startPoint: 0,
  playing: false,
  range: null,
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
        playhead: s.clip.start,
        startPoint: s.clip.start,
        fileRev: get().fileRev + 1,
      });
      get().fit();
    } catch (e) {
      get().showToast(`Couldn't open ${path}: ${apiMessage(e)}`, { error: true });
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
    // A little room after the end so the right trim edge is easy to grab.
    const fpp = Math.max(1 / 16, (timelineEnd(session) * 1.03) / width);
    set({ view: { start: 0, fpp } });
  },

  zoomAt: (px, factor) => {
    const { view, session, width } = get();
    if (!session) return;
    const maxFpp = (timelineEnd(session) * 1.5) / width;
    const fpp = clamp(view.fpp * factor, 1 / 16, Math.max(maxFpp, 1));
    const anchor = view.start + px * view.fpp;
    set({ view: { fpp, start: 0 } });
    get().scrollTo(anchor - px * fpp);
  },

  scrollTo: (start) => {
    const { view, session, width } = get();
    if (!session) return;
    const max = Math.max(0, timelineEnd(session) * 1.03 - width * view.fpp);
    set({ view: { ...view, start: clamp(start, 0, max) } });
  },

  drag: (clip) => {
    const { session } = get();
    if (!session) return;
    set({ draft: clip });
    // A drag changes one thing; it keeps sending that command even when it
    // comes back to where it started, so the engine follows it back.
    dragKind ??= diff(session.clip, clip)[0]?.type ?? null;
    if (!dragKind) return;
    const fresh = latestDraft === null;
    latestDraft = commandFor(dragKind, clip);
    if (!fresh) return;
    void enqueue(async () => {
      const cmd = latestDraft;
      latestDraft = null;
      if (cmd) await api.apply(cmd, true);
    }).catch(() => undefined);
  },

  commit: async () => {
    const { draft } = get();
    const kind = dragKind;
    dragKind = null;
    latestDraft = null;
    if (!draft) return;
    if (!kind) {
      set({ draft: null });
      return;
    }
    try {
      const s = await enqueue(() => api.apply(commandFor(kind, draft), false));
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
      set({ session: s });
    } catch (e) {
      get().showToast(apiMessage(e), { error: true });
    }
  },

  undo: async () => {
    if (!get().session?.canUndo) return;
    set({ session: await enqueue(() => api.undo()), draft: null });
  },

  redo: async () => {
    if (!get().session?.canRedo) return;
    set({ session: await enqueue(() => api.redo()), draft: null });
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
    const { session, range } = get();
    if (!session) return;
    if (!range) {
      get().showToast("Drag across the ruler or the clip to pick what to keep, then crop");
      return;
    }
    const c = session.clip;
    const a = Math.max(Math.round(range.a), c.start);
    const b = Math.min(Math.round(range.b), c.start + c.len);
    if (b - a < MIN_LEN) {
      get().showToast("The range doesn't overlap the clip");
      return;
    }
    const offset = c.offset + (a - c.start);
    await get().apply(trimCommand({ ...c, start: a, offset, len: b - a }));
    set({ range: null, playhead: a, startPoint: a });
  },

  togglePlay: async () => {
    const { session, playing, range, startPoint } = get();
    if (!session) return;
    if (playing) {
      await get().stop();
      return;
    }
    const c = session.clip;
    let from = startPoint;
    let to = c.start + c.len;
    if (range) {
      from = Math.round(range.a);
      to = Math.round(range.b);
    } else if (from >= to || from < c.start) {
      from = from >= to ? c.start : Math.max(from, 0);
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

  adopt: (s) => set({ session: s, draft: null }),

  reloaded: (s) => {
    set({
      session: s,
      draft: null,
      range: null,
      playhead: s?.clip.start ?? 0,
      startPoint: s?.clip.start ?? 0,
      fileRev: get().fileRev + 1,
    });
    get().fit();
  },
}));

/** The clip as it should be drawn right now. */
export function useClip(): ClipState | null {
  return useSession((s) => s.draft ?? s.session?.clip ?? null);
}
