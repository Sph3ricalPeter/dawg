import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { BUILTIN_LABELS, FALLBACK_ICON, LABEL_COLORS, LABEL_GROUPS, LABEL_ICONS, builtinLabel, isBuiltin, type Label } from "@/lib/labels";
import { viewKey } from "@/lib/view-memory";

/**
 * The Browser's library: which labels each file has and whether it's a
 * favourite, plus the user's custom labels. A layer over the folders, kept
 * in `library.json` in the app's data folder (`src-tauri/src/settings.rs`),
 * so nothing is written into the folders themselves.
 *
 * Files are keyed by path the way Windows compares them (case and slashes
 * don't count), and only files with a label or a star are kept.
 */

export interface LibraryFile {
  /** The path as it was first seen. */
  path: string;
  /** Label ids, in the order they were added. */
  labels: string[];
  fav: boolean;
}

/** `library.json`. Additive changes only: older builds read newer files. */
interface LibraryData {
  version: 1;
  /** Custom labels only; built-ins come from `lib/labels.ts`. */
  labels: Label[];
  files: Record<string, LibraryFile>;
}

/** What the Browser shows only: files with all of `labels`, and starred
 * ones when `fav`. */
export interface LibraryFilter {
  labels: string[];
  fav: boolean;
}

const LOCAL_KEY = "dawg.library";
const SAVE_MS = 400;

let timer = 0;
let writing: Promise<void> = Promise.resolve();

/** The key a file is kept under: Windows paths ignore case and slashes. */
export function libraryKey(path: string): string {
  return viewKey(path) ?? path;
}
const key = libraryKey;

/** Whether a library entry (or a file not in it) passes `filter`. */
export function matchesEntry(e: LibraryFile | undefined, filter: LibraryFilter): boolean {
  if (!filter.labels.length && !filter.fav) return true;
  if (!e) return false;
  return (!filter.fav || e.fav) && filter.labels.every((l) => e.labels.includes(l));
}

/** A label by id, from the built-ins or `custom`. */
export function resolveLabel(id: string, custom: readonly Label[]): Label | undefined {
  return builtinLabel(id) ?? custom.find((l) => l.id === id);
}

function sanitize(raw: unknown): LibraryData {
  const out: LibraryData = { version: 1, labels: [], files: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<LibraryData>;
  if (Array.isArray(r.labels)) {
    for (const l of r.labels) {
      if (!l || typeof l.id !== "string" || typeof l.name !== "string" || isBuiltin(l.id)) continue;
      out.labels.push({
        id: l.id,
        name: l.name,
        group: LABEL_GROUPS.includes(l.group) ? l.group : "Custom",
        color: typeof l.color === "string" ? l.color : LABEL_COLORS[0],
        icon: typeof l.icon === "string" ? l.icon : FALLBACK_ICON,
      });
    }
  }
  if (r.files && typeof r.files === "object") {
    for (const f of Object.values(r.files)) {
      if (!f || typeof f.path !== "string") continue;
      const labels = Array.isArray(f.labels) ? [...new Set(f.labels.filter((x): x is string => typeof x === "string"))] : [];
      const fav = f.fav === true;
      if (labels.length || fav) out.files[key(f.path)] = { path: f.path, labels, fav };
    }
  }
  return out;
}

let loaded: LibraryData = { version: 1, labels: [], files: {} };

/** Reads the saved library. Call once at launch, beside `loadSettings`. */
export async function loadLibrary(): Promise<void> {
  let saved: unknown = null;
  try {
    saved = isTauri() ? await invoke<unknown>("load_library") : JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null");
  } catch {
    // Nothing saved yet.
  }
  loaded = sanitize(saved);
  useLibrary.setState({ custom: loaded.labels, files: loaded.files });
}

function persist() {
  window.clearTimeout(timer);
  timer = 0;
  const s = useLibrary.getState();
  const data: LibraryData = { version: 1, labels: s.custom, files: s.files };
  if (isTauri()) {
    writing = writing.then(() => invoke<void>("save_library", { library: data })).catch(() => undefined);
  } else {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    } catch {
      // Only a convenience.
    }
  }
}

/** Saves now: before the window closes. */
export function flushLibrary(): Promise<void> {
  if (timer) persist();
  return writing;
}

interface LibraryStore {
  custom: Label[];
  files: Record<string, LibraryFile>;

  /** Every label, built-ins first, in the picker's order. */
  all: () => Label[];
  label: (id: string) => Label | undefined;
  entry: (path: string) => LibraryFile | undefined;
  /** The file's labels that still exist. */
  labelsOf: (path: string) => Label[];
  isFav: (path: string) => boolean;
  matches: (path: string, filter: LibraryFilter) => boolean;

  setFav: (path: string, fav: boolean) => void;
  toggleFav: (path: string) => void;
  /** Adds the label when the file lacks it, else takes it off. */
  toggleLabel: (path: string, id: string) => void;
  setLabels: (path: string, ids: string[]) => void;
  /** A new custom label; returns its id. */
  createLabel: (l: Omit<Label, "id" | "group">) => string;
  /** Renames or recolours a custom label. Built-ins can't change. */
  editLabel: (id: string, l: Partial<Omit<Label, "id" | "group">>) => void;
  /** Deletes a custom label and takes it off every file. */
  deleteLabel: (id: string) => void;
}

/** The number of library files with each label. */
export function labelCounts(files: Record<string, LibraryFile>): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of Object.values(files)) for (const l of f.labels) out.set(l, (out.get(l) ?? 0) + 1);
  return out;
}

export const useLibrary = create<LibraryStore>((set, get) => {
  const changed = (files: Record<string, LibraryFile>, custom = get().custom) => {
    set({ files, custom });
    window.clearTimeout(timer);
    timer = window.setTimeout(persist, SAVE_MS);
  };
  const put = (path: string, f: (e: LibraryFile) => LibraryFile) => {
    const k = key(path);
    const cur = get().files[k] ?? { path, labels: [], fav: false };
    const next = f({ ...cur, labels: [...cur.labels] });
    const files = { ...get().files };
    if (next.labels.length || next.fav) files[k] = next;
    else delete files[k];
    changed(files);
  };
  return {
    custom: loaded.labels,
    files: loaded.files,

    all: () => [...BUILTIN_LABELS, ...get().custom],
    label: (id) => resolveLabel(id, get().custom),
    entry: (path) => get().files[key(path)],
    labelsOf: (path) => {
      const e = get().files[key(path)];
      if (!e) return [];
      return e.labels.map((id) => get().label(id)).filter((l): l is Label => !!l);
    },
    isFav: (path) => !!get().files[key(path)]?.fav,
    matches: (path, filter) => matchesEntry(get().files[key(path)], filter),

    setFav: (path, fav) => put(path, (e) => ({ ...e, fav })),
    toggleFav: (path) => put(path, (e) => ({ ...e, fav: !e.fav })),
    toggleLabel: (path, id) => put(path, (e) => ({ ...e, labels: e.labels.includes(id) ? e.labels.filter((x) => x !== id) : [...e.labels, id] })),
    setLabels: (path, ids) => put(path, (e) => ({ ...e, labels: [...new Set(ids)] })),
    createLabel: (l) => {
      const id = `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const label: Label = { id, group: "Custom", name: l.name.trim() || "Label", color: l.color, icon: l.icon in LABEL_ICONS ? l.icon : FALLBACK_ICON };
      changed(get().files, [...get().custom, label]);
      return id;
    },
    editLabel: (id, l) => {
      if (isBuiltin(id)) return;
      changed(
        get().files,
        get().custom.map((c) => (c.id === id ? { ...c, ...l, name: (l.name ?? c.name).trim() || c.name } : c)),
      );
    },
    deleteLabel: (id) => {
      if (isBuiltin(id)) return;
      const files: Record<string, LibraryFile> = {};
      for (const [k, f] of Object.entries(get().files)) {
        const labels = f.labels.filter((x) => x !== id);
        if (labels.length || f.fav) files[k] = labels.length === f.labels.length ? f : { ...f, labels };
      }
      changed(
        files,
        get().custom.filter((c) => c.id !== id),
      );
    },
  };
});

/** A file's labels and favourite, read live from the library. */
export function useFileLibrary(path: string): { labels: Label[]; fav: boolean } {
  const entry = useLibrary((s) => s.files[libraryKey(path)]);
  const custom = useLibrary((s) => s.custom);
  const labels = (entry?.labels ?? []).map((id) => resolveLabel(id, custom)).filter((l): l is Label => !!l);
  return { labels, fav: !!entry?.fav };
}
