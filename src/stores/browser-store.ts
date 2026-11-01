import { create } from "zustand";
import { api, apiMessage, type PreviewInfo } from "@/lib/api";
import { Clock } from "@/lib/frame-loop";
import { findLabel, parseQuery } from "@/lib/labels";
import { setSetting, setting } from "@/lib/settings";
import { type LibraryFilter, useLibrary } from "@/stores/library-store";
import { useSession } from "@/stores/session-store";

/** What the Browser remembers between launches. */
interface Saved {
  /** Shown in projects; a scratch session starts with it collapsed. */
  open: boolean;
  /** Folders added to the Folders tree. */
  roots: string[];
  pins: string[];
  recent: string[];
  /** Expanded folders. */
  expanded: string[];
  /** Collapsed sections: "pins", "recent", "labels", "folders". */
  shut: string[];
  /** Section order, top to bottom; collapsed ones sit at the bottom in this order. */
  order: string[];
  autoPreview: boolean;
  /** WAV / MP3 badges on files (names then drop the extension). */
  typeIcons: boolean;
  /** Width from before panels; the first panel layout starts from it (the
   * layout keeps the Browser's size since, see `stores/layout-store.ts`). */
  width: number | null;
  /** The Folders section shows the folder tree, or virtual folders by Type label. */
  group: "folder" | "type";
}

/** The Browser's sections, in their default order. */
export const SECTIONS = ["pins", "recent", "labels", "folders"];

const DEFAULT: Saved = {
  open: true,
  roots: [],
  pins: [],
  recent: [],
  expanded: [],
  shut: [],
  order: SECTIONS,
  autoPreview: true,
  typeIcons: true,
  width: null,
  group: "folder",
};
const MAX_RECENT = 30;

function load(): Saved {
  const v = setting<Partial<Saved> | null>("browser", null);
  const out = { ...DEFAULT, ...(v && typeof v === "object" ? v : {}) };
  // Keep only known sections, and add any a newer version introduced.
  const order = Array.isArray(out.order) ? out.order.filter((k) => SECTIONS.includes(k)) : [];
  // A section a newer version introduced goes where the defaults have it:
  // before the first default section after it that's already placed.
  for (const k of SECTIONS) {
    if (order.includes(k)) continue;
    const next = SECTIONS.slice(SECTIONS.indexOf(k) + 1).find((x) => order.includes(x));
    order.splice(next ? order.indexOf(next) : order.length, 0, k);
  }
  out.order = order;
  if (out.group !== "type") out.group = "folder";
  return out;
}

/** Where the label picker or the label dialog opens. */
export interface PopupAt {
  x: number;
  y: number;
}

/** The label dialog: a new label (applied to `path` when given), or editing one. */
export interface LabelDialog extends PopupAt {
  edit: string | null;
  path: string | null;
  name: string;
}

export interface Listing {
  dirs: string[];
  files: string[];
  error?: string;
}

interface BrowserStore extends Saved {
  /** Open in this scratch session (it starts collapsed). */
  openScratch: boolean;
  listings: Record<string, Listing | undefined>;
  query: string;
  results: string[] | null;
  /** The file in the preview pane. */
  current: string | null;
  info: PreviewInfo | null;
  playing: boolean;
  /** Seconds into the preview being heard. */
  at: number;
  /** Label filters picked in the Labels section (ids); they stack with search. */
  filters: string[];
  /** Only favourites (the ★ button). */
  favOnly: boolean;
  /** The label picker, for `path`. */
  picker: (PopupAt & { path: string }) | null;
  labelDialog: LabelDialog | null;
  /** The panel is wide enough for four label icons on a row. */
  wide: boolean;

  toggle: () => void;
  isOpen: () => boolean;
  addRoots: (paths: string[]) => Promise<number>;
  removeRoot: (path: string) => void;
  togglePin: (path: string) => void;
  toggleFolder: (path: string) => void;
  toggleSection: (key: string) => void;
  /** Moves section `key` before `before` (null: to the end). */
  moveSection: (key: string, before: string | null) => void;
  list: (path: string, force?: boolean) => Promise<void>;
  search: (q: string) => void;
  pick: (path: string, play?: boolean) => Promise<void>;
  play: (from?: number) => Promise<void>;
  stop: () => void;
  noteRecent: (paths: string[]) => void;
  forgetRecent: (path: string) => void;
  setAutoPreview: (on: boolean) => void;
  setTypeIcons: (on: boolean) => void;
  setGroup: (g: "folder" | "type") => void;
  toggleFilter: (id: string) => void;
  setFavOnly: (on: boolean) => void;
  /** What the Browser is filtered by: the Labels section, ★, and `#label ★` in search. */
  filter: () => LibraryFilter;
  openPicker: (path: string, at: PopupAt) => void;
  openLabelDialog: (d: Partial<LabelDialog> & PopupAt) => void;
  closePopups: () => void;
}

/** "C:\\a\\b" → "b". */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * For each path, the trailing parent folders needed to tell it apart from the
 * others with the same name, VS Code style: "" when its name is unique, else
 * e.g. "Editor/Audio" for "…\\Editor\\Audio\\Download". Case-insensitive, as on Windows.
 */
export function disambiguate(paths: string[]): Record<string, string> {
  const segs = paths.map((p) => p.split(/[\\/]/).filter(Boolean));
  const depth = paths.map(() => 1);
  const label = (i: number) => segs[i].slice(-depth[i]).join("/").toLowerCase();
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Map<string, number[]>();
    paths.forEach((_, i) => groups.set(label(i), [...(groups.get(label(i)) ?? []), i]));
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const i of g) {
        if (depth[i] < segs[i].length) {
          depth[i]++;
          changed = true;
        }
      }
    }
  }
  const out: Record<string, string> = {};
  paths.forEach((p, i) => (out[p] = segs[i].slice(-depth[i], -1).join("/")));
  return out;
}

export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

let searchSeq = 0;
let searchTimer = 0;
let pollTimer = 0;

/** The preview's playhead as drawn, in seconds: runs on between polls so
 * it moves at the display's rate. */
export const previewClock = new Clock(1, (p) => Math.min(p, useBrowser.getState().info?.seconds ?? p));

export const useBrowser = create<BrowserStore>((set, get) => {
  const save = () => {
    const s = get();
    const keep: Saved = {
      open: s.open,
      roots: s.roots,
      pins: s.pins,
      recent: s.recent,
      expanded: s.expanded,
      shut: s.shut,
      order: s.order,
      autoPreview: s.autoPreview,
      typeIcons: s.typeIcons,
      width: s.width,
      group: s.group,
    };
    setSetting("browser", keep);
  };
  const update = (p: Partial<BrowserStore>) => {
    set(p);
    save();
  };
  const poll = () => {
    window.clearTimeout(pollTimer);
    void api
      .previewStatus()
      .then((st) => {
        set({ playing: st.playing, at: st.seconds });
        if (st.playing) previewClock.report(st.seconds);
        else previewClock.stop();
        if (st.playing) pollTimer = window.setTimeout(poll, 40);
      })
      .catch(() => set({ playing: false }));
  };
  return {
    ...load(),
    openScratch: false,
    listings: {},
    query: "",
    results: null,
    current: null,
    info: null,
    playing: false,
    at: 0,
    filters: [],
    favOnly: false,
    picker: null,
    labelDialog: null,
    wide: false,

    isOpen: () => (useSession.getState().session?.scratch ? get().openScratch : get().open),
    toggle: () => {
      if (useSession.getState().session?.scratch) set({ openScratch: !get().openScratch });
      else update({ open: !get().open });
    },

    addRoots: async (paths) => {
      let added = 0;
      for (const p of paths) {
        try {
          const l = await api.listDir(p);
          set({ listings: { ...get().listings, [p]: l } });
          if (!get().roots.includes(p)) {
            update({ roots: [...get().roots, p], expanded: [...new Set([...get().expanded, p])] });
            added++;
          }
        } catch {
          // Not a folder.
        }
      }
      if (added) {
        update({ open: true, shut: get().shut.filter((k) => k !== "folders") });
        if (useSession.getState().session?.scratch) set({ openScratch: true });
      }
      return added;
    },
    removeRoot: (path) => update({ roots: get().roots.filter((r) => r !== path) }),
    togglePin: (path) => {
      const pins = get().pins;
      update({ pins: pins.includes(path) ? pins.filter((p) => p !== path) : [...pins, path], shut: get().shut.filter((k) => k !== "pins") });
    },
    toggleFolder: (path) => {
      const ex = get().expanded;
      const open = ex.includes(path);
      update({ expanded: open ? ex.filter((e) => e !== path) : [...ex, path] });
      if (!open && !get().listings[path]) void get().list(path);
    },
    toggleSection: (key) => {
      const sh = get().shut;
      update({ shut: sh.includes(key) ? sh.filter((k) => k !== key) : [...sh, key] });
    },
    moveSection: (key, before) => {
      if (key === before) return;
      const rest = get().order.filter((k) => k !== key);
      const i = before === null ? -1 : rest.indexOf(before);
      rest.splice(i < 0 ? rest.length : i, 0, key);
      update({ order: rest });
    },
    list: async (path, force = false) => {
      if (get().listings[path] && !force) return;
      try {
        const l = await api.listDir(path);
        set({ listings: { ...get().listings, [path]: l } });
      } catch (e) {
        set({ listings: { ...get().listings, [path]: { dirs: [], files: [], error: apiMessage(e) } } });
      }
    },

    search: (q) => {
      set({ query: q });
      window.clearTimeout(searchTimer);
      // `#label` and ★ filter; only the rest is looked for by name.
      q = parseQuery(q).words;
      if (!q.trim()) {
        searchSeq++;
        set({ results: null });
        return;
      }
      const seq = ++searchSeq;
      searchTimer = window.setTimeout(() => {
        const roots = [...new Set([...get().roots, ...get().pins])];
        void api
          .searchFiles(roots, q)
          .catch(() => [] as string[])
          .then((r) => {
            if (seq !== searchSeq) return;
            // Recent files match too, folders or not.
            const words = q.toLowerCase().split(/\s+/).filter(Boolean);
            const rec = get().recent.filter((p) => words.every((w) => baseName(p).toLowerCase().includes(w)));
            set({ results: [...new Set([...rec, ...r])] });
          });
      }, 200);
    },

    pick: async (path, play) => {
      const was = get().current;
      set({ current: path });
      if (was !== path) {
        set({ info: null });
        try {
          const info = await api.previewInfo(path, 400);
          if (get().current === path) set({ info });
        } catch (e) {
          useSession.getState().showToast(apiMessage(e), { error: true });
          return;
        }
      }
      if (play ?? get().autoPreview) await get().play(0);
    },
    play: async (from = 0) => {
      const path = get().current;
      if (!path) return;
      // The session stops; a preview plays in its place.
      if (useSession.getState().playing) await useSession.getState().stop();
      try {
        await api.previewPlay(path, from);
        set({ playing: true, at: from });
        previewClock.reset(from);
        poll();
      } catch (e) {
        useSession.getState().showToast(apiMessage(e), { error: true });
      }
    },
    stop: () => {
      window.clearTimeout(pollTimer);
      set({ playing: false });
      previewClock.stop();
      void api.previewStop().catch(() => undefined);
    },

    noteRecent: (paths) => {
      if (!paths.length) return;
      const recent = [...paths, ...get().recent.filter((p) => !paths.includes(p))].slice(0, MAX_RECENT);
      if (recent.join("\n") !== get().recent.join("\n")) update({ recent });
    },
    forgetRecent: (path) => update({ recent: get().recent.filter((p) => p !== path) }),
    setAutoPreview: (on) => update({ autoPreview: on }),
    setTypeIcons: (on) => update({ typeIcons: on }),
    setGroup: (group) => update({ group }),
    toggleFilter: (id) => {
      const f = get().filters;
      set({ filters: f.includes(id) ? f.filter((x) => x !== id) : [...f, id] });
    },
    setFavOnly: (favOnly) => set({ favOnly }),
    filter: () => {
      const q = parseQuery(get().query);
      const all = useLibrary.getState().all();
      // A label the search names that doesn't exist matches nothing.
      const named = q.labels.map((t) => findLabel(all, t)?.id ?? `#${t}`);
      return { labels: [...new Set([...get().filters, ...named])], fav: get().favOnly || q.fav };
    },
    openPicker: (path, at) => set({ picker: { path, ...at }, labelDialog: null }),
    openLabelDialog: (d) => set({ labelDialog: { edit: null, path: null, name: "", ...d }, picker: null }),
    closePopups: () => set({ picker: null, labelDialog: null }),
  };
});

/** Files that join the session land in Recent files; the session playing
 * stops a preview. */
useSession.subscribe((s, prev) => {
  if (s.session !== prev.session && s.session) {
    const before = new Set(prev.session?.sources.map((x) => x.path) ?? []);
    const added = s.session.sources.map((x) => x.path).filter((p) => !before.has(p));
    if (s.session.path && s.session.path !== prev.session?.path) added.unshift(s.session.path);
    useBrowser.getState().noteRecent([...new Set(added)]);
    if (s.session.scratch && !prev.session?.scratch) useBrowser.setState({ openScratch: false });
  }
  if (s.playing && !prev.playing && useBrowser.getState().playing) useBrowser.getState().stop();
});
