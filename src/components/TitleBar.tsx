import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import type { AppInfo } from "@/lib/app-info";
import { AppMenu } from "./AppMenu";
import { UpdateIndicator } from "./UpdateIndicator";

function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  if (!isTauri()) return;
  void getCurrentWindow()[action]();
}

/** Custom title bar: the window has no native frame (Windows 11 still rounds it). */
export function TitleBar({ info }: { info: AppInfo | null }) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tleft">
        <AppMenu info={info} />
      </div>
      <div className="tfill" data-tauri-drag-region />
      <div className="tright">
        <UpdateIndicator />
        <div className="winctl">
          <button aria-label="Minimize" onClick={() => windowAction("minimize")}>
            <svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg>
          </button>
          <button aria-label="Maximize" onClick={() => windowAction("toggleMaximize")}>
            <svg viewBox="0 0 10 10"><path d="M.5.5h9v9h-9z" /></svg>
          </button>
          <button className="close" aria-label="Close" onClick={() => windowAction("close")}>
            <svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0 0 10" /></svg>
          </button>
        </div>
      </div>
    </header>
  );
}
