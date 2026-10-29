import { useEffect, useRef, useState } from "react";
import type { AppInfo } from "@/lib/app-info";
import { exportDialog, openFileDialog, restoreLastReplace } from "@/lib/actions";
import { useSession } from "@/stores/session-store";
import { updateLine, useUpdaterStore } from "@/stores/updater-store";
import { DawgMark } from "./DawgMark";

/** The logo button and its menu. */
export function AppMenu({ info }: { info: AppInfo | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const status = useUpdaterStore((s) => s.status);
  const lastChecked = useUpdaterStore((s) => s.lastChecked);
  const checkNow = useUpdaterStore((s) => s.checkNow);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const canCheck = status === "idle" || status === "error";
  const hasFile = useSession((s) => !!s.session);
  const item = (label: string, keys: string, run: () => void, disabled = false) => (
    <button
      className="menu-item"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {label}
      {keys && <kbd>{keys}</kbd>}
    </button>
  );

  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`logo${open ? " open" : ""}`} onClick={() => setOpen(!open)} title="Menu">
        <DawgMark className="mark" />
        dawg
        {info?.channel === "dev" && <span className="pill">dev</span>}
        <span className="car">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <b>dawg {info?.version}</b>
            <span className="faint">{updateLine(status, lastChecked)}</span>
          </div>
          {item("Open…", "Ctrl+O", () => void openFileDialog())}
          {item("Export…", "Ctrl+S", () => void exportDialog(), !hasFile)}
          {item("Restore last replace", "", () => void restoreLastReplace())}
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            disabled={!canCheck}
            onClick={() => {
              void checkNow();
              setOpen(false);
            }}
          >
            Check for updates
          </button>
        </div>
      )}
    </div>
  );
}
