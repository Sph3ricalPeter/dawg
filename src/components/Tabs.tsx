import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { newProject } from "@/lib/actions";
import type { TabInfo } from "@/lib/api";
import { useSession } from "@/stores/session-store";

/** Tab widths: they share the room left of the transport, from the widest
 * down to the narrowest; past that the row scrolls to keep the front tab in
 * view and a list button names them all. */
const MAX_W = 180;
const MIN_W = 104;
/** Below this a scratch tab's pill shrinks to "S". */
const PILL_W = 170;
const ADD_W = 28;
const MORE_W = 64;
/** What hiding the menu's "dawg" wordmark gives the tabs. */
const WORDMARK_W = 36;

/** A tab as shown: `file` is the file's own name, `name` the label the
 * user gave it if any. */
type ShownTab = TabInfo & { file: string };

/** The open tabs with the front one as it is now (name, unsaved edits). */
function useShownTabs(): ShownTab[] {
  const tabs = useSession((s) => s.tabs);
  const active = useSession((s) => s.activeTab);
  const labels = useSession((s) => s.labels);
  const name = useSession((s) => s.session?.name);
  const dirty = useSession((s) => !!s.session?.dirty);
  const path = useSession((s) => s.session?.path ?? s.session?.project ?? null);
  return tabs.map((t) => {
    const now = t.id === active && name !== undefined ? { ...t, name, dirty, path } : t;
    return { ...now, file: now.name, name: labels[t.id] ?? now.name };
  });
}

/** Renaming a tab in place: Enter or leaving keeps it, Esc doesn't. */
function RenameField({ tab, done }: { tab: ShownTab; done: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (keep: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const v = ref.current?.value.trim() ?? "";
    // Cleared, or back to the file's name: the label goes.
    if (keep) useSession.getState().renameTab(tab.id, v && v !== tab.file ? v : null);
    done();
  };
  return (
    <input
      ref={ref}
      className="tabname"
      defaultValue={tab.name}
      aria-label="Tab name"
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** The session tabs in the title bar, where the file name used to be. */
export function Tabs({ tight: shrunk, onTight }: { tight: boolean; onTight: (tight: boolean) => void }) {
  const tabs = useShownTabs();
  const active = useSession((s) => s.activeTab);
  const row = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  // A tab being dragged along the row: its id, where the pointer went
  // down, and the order it would leave.
  const drag = useRef<{ id: number; x: number; moved: boolean; pointer: number } | null>(null);
  const [order, setOrder] = useState<number[] | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    setRoom(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const n = Math.max(1, tabs.length);
  // The wordmark gives way when tabs run short of room; decided as if it
  // were shown, so hiding it doesn't undo the decision.
  const full = room - (shrunk ? WORDMARK_W : 0);
  const tight = tabs.length > 1 && (full - ADD_W - 2) / n < MIN_W + 16;
  let w = Math.floor((room - ADD_W - 2) / n);
  let over = false;
  let fit = tabs.length;
  if (w < MIN_W && tabs.length > 1) {
    over = true;
    const room2 = room - ADD_W - MORE_W - 2;
    fit = Math.max(1, Math.floor(room2 / MIN_W));
    w = Math.floor(room2 / fit);
  }
  w = Math.max(84, Math.min(MAX_W, w));

  useEffect(() => onTight(tight), [tight, onTight]);

  // Keeps the front tab in view when the row scrolls.
  useLayoutEffect(() => {
    const l = list.current;
    const a = l?.querySelector<HTMLElement>(".stab.on");
    if (!l || !a) return;
    if (a.offsetLeft < l.scrollLeft) l.scrollLeft = a.offsetLeft;
    else if (a.offsetLeft + a.offsetWidth > l.scrollLeft + l.clientWidth) l.scrollLeft = a.offsetLeft + a.offsetWidth - l.clientWidth;
  }, [active, w, tabs.length, over]);

  useEffect(() => {
    if (!listOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest(".tabmore-wrap")) setListOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [listOpen]);

  const store = useSession.getState;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const shown = order ? order.map((id) => byId.get(id)).filter((t): t is ShownTab => !!t) : tabs;

  const onPointerDown = (e: React.PointerEvent, t: ShownTab) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".x")) return;
    void store().switchTab(t.id);
    drag.current = { id: t.id, x: e.clientX, moved: false, pointer: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const l = list.current;
    if (!d || !l || e.pointerId !== d.pointer) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < 5) return;
    if (!d.moved) setDragId(d.id);
    d.moved = true;
    // Where the pointer is among the other tabs' middles.
    const others = [...l.querySelectorAll<HTMLElement>(".stab")].filter((el) => Number(el.dataset.id) !== d.id);
    let at = 0;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2) at++;
    }
    const ids = others.map((el) => Number(el.dataset.id));
    ids.splice(at, 0, d.id);
    setOrder((o) => (o && o.join() === ids.join() ? o : ids));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragId(null);
    if (d?.moved && order) {
      const index = order.indexOf(d.id);
      void store()
        .moveTab(d.id, index)
        .finally(() => setOrder(null));
    } else {
      setOrder(null);
    }
  };

  return (
    <div className={`tabs${over ? " over" : ""}`} ref={row}>
      {tabs.length === 0 ? (
        <span className="notab faint">No file open</span>
      ) : (
        <div className="tlist" ref={list} role="tablist" style={over ? { maxWidth: fit * w } : undefined}>
          {shown.map((t) => {
            const on = t.id === active;
            return (
              <div
                key={t.id}
                data-id={t.id}
                role="tab"
                aria-selected={on}
                className={`stab${on ? " on" : ""}${t.dirty ? " dirty" : ""}${dragId === t.id ? " drag" : ""}`}
                style={{ width: w }}
                data-tip={`${t.name !== t.file ? `${t.file} · ` : ""}${t.path ?? "Not saved yet"}${t.dirty ? " · unsaved changes" : ""} · double-click to rename`}
                onPointerDown={(e) => onPointerDown(e, t)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => {
                  if (e.button === 1) void store().closeTab(t.id);
                }}
                onDoubleClick={(e) => {
                  if (!(e.target as HTMLElement).closest(".x")) setEditing(t.id);
                }}
              >
                {editing === t.id ? (
                  <RenameField tab={t} done={() => setEditing(null)} />
                ) : (
                  <span className="nm">
                    {t.name}
                    {on && t.dirty && <span className="dot"> •</span>}
                  </span>
                )}
                {t.scratch && <span className="pill">{w < PILL_W ? "S" : "Scratch"}</span>}
                <span className="gap" />
                <button
                  className="x"
                  aria-label={`Close ${t.name}`}
                  data-tip="Close tab (Ctrl+W)"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void store().closeTab(t.id)}
                >
                  {t.dirty && <i />}
                  <svg viewBox="0 0 10 10">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {over && (
        <div className="tabmore-wrap">
          <button className="tmore" data-tip="All open tabs" onClick={() => setListOpen(!listOpen)}>
            {tabs.length} tabs<span className="car">▾</span>
          </button>
          {listOpen && (
            <div className="menu" role="menu">
              {tabs.map((t, i) => (
                <button
                  key={t.id}
                  className={`menu-item${t.id === active ? " on" : ""}`}
                  role="menuitem"
                  onClick={() => {
                    setListOpen(false);
                    void store().switchTab(t.id);
                  }}
                >
                  {t.name}
                  {t.dirty ? " •" : ""}
                  {i < 9 && <kbd>Ctrl+{i + 1}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button className="tadd" aria-label="New project" data-tip="New project in a new tab (Ctrl+N)" onClick={newProject}>
        <svg viewBox="0 0 10 10">
          <path d="M5 1v8M1 5h8" />
        </svg>
      </button>
    </div>
  );
}
