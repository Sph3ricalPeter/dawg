import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import type { AppInfo } from "@/lib/app-info";
import { exportDialog, requestClose } from "@/lib/actions";
import { fmtTime } from "@/lib/format";
import { useSession } from "@/stores/session-store";
import { AppMenu } from "./AppMenu";
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
  return (
    <div className="doc" title={session.path}>
      <b>
        {session.name}
        {session.dirty && <span className="dirty"> •</span>}
      </b>
      <span className="pill">Scratch</span>
    </div>
  );
}

function Transport() {
  const session = useSession((s) => s.session);
  const playing = useSession((s) => s.playing);
  const playhead = useSession((s) => s.playhead);
  const canUndo = useSession((s) => !!s.session?.canUndo);
  const canRedo = useSession((s) => !!s.session?.canRedo);
  const rate = session?.rate ?? 48_000;
  const store = useSession.getState;
  return (
    <div className="transport">
      <div className="tg">
        <button
          className={`tb${playing ? " on" : ""}`}
          id="tPlay"
          title="Play / stop (Space)"
          disabled={!session}
          onClick={() => void store().togglePlay()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
        </button>
        <button
          className="tb"
          title="Stop and return (Home)"
          disabled={!session}
          onClick={() => {
            void store().stop();
          }}
        >
          <svg viewBox="0 0 16 16">
            <path d="M3.5 3.5h9v9h-9z" />
          </svg>
        </button>
      </div>
      <div className="tg">
        <div className="lcd" title="Playhead position">
          <span className="big">{fmtTime(playhead / rate)}</span>
        </div>
      </div>
      <div className="tg">
        <button className="tb" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => void store().undo()}>
          <svg viewBox="0 0 16 16">
            <path d="M6 3 1.5 7 6 11V8.5h4a2.5 2.5 0 0 1 0 5H8V15h2a4 4 0 0 0 0-8H6z" />
          </svg>
        </button>
        <button className="tb" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => void store().redo()}>
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
            title="Export (Ctrl+S) · the dialog starts on the original file; saving there replaces it, with a backup"
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
