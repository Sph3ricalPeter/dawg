import { useEffect, useRef, useState } from "react";
import { devBuild, type AppInfo } from "@/lib/app-info";
import { api, type RecentProject } from "@/lib/api";
import {
  exportDialog,
  newProject,
  openFileDialog,
  openRecent,
  restoreLastReplace,
  saveProject,
  saveProjectAs,
} from "@/lib/actions";
import { useSession } from "@/stores/session-store";
import { updateLine, useUpdaterStore } from "@/stores/updater-store";
import { DawgMark } from "./DawgMark";

/** The logo button and its menu. */
export function AppMenu({ info }: { info: AppInfo | null }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const status = useUpdaterStore((s) => s.status);
  const lastChecked = useUpdaterStore((s) => s.lastChecked);
  const checkNow = useUpdaterStore((s) => s.checkNow);

  useEffect(() => {
    if (!open) return;
    void api
      .recentProjects()
      .then((r) => setRecent(r.filter((p) => p.exists).slice(0, 5)))
      .catch(() => setRecent([]));
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
  const scratch = useSession((s) => !!s.session?.scratch);
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
        {info?.channel === "dev" && (
          <span className="pill" title={`dawg dev ${info.version}`}>
            dev {devBuild(info)}
          </span>
        )}
        <span className="car">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <b>dawg {info?.version}</b>
            <span className="faint">{updateLine(status, lastChecked)}</span>
          </div>
          <div className="menu-h">File</div>
          {item("New project", "Ctrl+N", newProject)}
          {item("Open…", "Ctrl+O", () => void openFileDialog())}
          {!scratch && item("Save", "Ctrl+S", () => void saveProject(), !hasFile)}
          {item("Save as project…", "Ctrl+Shift+S", () => void saveProjectAs(), !hasFile)}
          {item("Export…", scratch ? "Ctrl+S" : "Ctrl+R", () => void exportDialog(), !hasFile)}
          {item("Restore last replace", "", () => void restoreLastReplace())}
          {recent.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-h">Recent projects</div>
              {recent.map((r) => (
                <button
                  key={r.path}
                  className="menu-item"
                  role="menuitem"
                  title={r.path}
                  onClick={() => {
                    setOpen(false);
                    void openRecent(r.path);
                  }}
                >
                  {r.name}
                </button>
              ))}
            </>
          )}
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
