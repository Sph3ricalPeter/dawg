import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import type { AppInfo } from "@/lib/app-info";
import { exportDialog, requestClose } from "@/lib/actions";
import { useBrowser } from "@/stores/browser-store";
import { useSession } from "@/stores/session-store";
import { AppMenu } from "./AppMenu";
import { HistoryPanel } from "./HistoryPanel";
import { Master } from "./Master";
import { Bpm, Lcd, TimelineMenu } from "./TimeControls";
import { UpdateIndicator } from "./UpdateIndicator";

function windowAction(action: "minimize" | "toggleMaximize") {
  if (!isTauri()) return;
  void getCurrentWindow()[action]();
}

function Doc() {
  const session = useSession((s) => s.session);
  if (!session) {
    return (
      <div className="doc">
        <b>Untitled</b>
        <span className="faint">no file open</span>
      </div>
    );
  }
  // As in the mockup: a scratch file is tagged, a project shows its file
  // name, and an untitled one says it isn't saved.
  return (
    <div className="doc" data-tip={session.path ?? session.project ?? "Not saved yet"}>
      <b>
        {session.name}
        {session.dirty && <span className="dirty"> •</span>}
      </b>
      {session.scratch ? (
        <span className="pill">Scratch</span>
      ) : (
        !session.project && <span className="faint">not saved</span>
      )}
    </div>
  );
}

function BrowserToggle() {
  const scratch = useSession((s) => !!s.session?.scratch);
  const open = useBrowser((s) => (scratch ? s.openScratch : s.open));
  return (
    <button className={`tb${open ? " on" : ""}`} id="tBrowser" aria-label="Browser" data-tip="Browser (Ctrl+Alt+B)" onClick={() => useBrowser.getState().toggle()}>
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
  const undoLabel = useSession((s) => (s.session?.canUndo ? s.session.history.at(-1)?.label : undefined));
  const redoLabel = useSession((s) => (s.session?.canRedo ? s.session.future[0]?.label : undefined));
  const historyOpen = useSession((s) => s.historyOpen);
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
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
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
      <div className="tg histwrap">
        <button
          className={`tb hb${historyOpen ? " on" : ""}`}
          id="tHist"
          aria-label="History"
          data-tip="History (Ctrl+H)"
          disabled={!session}
          onClick={() => store().toggleHistory()}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" />
          </svg>
          <span className="car">▾</span>
        </button>
        {historyOpen && session && <HistoryPanel onClose={() => store().toggleHistory(false)} />}
        <button
          className="tb"
          data-tip={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z) · nothing to undo"}
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
          data-tip={redoLabel ? `Redo ${redoLabel} (Ctrl+Y)` : "Redo (Ctrl+Y) · nothing to redo"}
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
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tleft" data-tauri-drag-region>
        <AppMenu info={info} />
        <Doc />
      </div>
      <Transport />
      <div className="tright" data-tauri-drag-region>
        <UpdateIndicator />
        <div className="tg">
          <button
            className="btn primary"
            id="tExport"
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
            Export
          </button>
        </div>
        <div className="winctl">
          <button aria-label="Minimize" onClick={() => windowAction("minimize")}>
            <svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg>
          </button>
          <button aria-label="Maximize" onClick={() => windowAction("toggleMaximize")}>
            <svg viewBox="0 0 10 10"><path d="M.5.5h9v9h-9z" /></svg>
          </button>
          <button className="close" aria-label="Close" onClick={requestClose}>
            <svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0 0 10" /></svg>
          </button>
        </div>
      </div>
    </header>
  );
}
