import { useEffect, useRef, useState } from "react";
import { devBuild, type AppInfo } from "@/lib/app-info";
import { api, type RecentProject } from "@/lib/api";
import {
  closeFrontTab,
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
import { useDismiss } from "@/ui/dismiss";
import { Menu, MenuItem, MenuLabel, MenuSep } from "@/ui/Menu";

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
  }, [open]);
  useDismiss(open, ref, () => setOpen(false));

  const canCheck = status === "idle" || status === "error";
  const hasFile = useSession((s) => !!s.session);
  const scratch = useSession((s) => !!s.session?.scratch);
  const close = () => setOpen(false);
  const item = (label: string, keys: string, run: () => void, disabled = false) => (
    <MenuItem label={label} keys={keys} run={run} close={close} disabled={disabled} />
  );

  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`logo${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-label="Menu" data-tip="Menu">
        <DawgMark className="mark" />
        <span className="lw">dawg</span>
        {info?.channel === "dev" && (
          <span className="pill" data-tip={`dawg dev ${info.version}`}>
            dev {devBuild(info)}
          </span>
        )}
        <span className="car">▾</span>
      </button>
      {open && (
        <Menu
          head={
            <>
              <b>dawg {info?.version}</b>
              <span className="faint">{updateLine(status, lastChecked)}</span>
            </>
          }
        >
          <MenuLabel>File</MenuLabel>
          {item("New project", "Ctrl+N", newProject)}
          {item("Open…", "Ctrl+O", () => void openFileDialog())}
          {!scratch && item("Save", "Ctrl+S", () => void saveProject(), !hasFile)}
          {item("Save as project…", "Ctrl+Shift+S", () => void saveProjectAs(), !hasFile)}
          {item("Export…", scratch ? "Ctrl+S" : "Ctrl+R", () => void exportDialog(), !hasFile)}
          {item("Close tab", "Ctrl+W", closeFrontTab, !hasFile)}
          {item("Restore last replace", "", () => void restoreLastReplace())}
          {recent.length > 0 && (
            <>
              <MenuSep />
              <MenuLabel>Recent projects</MenuLabel>
              {recent.map((r) => (
                <MenuItem key={r.path} label={r.name} tip={r.path} run={() => void openRecent(r.path)} close={close} />
              ))}
            </>
          )}
          <MenuSep />
          <MenuItem label="Check for updates" disabled={!canCheck} run={() => void checkNow()} close={close} />
        </Menu>
      )}
    </div>
  );
}
