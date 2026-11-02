import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import type { AppInfo } from "@/lib/app-info";
import { exportDialog, requestClose } from "@/lib/actions";
import { useBrowser } from "@/stores/browser-store";
import { useCallback, useState } from "react";
import { useSession } from "@/stores/session-store";
import { Tabs } from "./Tabs";
import { AppMenu } from "./AppMenu";
import { HistoryPanel } from "./HistoryPanel";
import { stepText } from "@/lib/history";
import { Master } from "./Master";
import { Bpm, Lcd, TimelineMenu } from "./TimeControls";
import { UpdateIndicator } from "./UpdateIndicator";

function windowAction(action: "minimize" | "toggleMaximize") {
  if (!isTauri()) return;
  void getCurrentWindow()[action]();
}

function BrowserToggle() {
  const scratch = useSession((s) => !!s.session?.scratch);
  const open = useBrowser((s) => (scratch ? s.openScratch : s.open));
  return (
    <button
      className={`tb${open ? " on" : ""}`}
      id="tBrowser"
      aria-label="Browser"
      data-tip="Browser (Ctrl+Alt+B)"
      onClick={() => useBrowser.getState().toggle()}
    >
      <svg viewBox="0 0 16 16">
        <path d="M2 3h12v10H2zM3.5 4.5v7h3v-7z" />
      </svg>
    </button>
  );
}

function Transport() {
  const session = useSession((s) => s.session);
  const playing = useSession((s) => s.playing);
  const loop = useSession((s) => s.loop);
  const hasRange = useSession((s) => !!s.range);
  const canUndo = useSession((s) => !!s.session?.canUndo);
  const canRedo = useSession((s) => !!s.session?.canRedo);
  // The step each button would take: the last edit, and the next undone one.
  const undoLabel = useSession((s) =>
    s.session?.canUndo ? stepText(s.session.history.at(-1)) : undefined,
  );
  const redoLabel = useSession((s) =>
    s.session?.canRedo ? stepText(s.session.future[0]) : undefined,
  );
  const historyOpen = useSession((s) => s.historyOpen);
  const mixerOpen = useSession((s) => s.mixerOpen);
  const store = useSession.getState;
  return (
    <div className="transport">
      <div className="tg">
        <BrowserToggle />
      </div>
      <div className="tg">
        <button
          className={`tb${playing ? " on" : ""}`}
          id="tPlay"
          aria-label={playing ? "Stop" : "Play"}
          data-tip="Play / stop (Space)"
          disabled={!session}
          onClick={() => void store().togglePlay()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
        </button>
        <button
          className="tb"
          aria-label="Stop and return"
          data-tip="Stop and return to where playback started"
          disabled={!session}
          onClick={() => {
            void store().stop();
          }}
        >
          <svg viewBox="0 0 16 16">
            <path d="M3.5 3.5h9v9h-9z" />
          </svg>
        </button>
        <button
          className={`tb${loop ? " on" : ""}`}
          aria-label="Loop"
          aria-pressed={loop}
          data-tip={`Loop (L) · ${hasRange ? "the range" : "from 0 to the end of the last clip"}`}
          disabled={!session}
          onClick={() => store().toggleLoop()}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M4 5.5h7.5a2 2 0 0 1 2 2v.5M12 10.5H4.5a2 2 0 0 1-2-2V8M9.5 3.5l2 2-2 2M6.5 12.5l-2-2 2-2" />
          </svg>
        </button>
      </div>
      <div className="tg">
        <Lcd />
      </div>
      {session && !session.scratch && (
        <div className="tg">
          <Bpm />
        </div>
      )}
      <TimelineMenu />
      <Master />
      <div className="tg">
        <button
          className={`tb hb${mixerOpen ? " on" : ""}`}
          aria-label="Mixer"
          data-tip="Mixer (F9)"
          disabled={!session}
          onClick={() => store().toggleMixer()}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M4 2.5v11M8 2.5v11M12 2.5v11" />
            <path d="M2.5 10h3M6.5 5.5h3M10.5 8.5h3" strokeWidth="2.2" />
          </svg>
        </button>
      </div>
      <div className="tg histwrap">
        <button
          className={`tb hb${historyOpen ? " on" : ""}`}
          id="tHist"
          aria-label="History"
          data-tip="History (Ctrl+H)"
          disabled={!session}
          onClick={() => store().toggleHistory()}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" />
          </svg>
          <span className="car">▾</span>
        </button>
        {historyOpen && session && (
          <HistoryPanel onClose={() => store().toggleHistory(false)} />
        )}
        <button
          className="tb"
          data-tip={
            undoLabel
              ? `Undo ${undoLabel} (Ctrl+Z)`
              : "Undo (Ctrl+Z) · nothing to undo"
          }
          aria-label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
          disabled={!canUndo}
          onClick={() => void store().undo()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M6 3 1.5 7 6 11V8.5h4a2.5 2.5 0 0 1 0 5H8V15h2a4 4 0 0 0 0-8H6z" />
          </svg>
        </button>
        <button
          className="tb"
          data-tip={
            redoLabel
              ? `Redo ${redoLabel} (Ctrl+Y)`
              : "Redo (Ctrl+Y) · nothing to redo"
          }
          aria-label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
          disabled={!canRedo}
          onClick={() => void store().redo()}
        >
          <svg viewBox="0 0 16 16" style={{ transform: "scaleX(-1)" }}>
            <path d="M6 3 1.5 7 6 11V8.5h4a2.5 2.5 0 0 1 0 5H8V15h2a4 4 0 0 0 0-8H6z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Custom title bar: the window has no native frame (Windows 11 still rounds it). */
export function TitleBar({ info }: { info: AppInfo | null }) {
  const session = useSession((s) => s.session);
  // Short of room for tabs, the menu keeps only the dog mark.
  const [tight, setTight] = useState(false);
  const onTight = useCallback((t: boolean) => setTight(t), []);
  return (
    <header
      className={`titlebar${tight ? " tight" : ""}`}
      data-tauri-drag-region
    >
      <div className="tleft" data-tauri-drag-region>
        <AppMenu info={info} />
        <Tabs tight={tight} onTight={onTight} />
      </div>
      <Transport />
      <div className="tright" data-tauri-drag-region>
        <UpdateIndicator />
        <div className="tg">
          <button
            className="tb"
            id="tExport"
            aria-label="Export"
            disabled={!session}
            onClick={() => void exportDialog()}
            data-tip={
              session?.scratch
                ? "Export (Ctrl+S) · the dialog starts on the original file; saving there replaces it, with a backup"
                : "Export a mixdown (Ctrl+R)"
            }
          >
            <svg viewBox="0 0 16 16">
              <path d="M8 10V2.5M5 5.2 8 2.3l3 2.9M2.5 9.5v3.5h11V9.5" />
            </svg>
          </button>
        </div>
        <div className="winctl">
          <button
            aria-label="Minimize"
            onClick={() => windowAction("minimize")}
          >
            <svg viewBox="0 0 10 10">
              <path d="M0 5h10" />
            </svg>
          </button>
          <button
            aria-label="Maximize"
            onClick={() => windowAction("toggleMaximize")}
          >
            <svg viewBox="0 0 10 10">
              <path d="M.5.5h9v9h-9z" />
            </svg>
          </button>
          <button
            className="close"
            aria-label="Close"
            onClick={() => void requestClose()}
          >
            <svg viewBox="0 0 10 10">
              <path d="M0 0l10 10M10 0 0 10" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
