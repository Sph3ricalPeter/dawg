import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MenuAt } from "@/lib/popup";

/** A context menu at a point, kept inside the window; a click outside or
 * Escape closes it. Fill it with `menu-item` buttons (see `MenuItem`). */
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
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);
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
    <div
      className={`menu ctx ${className}`}
      role="menu"
      ref={ref}
      style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y, visibility: pos ? undefined : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && (
        <div className="menu-head">
          <b className="menu-title">{title}</b>
        </div>
      )}
      {children}
    </div>,
    document.body,
  );
}

/** One menu row. `run` closes the menu first unless `keep` is set. */
export function MenuItem({
  label,
  keys,
  run,
  close,
  disabled = false,
  checked,
  keep = false,
  hint,
}: {
  label: ReactNode;
  keys?: string;
  run: () => void;
  close: () => void;
  disabled?: boolean;
  /** A tick column: true ticked, false unticked, undefined none. */
  checked?: boolean;
  keep?: boolean;
  hint?: string;
}) {
  return (
    <button
      className={`menu-item${checked !== undefined ? " tickable" : ""}`}
      role={checked !== undefined ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checked}
      disabled={disabled}
      data-hint={hint}
      onClick={() => {
        if (!keep) close();
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
