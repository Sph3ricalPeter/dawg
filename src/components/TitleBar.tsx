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
import { Icon } from "@/ui/Icon";
import { ToolButton } from "@/ui/Button";

function windowAction(action: "minimize" | "toggleMaximize") {
  if (!isTauri()) return;
  void getCurrentWindow()[action]();
}

function BrowserToggle() {
  const scratch = useSession((s) => !!s.session?.scratch);
  const open = useBrowser((s) => (scratch ? s.openScratch : s.open));
  return (
    <ToolButton
      on={open}
      id="tBrowser"
      aria-label="Browser"
      data-tip="Browser (Ctrl+Alt+B)"
      onClick={() => useBrowser.getState().toggle()}
      icon="browser"
    />
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
        <ToolButton
          on={playing}
          id="tPlay"
          aria-label={playing ? "Stop" : "Play"}
          data-tip="Play / stop (Space)"
          disabled={!session}
          onClick={() => void store().togglePlay()}
          icon="play"
        />
        <ToolButton
          aria-label="Stop and return"
          data-tip="Stop and return to where playback started"
          disabled={!session}
          onClick={() => {
            void store().stop();
          }}
          icon="stop"
        />
        <ToolButton
          on={loop}
          aria-label="Loop"
          aria-pressed={loop}
          data-tip={`Loop (L) · ${hasRange ? "the range" : "from 0 to the end of the last clip"}`}
          disabled={!session}
          onClick={() => store().toggleLoop()}
          icon="loop"
        />
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
        <ToolButton
          className="hb"
          on={mixerOpen}
          aria-label="Mixer"
          data-tip="Mixer (F9)"
          disabled={!session}
          onClick={() => store().toggleMixer()}
          icon="mixer"
        />
      </div>
      <div className="tg histwrap">
        <ToolButton
          className="hb"
          on={historyOpen}
          id="tHist"
          aria-label="History"
          data-tip="History (Ctrl+H)"
          disabled={!session}
          onClick={() => store().toggleHistory()}
          icon="history"
        >
          <span className="car">▾</span>
        </ToolButton>
        {historyOpen && session && (
          <HistoryPanel onClose={() => store().toggleHistory(false)} />
        )}
        <ToolButton
          data-tip={
            undoLabel
              ? `Undo ${undoLabel} (Ctrl+Z)`
              : "Undo (Ctrl+Z) · nothing to undo"
          }
          aria-label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
          disabled={!canUndo}
          onClick={() => void store().undo()}
          icon="undo"
        />
        <ToolButton
          data-tip={
            redoLabel
              ? `Redo ${redoLabel} (Ctrl+Y)`
              : "Redo (Ctrl+Y) · nothing to redo"
          }
          aria-label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
          disabled={!canRedo}
          onClick={() => void store().redo()}
          icon="redo"
        />
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
          <ToolButton
            id="tExport"
            aria-label="Export"
            disabled={!session}
            onClick={() => void exportDialog()}
            data-tip={
              session?.scratch
                ? "Export (Ctrl+S) · the dialog starts on the original file; saving there replaces it, with a backup"
                : "Export a mixdown (Ctrl+R)"
            }
            icon="export"
          />
        </div>
        <div className="winctl">
          <button
            aria-label="Minimize"
            onClick={() => windowAction("minimize")}
          >
<Icon name="minimize" />
          </button>
          <button
            aria-label="Maximize"
            onClick={() => windowAction("toggleMaximize")}
          >
<Icon name="maximize" />
          </button>
          <button
            className="close"
            aria-label="Close"
            onClick={() => void requestClose()}
          >
<Icon name="win-close" />
          </button>
        </div>
      </div>
    </header>
  );
}
