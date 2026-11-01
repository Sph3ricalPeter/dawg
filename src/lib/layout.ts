/**
 * The window's panel layout: a dock tree of horizontal and vertical splits
 * that fills the work area, plus panels floating above it. Pure functions
 * only; `stores/layout-store.ts` holds the current layout and saves it to
 * `settings.json`. See "Panels and docking" in the UX spec.
 *
 * In each split one child has no `size` and takes the rest: the one that
 * holds the Timeline, so a bigger window means a bigger Timeline. The others
 * keep their size in px along the split.
 */

export type PanelId = "browser" | "timeline" | "eq";
export type Side = "left" | "right" | "top" | "bottom";
export type Dir = "row" | "col";

export type PanelNode = { panel: PanelId; size?: number };
export type SplitNode = { split: Dir; items: DockNode[]; size?: number };
export type DockNode = PanelNode | SplitNode;

export interface FloatRect {
  panel: PanelId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a panel was docked before it floated, for Dock back. */
export interface Place {
  next: PanelId | "window";
  side: Side;
  /** Its size there, to come back at. */
  size?: number;
}

export interface Layout {
  version: 1;
  dock: DockNode;
  floating: FloatRect[];
  lastDock: Partial<Record<PanelId, Place>>;
}

export interface PanelInfo {
  title: string;
  /** Default size when docked into a row (width) or a column (height). */
  size: Record<Dir, number>;
  min: Record<Dir, number>;
  /** Default floating size; null for a panel that never floats. */
  float: { w: number; h: number } | null;
}

export const PANEL_IDS: readonly PanelId[] = ["browser", "timeline", "eq"];

export const PANELS: Record<PanelId, PanelInfo> = {
  browser: { title: "Browser", size: { row: 208, col: 220 }, min: { row: 150, col: 120 }, float: { w: 260, h: 440 } },
  timeline: { title: "Timeline", size: { row: 600, col: 300 }, min: { row: 320, col: 160 }, float: null },
  eq: { title: "EQ", size: { row: 560, col: 252 }, min: { row: 460, col: 150 }, float: { w: 720, h: 270 } },
};

/** The header height: a collapsed panel keeps only this. */
export const HEAD = 26;
/** The smallest floating panel. */
export const FLOAT_MIN = { w: 240, h: 140 };

export type PresetName = "side" | "floatEq" | "classic";

export const PRESETS: Record<PresetName, { label: string; make: (browserWidth?: number) => Layout }> = {
  side: {
    label: "Side browser",
    make: (bw = 208) => ({
      version: 1,
      dock: { split: "row", items: [{ panel: "browser", size: bw }, { split: "col", items: [{ panel: "timeline" }, { panel: "eq", size: 252 }] }] },
      floating: [],
      lastDock: {},
    }),
  },
  floatEq: {
    label: "Floating EQ",
    make: (bw = 208) => ({
      version: 1,
      dock: { split: "row", items: [{ panel: "browser", size: bw }, { panel: "timeline" }] },
      // Negative x and y: placed at the bottom right when first shown.
      floating: [{ panel: "eq", x: -1, y: -1, w: 720, h: 270 }],
      lastDock: { eq: { next: "timeline", side: "bottom" } },
    }),
  },
  classic: {
    label: "Classic",
    make: (bw = 208) => ({
      version: 1,
      dock: { split: "col", items: [{ split: "row", items: [{ panel: "browser", size: bw }, { panel: "timeline" }] }, { panel: "eq", size: 252 }] },
      floating: [],
      lastDock: {},
    }),
  },
};

export const DEFAULT_PRESET: PresetName = "side";

const isPanel = (n: DockNode): n is PanelNode => "panel" in n;

export function contains(n: DockNode, id: PanelId): boolean {
  return isPanel(n) ? n.panel === id : n.items.some((k) => contains(k, id));
}

/** The panels in a subtree, in order. */
export function panelsIn(n: DockNode): PanelId[] {
  return isPanel(n) ? [n.panel] : n.items.flatMap(panelsIn);
}

/** A stable name for a subtree, for finding its element. */
export function nodeKey(n: DockNode): string {
  return panelsIn(n).join("+");
}

/** The panel a subtree is named after: the Timeline if it holds it. */
export function leadPanel(n: DockNode): PanelId {
  if (isPanel(n)) return n.panel;
  return leadPanel(n.items.find((k) => contains(k, "timeline")) ?? n.items[0]);
}

export function isFloating(l: Layout, id: PanelId): boolean {
  return l.floating.some((f) => f.panel === id);
}

/** Measures a subtree's current size along `dir` in px, or 0 if unknown. */
export type Measure = (n: DockNode, dir: Dir) => number;
const noMeasure: Measure = () => 0;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Makes one child per split the one that takes the rest: the Timeline's,
 * else the one that already does, else the last. A child that stops taking
 * the rest keeps the size it has on screen. */
function fixFlex(n: DockNode, measure: Measure): DockNode {
  if (isPanel(n)) return n;
  const items = n.items.map((k) => fixFlex(k, measure));
  let flex = items.findIndex((k) => contains(k, "timeline"));
  if (flex < 0) flex = items.findIndex((k) => k.size === undefined);
  if (flex < 0) flex = items.length - 1;
  items.forEach((k, i) => {
    if (i === flex) delete k.size;
    else if (k.size === undefined) {
      // It took the rest until now, so what it measures can be most of the
      // window: no more than its default.
      const def = PANELS[leadPanel(k)].size[n.split];
      k.size = Math.round(Math.min(measure(k, n.split) || def, def));
    }
  });
  return { ...n, items };
}

/** The tree without `id`; a split left with one child folds into it. */
function remove(n: DockNode, id: PanelId): DockNode | null {
  if (isPanel(n)) return n.panel === id ? null : n;
  const items: DockNode[] = [];
  for (const k of n.items) {
    const r = remove(k, id);
    if (r) items.push(r);
  }
  if (!items.length) return null;
  if (items.length === 1) {
    const only = { ...items[0] };
    delete only.size;
    if (n.size !== undefined) only.size = n.size;
    return only;
  }
  return { ...n, items };
}

function insertBeside(n: DockNode, target: PanelId, leaf: PanelNode, dir: Dir, before: boolean): DockNode {
  if (isPanel(n)) {
    if (n.panel !== target) return n;
    const t: PanelNode = { panel: target };
    const s: SplitNode = { split: dir, items: before ? [leaf, t] : [t, leaf] };
    if (n.size !== undefined) s.size = n.size;
    return s;
  }
  const i = n.items.findIndex((k) => isPanel(k) && k.panel === target);
  if (i >= 0 && n.split === dir) {
    const items = n.items.slice();
    items.splice(before ? i : i + 1, 0, leaf);
    return { ...n, items };
  }
  return { ...n, items: n.items.map((k) => insertBeside(k, target, leaf, dir, before)) };
}

/** Where a docked panel sits: beside which panel, on which side. */
export function placeOf(n: DockNode, id: PanelId): Place | null {
  if (isPanel(n)) return null;
  const i = n.items.findIndex((k) => isPanel(k) && k.panel === id);
  if (i >= 0) {
    const after = i > 0;
    const sib = n.items[after ? i - 1 : 1];
    return { next: leadPanel(sib), side: n.split === "row" ? (after ? "right" : "left") : after ? "bottom" : "top", size: n.items[i].size };
  }
  for (const k of n.items) {
    const r = placeOf(k, id);
    if (r) return r;
  }
  return null;
}

/**
 * Docks `id` beside `target` (a docked panel, or the whole window) on
 * `side`. `span` is the target's size along the split, so the new panel
 * takes its default size but at most half of it.
 */
export function dockPanel(
  l: Layout,
  id: PanelId,
  target: PanelId | "window",
  side: Side,
  span: number,
  measure: Measure = noMeasure,
  want?: number,
): Layout {
  const out = clone(l);
  const dir: Dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  let dock = remove(out.dock, id) ?? { panel: "timeline" };
  out.floating = out.floating.filter((f) => f.panel !== id);
  const size = Math.round(Math.max(PANELS[id].min[dir], Math.min(want ?? PANELS[id].size[dir], span / 2)));
  const leaf: PanelNode = { panel: id, size };
  if (target === "window" || target === id || !contains(dock, target)) {
    if (!isPanel(dock) && dock.split === dir) dock = { ...dock, items: before ? [leaf, ...dock.items] : [...dock.items, leaf] };
    else {
      const old = { ...dock };
      delete old.size;
      dock = { split: dir, items: before ? [leaf, old] : [old, leaf] };
    }
    target = "window";
  } else {
    dock = insertBeside(dock, target, leaf, dir, before);
  }
  out.dock = fixFlex(dock, measure);
  out.lastDock[id] = { next: target, side };
  return out;
}

/** Floats a docked panel at `rect` (in work-area px), remembering where it
 * was for Dock back. The Timeline never floats. */
export function floatPanel(l: Layout, id: PanelId, rect: Omit<FloatRect, "panel">, measure: Measure = noMeasure): Layout {
  if (!PANELS[id].float) return l;
  const out = clone(l);
  const place = placeOf(out.dock, id);
  if (place) out.lastDock[id] = place;
  out.dock = fixFlex(remove(out.dock, id) ?? { panel: "timeline" }, measure);
  out.floating = out.floating.filter((f) => f.panel !== id).concat([{ panel: id, ...rect }]);
  return out;
}

/** Docks a floating panel back where it was, or on its default edge if
 * the panel it was beside has moved away. */
export function dockBack(l: Layout, id: PanelId, spanOf: (target: PanelId | "window", side: Side) => number, measure: Measure = noMeasure): Layout {
  const ld = l.lastDock[id] ?? { next: "window", side: id === "browser" ? "left" : "bottom" };
  const ok = ld.next === "window" || (ld.next !== id && contains(l.dock, ld.next));
  const target = ok ? ld.next : "window";
  return dockPanel(l, id, target, ld.side, spanOf(target, ld.side), measure, ok ? ld.size : undefined);
}

export function moveFloat(l: Layout, id: PanelId, rect: Partial<Omit<FloatRect, "panel">>): Layout {
  return { ...l, floating: l.floating.map((f) => (f.panel === id ? { ...f, ...rect } : f)) };
}

/** Sets the size of the node at `path` (child indices from the root). */
export function setSizeAt(l: Layout, path: number[], size: number): Layout {
  const out = clone(l);
  let n: DockNode = out.dock;
  for (const i of path) {
    if (isPanel(n)) return l;
    n = n.items[i];
    if (!n) return l;
  }
  n.size = Math.round(size);
  return out;
}

/** A floating rect kept inside a work area of `w` × `h`. Negative x or y
 * (a preset's "wherever it fits") means the bottom right corner. */
export function clampFloat(f: FloatRect, w: number, h: number): FloatRect {
  const fw = Math.round(Math.max(FLOAT_MIN.w, Math.min(f.w, w)));
  const fh = Math.round(Math.max(FLOAT_MIN.h, Math.min(f.h, h)));
  const x = f.x < 0 ? w - fw - 24 : f.x;
  const y = f.y < 0 ? h - fh - 24 : f.y;
  return { panel: f.panel, w: fw, h: fh, x: Math.round(Math.max(0, Math.min(x, w - fw))), y: Math.round(Math.max(0, Math.min(y, h - fh))) };
}

/** A saved layout, checked: every panel exactly once, the Timeline docked,
 * sizes at least the minimum. Null if it can't be used. */
export function validate(v: unknown): Layout | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<Layout>;
  if (o.version !== 1 || !o.dock) return null;
  const seen: string[] = [];
  const node = (n: unknown, dir: Dir | null): DockNode | null => {
    if (!n || typeof n !== "object") return null;
    const r = n as Record<string, unknown>;
    const size = typeof r.size === "number" && Number.isFinite(r.size) ? r.size : undefined;
    if (typeof r.panel === "string") {
      if (!(PANEL_IDS as readonly string[]).includes(r.panel)) return null;
      seen.push(r.panel);
      const p: PanelNode = { panel: r.panel as PanelId };
      if (size !== undefined && dir) p.size = Math.max(PANELS[p.panel].min[dir], size);
      return p;
    }
    if ((r.split === "row" || r.split === "col") && Array.isArray(r.items) && r.items.length >= 2) {
      const items = r.items.map((k) => node(k, r.split as Dir));
      if (items.some((k) => !k)) return null;
      const s: SplitNode = { split: r.split, items: items as DockNode[] };
      if (size !== undefined && dir) s.size = Math.max(60, size);
      return s;
    }
    return null;
  };
  const dock = node(o.dock, null);
  if (!dock) return null;
  const floating: FloatRect[] = [];
  for (const f of Array.isArray(o.floating) ? o.floating : []) {
    if (!f || !PANELS[f.panel]?.float || ![f.x, f.y, f.w, f.h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    seen.push(f.panel);
    floating.push({ panel: f.panel, x: f.x, y: f.y, w: f.w, h: f.h });
  }
  if (seen.length !== PANEL_IDS.length || !PANEL_IDS.every((p) => seen.includes(p)) || !contains(dock, "timeline")) return null;
  const lastDock: Layout["lastDock"] = {};
  for (const [k, p] of Object.entries(o.lastDock ?? {})) {
    if ((PANEL_IDS as readonly string[]).includes(k) && p && ["left", "right", "top", "bottom"].includes(p.side)) {
      lastDock[k as PanelId] = { next: p.next, side: p.side, ...(typeof p.size === "number" ? { size: p.size } : {}) };
    }
  }
  return { version: 1, dock: fixFlex(dock, noMeasure), floating, lastDock };
}
