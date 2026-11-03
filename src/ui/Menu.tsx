import { type ReactNode, type Ref, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MenuAt } from "@/lib/popup";
import { useDismiss } from "./dismiss";

/* Menus: the box (`Menu`), placed under its button by the caller's class
 * or at a point (`PopMenu`), filled with `MenuItem` rows, `MenuLabel`
 * group names, `MenuSep` lines and `MenuNote` text. */

/** The menu box. Where it sits is its `className`'s job (`.menu` drops
 * under the button it follows; `PopMenu` places it at a point). */
export function Menu({
  title,
  head,
  className = "",
  menuRef,
  style,
  children,
}: {
  /** A bold heading row. */
  title?: ReactNode;
  /** A heading row of its own, in place of `title`. */
  head?: ReactNode;
  className?: string;
  menuRef?: Ref<HTMLDivElement>;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={`menu ${className}`} role="menu" ref={menuRef} style={style} onContextMenu={(e) => e.preventDefault()}>
      {(title || head) && <div className="menu-head">{head ?? <b className="menu-title">{title}</b>}</div>}
      {children}
    </div>
  );
}

/** A context menu at a point, kept inside the window; a click outside or
 * Escape closes it. */
export function PopMenu({
  at,
  title,
  className = "",
  onClose,
  children,
}: {
  at: MenuAt;
  title?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuAt | null>(null);
  useDismiss(true, ref, onClose);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)),
    });
  }, [at]);
  return createPortal(
    <Menu
      title={title}
      className={`ctx ${className}`}
      menuRef={ref}
      style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y, visibility: pos ? undefined : "hidden" }}
    >
      {children}
    </Menu>,
    document.body,
  );
}

/** One menu row. `run` closes the menu first (through `close`) unless
 * `keep` is set. A ticked or tickable option passes `checked`; options of
 * which one is picked pass `radio` too. */
export function MenuItem({
  label,
  keys,
  run,
  close,
  disabled = false,
  checked,
  radio = false,
  keep = false,
  hint,
  tip,
  onContextMenu,
}: {
  label: ReactNode;
  keys?: string;
  run: () => void;
  close?: () => void;
  disabled?: boolean;
  /** A tick column: true ticked, false unticked, undefined none. */
  checked?: boolean;
  radio?: boolean;
  keep?: boolean;
  hint?: string;
  tip?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      className={`menu-item${checked !== undefined ? " tickable" : ""}`}
      role={checked === undefined ? "menuitem" : radio ? "menuitemradio" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      data-hint={hint}
      data-tip={tip}
      onContextMenu={onContextMenu}
      onClick={() => {
        if (!keep) close?.();
        run();
      }}
    >
      <span className="mil">
        {checked !== undefined && <span className="tick">{checked ? "✓" : ""}</span>}
        {label}
      </span>
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
}

/** A group's name, in faint capitals. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-h">{children}</div>;
}

export function MenuSep() {
  return <div className="menu-sep" />;
}

/** A line of text in a menu: an explanation, an empty state, a warning. */
export function MenuNote({ warn = false, children }: { warn?: boolean; children: ReactNode }) {
  return <div className={`menu-note${warn ? " warn" : ""}`}>{children}</div>;
}
