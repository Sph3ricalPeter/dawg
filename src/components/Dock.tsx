import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { commit, panelActions, panelHost, setWorkEl, getWorkEl, startDrag, store, type PanelState } from "@/lib/dock";
import { clampFloat, HEAD, isFloating, moveFloat, nodeKey, PANELS, panelsIn, PRESETS, setSizeAt, type Dir, type DockNode, type FloatRect, type PanelId, type PresetName, type Side } from "@/lib/layout";
import { useLayout } from "@/stores/layout-store";

/**
 * The work area between the title bar and the status bar: docked panels in
 * splits, floating panels above them, and the drag guides. Each panel's
 * content renders once into a host element of its own (see `panelHost`)
 * that moves between slots, so docking or floating a panel never remounts
 * it: the Timeline keeps its scroll and canvases.
 *
 * Moving and resizing run outside React on the frame: a floating panel
 * moves by transform, a separator sets flex-basis. The layout store, and
 * settings.json, change once, on pointer up.
 */

function Slot({ id }: { id: PanelId }) {
  return (
    <div
      className="dslot"
      ref={(el) => {
        if (!el) return;
        const h = panelHost(id);
        if (h.parentElement !== el) el.appendChild(h);
      }}
    />
  );
}

/** Whether a subtree has anything to show. */
function visible(n: DockNode, panels: Record<PanelId, PanelState>): boolean {
  return "panel" in n ? panels[n.panel].shown : n.items.some((k) => visible(k, panels));
}

function Cell({ n, path, dir, panels }: { n: DockNode; path: number[]; dir: Dir | null; panels: Record<PanelId, PanelState> }) {
  if ("panel" in n) {
    const col = !!panels[n.panel].collapsed;
    return (
      <div className={`dcell${col ? " collapsed" : ""}${col && dir === "col" ? " strip" : ""}`} data-key={n.panel} data-panel={n.panel}>
        <Slot id={n.panel} />
      </div>
    );
  }
  const kids = n.items.map((k, i) => ({ k, i })).filter(({ k }) => visible(k, panels));
  // The one that takes the rest; if it is hidden, the last one shown.
  let flex = kids.findIndex(({ k }) => k.size === undefined);
  if (flex < 0) flex = kids.length - 1;
  const out: React.ReactNode[] = [];
  kids.forEach(({ k, i }, j) => {
    const col = "panel" in k && !!panels[k.panel].collapsed;
    if (j > 0) {
      const prev = kids[j - 1];
      const prevCol = "panel" in prev.k && !!panels[prev.k.panel].collapsed;
      out.push(<Separator key={`z${i}`} dir={n.split} a={[...path, prev.i]} b={[...path, i]} flexA={j - 1 === flex} off={col || prevCol} />);
    }
    // Panels shrink below their saved size before the Timeline goes under
    // its minimum, but not below their own.
    const keys = panelsIn(k);
    const min = col ? HEAD : PANELS[keys.includes("timeline") ? "timeline" : keys[0]].min[n.split];
    const style: React.CSSProperties = {
      flex: col ? `0 0 ${HEAD}px` : j === flex ? "1 1 0" : `0 1 ${k.size}px`,
      [n.split === "row" ? "minWidth" : "minHeight"]: min,
    };
    out.push(
      <div key={nodeKey(k)} className="dflex" style={style}>
        <Cell n={k} path={[...path, i]} dir={n.split} panels={panels} />
      </div>,
    );
  });
  return (
    <div className={`dcell dsplit ${n.split}`} data-key={nodeKey(n)}>
      {out}
    </div>
  );
}

/** The 1 px line between two docked panels: drag to resize. The one that
 * keeps a size changes; the Timeline's side takes the rest. */
function Separator({ dir, a, b, flexA, off }: { dir: Dir; a: number[]; b: number[]; flexA: boolean; off: boolean }) {
  return (
    <div
      className={`dsep ${dir}${off ? " off" : ""}`}
      data-hint="Drag to resize the panels"
      onPointerDown={(e) => {
        if (e.button !== 0 || off) return;
        e.preventDefault();
        const z = e.currentTarget;
        const prev = z.previousElementSibling as HTMLElement | null;
        const next = z.nextElementSibling as HTMLElement | null;
        if (!prev || !next) return;
        const fixed = flexA ? next : prev;
        const other = flexA ? prev : next;
        const fixedPath = flexA ? b : a;
        const sign = flexA ? -1 : 1;
        const len = (el: HTMLElement) => (dir === "row" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);
        const s0 = len(fixed);
        const flex0 = fixed.style.flex;
        const o0 = len(other);
        // Minimums from the panel each side is named after.
        const minOf = (el: HTMLElement) => {
          const key = ((el.firstElementChild as HTMLElement | null)?.dataset.key ?? "timeline").split("+");
          return PANELS[key.includes("timeline") ? "timeline" : (key[0] as PanelId)].min[dir];
        };
        const minF = minOf(fixed);
        const minO = minOf(other);
        const start = dir === "row" ? e.clientX : e.clientY;
        z.setPointerCapture(e.pointerId);
        z.classList.add("on");
        document.body.classList.add(dir === "row" ? "sizing" : "sizing-v");
        let size = s0;
        let raf = 0;
        const move = (ev: PointerEvent) => {
          const d = ((dir === "row" ? ev.clientX : ev.clientY) - start) * sign;
          size = Math.round(Math.max(minF, Math.min(s0 + d, s0 + o0 - minO)));
          if (!raf)
            raf = requestAnimationFrame(() => {
              raf = 0;
              fixed.style.flex = `0 1 ${size}px`;
            });
        };
        const up = (ev: PointerEvent) => {
          cancelAnimationFrame(raf);
          z.removeEventListener("pointermove", move);
          z.removeEventListener("pointerup", up);
          z.removeEventListener("pointercancel", up);
          z.classList.remove("on");
          document.body.classList.remove("sizing", "sizing-v");
          if (ev.type === "pointerup" && size !== s0) commit(setSizeAt(store().layout, fixedPath, size));
          else fixed.style.flex = flex0;
        };
        z.addEventListener("pointermove", move);
        z.addEventListener("pointerup", up);
        z.addEventListener("pointercancel", up);
      }}
    />
  );
}

function Float({ f, work }: { f: FloatRect; work: { w: number; h: number } }) {
  const r = clampFloat(f, work.w, work.h);
  return (
    <div
      className="dfloat"
      data-float={f.panel}
      style={{ width: r.w, height: r.h, transform: `translate3d(${r.x}px, ${r.y}px, 0)` }}
    >
      <Slot id={f.panel} />
      <div
        className="dgrow"
        data-hint="Drag to resize"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const g = e.currentTarget;
          const box = g.parentElement!;
          const sx = e.clientX;
          const sy = e.clientY;
          let w = r.w;
          let h = r.h;
          let raf = 0;
          g.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => {
            w = Math.round(Math.max(240, Math.min(r.w + ev.clientX - sx, work.w - r.x)));
            h = Math.round(Math.max(140, Math.min(r.h + ev.clientY - sy, work.h - r.y)));
            if (!raf)
              raf = requestAnimationFrame(() => {
                raf = 0;
                box.style.width = `${w}px`;
                box.style.height = `${h}px`;
              });
          };
          const up = () => {
            cancelAnimationFrame(raf);
            g.removeEventListener("pointermove", move);
            g.removeEventListener("pointerup", up);
            g.removeEventListener("pointercancel", up);
            commit(moveFloat(store().layout, f.panel, { ...r, w, h }));
          };
          g.addEventListener("pointermove", move);
          g.addEventListener("pointerup", up);
          g.addEventListener("pointercancel", up);
        }}
      />
    </div>
  );
}

export function Dock({ panels }: { panels: Record<PanelId, PanelState> }) {
  const layout = useLayout((s) => s.layout);
  const ref = useRef<HTMLDivElement>(null);
  const [work, setWork] = useState({ w: 1200, h: 700 });
  useLayoutEffect(() => {
    const el = ref.current!;
    setWorkEl(el);
    const read = () => setWork({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (getWorkEl() === el) setWorkEl(null);
    };
  }, []);
  return (
    <div className="dock" ref={ref}>
      <div className="dflex" style={{ flex: "1 1 0" }}>
        <Cell n={layout.dock} path={[]} dir={null} panels={panels} />
      </div>
      {layout.floating
        .filter((f) => panels[f.panel].shown)
        .map((f) => (
          <Float key={f.panel} f={f} work={work} />
        ))}
      <PanelMenu panels={panels} />
    </div>
  );
}

/** A panel's header: drag it to dock or float the panel, right-click or ⋯
 * for the menu, double-click to float it or dock it back. */
export function PanelHead({
  id,
  className,
  children,
}: {
  id: PanelId;
  className?: string;
  children: React.ReactNode;
}) {
  const interactive = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest("button, input, select, a, [data-nodrag]");
  return (
    <div
      className={`phead${className ? ` ${className}` : ""}`}
      data-panelhead={id}
      data-hint={
        PANELS[id].float
          ? "Drag to move the panel · right-click for dock options · double-click to float or dock it back"
          : "Drag to move the timeline to another side · right-click for options"
      }
      onPointerDown={(e) => {
        if (e.button !== 0 || interactive(e.target)) return;
        startDrag(e, id);
      }}
      onDoubleClick={(e) => {
        if (interactive(e.target)) return;
        panelActions.toggle(id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        store().openMenu(id, e.clientX, e.clientY);
      }}
    >
      {children}
      <button
        className="pmore"
        aria-label={`${PANELS[id].title} options`}
        data-tip="Panel options"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          store().openMenu(id, r.right - 200, r.bottom + 2);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

function PanelMenu({ panels }: { panels: Record<PanelId, PanelState> }) {
  const menu = useLayout((s) => s.menu);
  const preset = useLayout((s) => s.preset);
  const layout = useLayout((s) => s.layout);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) store().closeMenu();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)) });
  }, [menu]);
  if (!menu) return null;
  const id = menu.panel;
  const fl = isFloating(layout, id);
  const p = panels[id];
  const item = (label: string, run: () => void, keys?: string, on?: boolean) => (
    <button
      className={`menu-item${on ? " checked" : ""}`}
      role="menuitem"
      onClick={() => {
        store().closeMenu();
        run();
      }}
    >
      {label}
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
  const sides: Side[] = ["left", "right", "top", "bottom"];
  return (
    <div
      className="menu ctx pmenu"
      role="menu"
      ref={ref}
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? undefined : "hidden" }}
    >
      <div className="menu-head">
        <b className="menu-title">{PANELS[id].title}</b>
      </div>
      {PANELS[id].float && (fl ? item("Dock back", () => panelActions.dockBack(id), "Double-click") : item("Float", () => panelActions.float(id), "Double-click"))}
      <div className="menu-h">Dock to the window's edge</div>
      {sides.map((s) => (
        <span key={s}>{item(s[0].toUpperCase() + s.slice(1), () => panelActions.dockTo(id, s))}</span>
      ))}
      {p.close && (
        <>
          <div className="menu-sep" />
          {item(p.close.label, p.close.run)}
        </>
      )}
      <div className="menu-sep" />
      <div className="menu-h">Layout</div>
      {(Object.keys(PRESETS) as PresetName[]).map((k) => (
        <span key={k}>{item(PRESETS[k].label, () => store().applyPreset(k), undefined, preset === k)}</span>
      ))}
    </div>
  );
}

