import {
  dockBack,
  dockPanel,
  floatPanel,
  HEAD,
  isFloating,
  moveFloat,
  nodeKey,
  PANELS,
  type Dir,
  type DockNode,
  type FloatRect,
  type Layout,
  type PanelId,
  type Side,
} from "@/lib/layout";
import { useLayout } from "@/stores/layout-store";

/**
 * The dock's plumbing outside React: the host element each panel renders
 * into, the panel actions the menu runs, and following a header drag.
 * `components/Dock.tsx` renders the layout.
 */

export interface PanelState {
  /** Shown at all. A docked Browser stays shown, as its rail. */
  shown: boolean;
  /** Docked as a 26 px rail or strip. */
  collapsed?: boolean;
  /** The menu's Close or Hide. */
  close?: { label: string; run: () => void };
  /** The panel's own options, shown first in its menu: headings and
   * ticked choices. */
  options?: PanelOption[];
}

export type PanelOption = { heading: string } | { label: string; on: boolean; run: () => void };

const hosts: Partial<Record<PanelId, HTMLDivElement>> = {};

/** The element a panel's content renders into, with a portal. */
export function panelHost(id: PanelId): HTMLDivElement {
  let h = hosts[id];
  if (!h) {
    h = document.createElement("div");
    h.className = `dhost dhost-${id}`;
    hosts[id] = h;
  }
  return h;
}

let workEl: HTMLDivElement | null = null;

/** The dock's work area element, set while the dock is mounted. */
export function setWorkEl(el: HTMLDivElement | null) {
  workEl = el;
}
export function getWorkEl(): HTMLDivElement | null {
  return workEl;
}

export const measure = (n: DockNode, dir: Dir): number => {
  const el = workEl?.querySelector(`[data-key="${nodeKey(n)}"]`);
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  return dir === "row" ? r.width : r.height;
};

/** The size along a side's split of a docked panel, or of the window. */
export const spanOf = (target: PanelId | "window", side: Side): number => {
  const el = target === "window" ? workEl : workEl?.querySelector(`.dcell[data-panel="${target}"]`);
  if (!el) return 800;
  const r = el.getBoundingClientRect();
  return side === "left" || side === "right" ? r.width : r.height;
};

function defaultFloat(id: PanelId): Omit<FloatRect, "panel"> {
  const W = workEl?.clientWidth ?? 1200;
  const H = workEl?.clientHeight ?? 700;
  const f = PANELS[id].float ?? { w: 400, h: 300 };
  const w = Math.min(f.w, W - 40);
  const h = Math.min(f.h, H - 40);
  return { x: Math.round(W - w - 24), y: Math.round(H - h - 24), w, h };
}

export const store = useLayout.getState;
export const commit = (l: Layout) => store().set(l);

export const panelActions = {
  float: (id: PanelId) => commit(floatPanel(store().layout, id, defaultFloat(id), measure)),
  dockBack: (id: PanelId) => commit(dockBack(store().layout, id, spanOf, measure)),
  dockTo: (id: PanelId, side: Side) => commit(dockPanel(store().layout, id, "window", side, spanOf("window", side), measure)),
  toggle: (id: PanelId) => {
    if (!PANELS[id].float) return;
    if (isFloating(store().layout, id)) panelActions.dockBack(id);
    else panelActions.float(id);
  },
};

/* ---------- dragging a header ---------- */

interface Target {
  to: PanelId | "window";
  side: Side;
}

const SNAP = 8;
const GUIDE_ICON = (side: Side) => {
  const rot = { left: 180, right: 0, top: -90, bottom: 90 }[side];
  return `<svg viewBox="0 0 16 16" style="transform:rotate(${rot}deg)"><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" opacity=".5"/><rect x="9" y="3" width="5" height="10" fill="var(--knob)"/></svg>`;
};

function el(cls: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  parent.appendChild(d);
  return d;
}

/** Follows a header drag: dock guides on the window's edges and over the
 * panel under the pointer, a preview of where the panel lands, and for a
 * floating panel, snapping to nearby edges. */
export function startDrag(e: { clientX: number; clientY: number }, id: PanelId) {
  const work = workEl;
  if (!work) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const panelEl = work.querySelector<HTMLElement>(`.dcell[data-panel="${id}"], .dfloat[data-float="${id}"]`);
  if (!panelEl) return;
  const floating = panelEl.classList.contains("dfloat");
  const pr = panelEl.getBoundingClientRect();
  const transform0 = panelEl.style.transform;
  const canFloat = !!PANELS[id].float;
  let live = false;
  let x = sx;
  let y = sy;
  let alt = false;
  let raf = 0;
  let target: Target | null = null;
  let fx = 0;
  let fy = 0;
  // Set up when the drag starts.
  let wr = work.getBoundingClientRect();
  let layer: HTMLDivElement;
  let ghost: HTMLDivElement;
  let preview: HTMLDivElement;
  let snapX: HTMLDivElement;
  let snapY: HTMLDivElement;
  let gw = pr.width;
  let gh = pr.height;
  let offX = sx - pr.left;
  let offY = sy - pr.top;
  let others: { id: PanelId; r: DOMRect }[] = [];
  let xs: number[] = [];
  let ys: number[] = [];
  let edge: HTMLElement[] = [];
  let cross: HTMLElement[] = [];
  let crossFor: PanelId | null = null;

  const guide = (gx: number, gy: number, side: Side, cls = "") => {
    const b = el(`dguide ${cls}`, layer);
    b.dataset.side = side;
    b.innerHTML = GUIDE_ICON(side);
    b.style.left = `${gx}px`;
    b.style.top = `${gy}px`;
    return b;
  };

  const begin = () => {
    live = true;
    wr = work.getBoundingClientRect();
    document.body.classList.add("panning");
    store().closeMenu();
    layer = el("dlayer", work);
    preview = el("dpreview", layer);
    preview.appendChild(document.createElement("em"));
    snapX = el("dsnap", layer);
    snapY = el("dsnap", layer);
    if (floating) {
      panelEl.classList.add("moving");
    } else {
      const f = PANELS[id].float;
      gw = f ? Math.min(pr.width, f.w) : Math.min(pr.width, 420);
      gh = f ? Math.min(pr.height, f.h) : Math.min(pr.height, 260);
      offX = Math.min(offX, gw - 24);
      offY = Math.min(offY, HEAD / 2);
      ghost = el("dghost", layer);
      ghost.textContent = PANELS[id].title;
      ghost.style.width = `${gw}px`;
      ghost.style.height = `${gh}px`;
    }
    others = [...work.querySelectorAll<HTMLElement>(".dcell[data-panel]")]
      .filter((p) => p.dataset.panel !== id && !p.classList.contains("collapsed"))
      .map((p) => ({ id: p.dataset.panel as PanelId, r: p.getBoundingClientRect() }));
    xs = [wr.left, wr.right];
    ys = [wr.top, wr.bottom];
    for (const p of work.querySelectorAll<HTMLElement>(".dcell[data-panel], .dfloat")) {
      if (p === panelEl) continue;
      const r = p.getBoundingClientRect();
      xs.push(r.left, r.right);
      ys.push(r.top, r.bottom);
    }
    const W = wr.width;
    const H = wr.height;
    edge = [guide(22, H / 2, "left", "edge"), guide(W - 22, H / 2, "right", "edge"), guide(W / 2, 22, "top", "edge"), guide(W / 2, H - 22, "bottom", "edge")];
  };

  const drawCross = (p: { id: PanelId; r: DOMRect } | null) => {
    cross.forEach((b) => b.remove());
    cross = [];
    crossFor = p ? p.id : null;
    if (!p) return;
    const cx = (p.r.left + p.r.right) / 2 - wr.left;
    const cy = (p.r.top + p.r.bottom) / 2 - wr.top;
    cross = [guide(cx - 36, cy, "left"), guide(cx + 36, cy, "right"), guide(cx, cy - 36, "top"), guide(cx, cy + 36, "bottom")];
  };

  const hit = (list: HTMLElement[]) =>
    list.find((b) => {
      const r = b.getBoundingClientRect();
      return x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3;
    });

  const frame = () => {
    raf = 0;
    const under = others.find((p) => x >= p.r.left && x <= p.r.right && y >= p.r.top && y <= p.r.bottom) ?? null;
    if ((under?.id ?? null) !== crossFor) drawCross(under);
    let h = hit(edge);
    target = null;
    if (h) target = { to: "window", side: h.dataset.side as Side };
    else if ((h = hit(cross)) && crossFor) target = { to: crossFor, side: h.dataset.side as Side };
    for (const b of [...edge, ...cross]) b.classList.toggle("hot", b === h);
    if (target) {
      const t = target;
      const R = t.to === "window" ? wr : others.find((p) => p.id === t.to)!.r;
      const dir: Dir = t.side === "left" || t.side === "right" ? "row" : "col";
      const sz = Math.max(PANELS[id].min[dir], Math.min(PANELS[id].size[dir], (dir === "row" ? R.width : R.height) / 2));
      let l = R.left;
      let tp = R.top;
      let w = R.width;
      let hh = R.height;
      if (t.side === "left") w = sz;
      if (t.side === "right") {
        l = R.right - sz;
        w = sz;
      }
      if (t.side === "top") hh = sz;
      if (t.side === "bottom") {
        tp = R.bottom - sz;
        hh = sz;
      }
      Object.assign(preview.style, { display: "block", left: `${l - wr.left}px`, top: `${tp - wr.top}px`, width: `${w}px`, height: `${hh}px` });
      const name = PANELS[id].title;
      preview.firstElementChild!.textContent =
        t.to === "window"
          ? `Dock ${name} on the ${t.side} edge`
          : `Dock ${name} ${t.side === "top" ? "above" : t.side === "bottom" ? "below" : `to the ${t.side} of`} ${PANELS[t.to].title}`;
    } else preview.style.display = "none";

    // The floating rect, kept inside the work area and snapped.
    const fw = floating ? pr.width : gw;
    const fh = floating ? pr.height : gh;
    let L = Math.max(wr.left, Math.min(x - offX, wr.right - fw));
    let T = Math.max(wr.top, Math.min(y - offY, wr.bottom - fh));
    let lx: number | null = null;
    let ly: number | null = null;
    if (!alt) {
      for (const v of xs) {
        if (Math.abs(L - v) < SNAP) [L, lx] = [v, v];
        else if (Math.abs(L + fw - v) < SNAP) [L, lx] = [v - fw, v];
        if (lx !== null) break;
      }
      for (const v of ys) {
        if (Math.abs(T - v) < SNAP) [T, ly] = [v, v];
        else if (Math.abs(T + fh - v) < SNAP) [T, ly] = [v - fh, v];
        if (ly !== null) break;
      }
    }
    const showLine = (s: HTMLDivElement, on: boolean, l: number, t: number, w: number, hh: number) => {
      if (!on) s.style.display = "none";
      else Object.assign(s.style, { display: "block", left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${hh}px` });
    };
    const floats = floating || canFloat;
    showLine(snapX, lx !== null && !target && floats, (lx ?? 0) - wr.left, 0, 1, wr.height);
    showLine(snapY, ly !== null && !target && floats, 0, (ly ?? 0) - wr.top, wr.width, 1);
    fx = Math.round(L - wr.left);
    fy = Math.round(T - wr.top);
    if (floating) panelEl.style.transform = `translate3d(${fx}px, ${fy}px, 0)`;
    else {
      ghost.style.transform = `translate3d(${fx}px, ${fy}px, 0)`;
      ghost.style.opacity = target ? "0.35" : canFloat ? "1" : "0.5";
    }
  };

  const onMove = (ev: PointerEvent) => {
    if (!live) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      begin();
    }
    x = ev.clientX;
    y = ev.clientY;
    alt = ev.altKey;
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (!live) return;
    cancelAnimationFrame(raf);
    if (drop) frame();
    layer.remove();
    document.body.classList.remove("panning");
    panelEl.classList.remove("moving");
    const l = store().layout;
    if (drop && target) {
      const t = target;
      commit(dockPanel(l, id, t.to, t.side, spanOf(t.to, t.side), measure));
    } else if (drop && floating) commit(moveFloat(l, id, { x: fx, y: fy, w: Math.round(pr.width), h: Math.round(pr.height) }));
    else if (drop && canFloat) commit(floatPanel(l, id, { x: fx, y: fy, w: Math.round(gw), h: Math.round(gh) }, measure));
    else if (floating) panelEl.style.transform = transform0;
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
