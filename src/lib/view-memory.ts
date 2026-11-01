import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * How each file was last shown, so reopening it comes back as it was left:
 * the timeline's zoom and scroll, the tracks' scroll and heights, the
 * playhead and the ruler range.
 *
 * Kept per file, keyed by its path (the project's `.dawg`, or the audio file
 * of a scratch session), in `views.json` in the app's data folder
 * (`src-tauri/src/settings.rs`), not in `settings.json` (that's app-wide)
 * and not in the project file (looking around shouldn't make a project
 * unsaved, and a scratch WAV has no project file). An Untitled project's
 * view is kept under one key and only comes back with crash recovery.
 *
 * Session tabs hold one `SavedView` per tab in memory and save each under
 * its own file's key, so the shape is the same either way.
 */

/** Mirrors the session store's view state; frames throughout. */
export interface SavedView {
  /** Timeline frame at the left edge. */
  start: number;
  /** Frames per pixel. */
  fpp: number;
  /** The tracks' vertical scroll, in CSS pixels. */
  scrollTop: number;
  /** Where the playhead was put (where Stop returns to). */
  playhead: number;
  range: { a: number; b: number } | null;
  /** Track heights the user set, by track id. */
  heights: Record<number, number>;
  /** When it was saved, ms since the Unix epoch: the oldest go first. */
  at: number;
}

/** The key for an Untitled project. */
export const UNTITLED = "untitled";
/** How many files' views are kept. */
const KEEP = 200;
const LOCAL_KEY = "dawg.views";
/** A change is saved once things hold still this long. */
const SAVE_MS = 800;

let views: Record<string, SavedView> = {};
let live: { key: string; read: () => Omit<SavedView, "at"> } | null = null;
let timer = 0;
let writing: Promise<void> = Promise.resolve();

/** The key a path is kept under: Windows paths ignore case and slashes. */
export function viewKey(path: string | null | undefined): string | null {
  if (!path) return null;
  return /^[a-z]:|\\/i.test(path) ? path.replace(/\//g, "\\").toLowerCase() : path;
}

/** Reads the saved views. Call once at launch, beside `loadSettings`. */
export async function loadViews(): Promise<void> {
  let saved: unknown = null;
  try {
    saved = isTauri() ? await invoke<unknown>("load_views") : JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null");
  } catch {
    // Nothing saved yet: every file opens fitted.
  }
  if (saved && typeof saved === "object" && !Array.isArray(saved)) views = saved as Record<string, SavedView>;
}

/** The view `key` was last left with, if it looks sound. */
export function recall(key: string): SavedView | null {
  const v = views[key];
  if (!v || typeof v !== "object") return null;
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!ok(v.start) || !ok(v.fpp) || v.fpp <= 0) return null;
  const range = v.range && ok(v.range.a) && ok(v.range.b) && v.range.b > v.range.a ? v.range : null;
  const heights: Record<number, number> = {};
  if (v.heights && typeof v.heights === "object") {
    for (const [id, h] of Object.entries(v.heights)) if (ok(h)) heights[Number(id)] = h;
  }
  return {
    start: Math.max(0, v.start),
    fpp: v.fpp,
    scrollTop: ok(v.scrollTop) ? Math.max(0, v.scrollTop) : 0,
    playhead: ok(v.playhead) ? Math.max(0, v.playhead) : 0,
    range,
    heights,
    at: ok(v.at) ? v.at : 0,
  };
}

/** Follows the session now shown, saved under `key` (null: nothing to
 * keep). What the last one had waiting is saved first. */
export function follow(key: string | null, read: () => Omit<SavedView, "at">) {
  if (live?.key === key) {
    live.read = read;
    return;
  }
  if (timer) persist();
  live = key ? { key, read } : null;
}

/** The shown view changed: saved shortly, once it holds still. Cheap enough
 * to call on every frame of a scroll or zoom. */
export function touched() {
  if (!live) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(persist, SAVE_MS);
}

function persist() {
  window.clearTimeout(timer);
  timer = 0;
  if (live) views[live.key] = { ...live.read(), at: Date.now() };
  const keys = Object.keys(views);
  if (keys.length > KEEP) {
    keys.sort((a, b) => (views[b].at ?? 0) - (views[a].at ?? 0));
    for (const k of keys.slice(KEEP)) delete views[k];
  }
  const snapshot = { ...views };
  if (isTauri()) {
    writing = writing.then(() => invoke<void>("save_views", { views: snapshot })).catch(() => undefined);
  } else {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
    } catch {
      // Only a convenience.
    }
  }
}

/** Saves now: before the window closes. */
export function flushViews(): Promise<void> {
  if (timer) persist();
  return writing;
}

/** The tracks' vertical scroll lives in the DOM, not the store: the Editor
 * reports it here and picks up `pending` when a file opens. */
export const tracksScroll: { top: number; pending: number | null } = { top: 0, pending: null };
