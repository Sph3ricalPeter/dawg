import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dialogs } from "@/components/Dialogs";
import { Editor } from "@/components/Editor";
import { TitleBar } from "@/components/TitleBar";
import { api } from "@/lib/api";
import {
  isWav,
  openFileDialog,
  openPath,
  requestClose,
  saveAsDialog,
  showReplaceDialog,
} from "@/lib/actions";
import { getAppInfo, type AppInfo } from "@/lib/app-info";
import { fmtFormat } from "@/lib/format";
import { useSession } from "@/stores/session-store";
import { CHECK_INTERVAL_MS, useUpdaterStore } from "@/stores/updater-store";

function EmptyState({ dropping }: { dropping: boolean }) {
  return (
    <div className={`empty${dropping ? " dropping" : ""}`}>
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="1.4">
        <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3" />
      </svg>
      <h3>Drop a WAV file here</h3>
      <p>It opens on one track so you can trim it, change its gain or fade it, then write it back over the original.</p>
      <div className="row">
        <button className="btn" onClick={() => void openFileDialog()}>
          Open file… <kbd>Ctrl+O</kbd>
        </button>
      </div>
      <p className="faint tip">
        Tip: right-click any WAV in Explorer and choose <b>Edit in dawg</b> (under “Show more options” on Windows 11).
      </p>
    </div>
  );
}

function StatusBar({ hint }: { hint: string }) {
  const session = useSession((s) => s.session);
  const busy = useSession((s) => s.busy);
  const fallback = session
    ? "Drag the clip edges to trim · drag across it and press Ctrl+T to crop · Ctrl+S replaces the original"
    : "Drop a WAV file anywhere, or press Ctrl+O";
  return (
    <footer className="status">
      <span className="hint">{busy ?? (hint || fallback)}</span>
      {session && (
        <span className="r">
          <span>{fmtFormat(session.format)} (from file)</span>
        </span>
      )}
    </footer>
  );
}

function Toast() {
  const toast = useSession((s) => s.toast);
  const hide = useSession((s) => s.hideToast);
  if (!toast) return null;
  return (
    <div className={`toast show${toast.error ? " error" : ""}`} role="status">
      <span>{toast.text}</span>
      {toast.action && (
        <button
          className="btn"
          onClick={() => {
            hide();
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="tb x" aria-label="Dismiss" onClick={hide}>
        ✕
      </button>
    </div>
  );
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/** Keyboard shortcuts from the UX spec that apply to a scratch session. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useSession.getState();
      if (s.dialog || isTyping(e)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      let handled = true;
      if (ctrl && k === "o") void openFileDialog();
      else if (ctrl && e.shiftKey && k === "s") void saveAsDialog();
      else if (ctrl && k === "s") showReplaceDialog();
      else if (ctrl && k === "r") showReplaceDialog();
      else if (ctrl && (k === "y" || (e.shiftKey && k === "z"))) void s.redo();
      else if (ctrl && k === "z") void s.undo();
      else if (ctrl && k === "t") void s.cropToRange();
      else if (ctrl && k === "w") requestClose();
      else if (ctrl && (k === "0" || k === "f")) s.fit();
      else if (ctrl && (k === "=" || k === "+")) s.zoomAt(s.width / 2, 0.5);
      else if (ctrl && k === "-") s.zoomAt(s.width / 2, 2);
      else if (!ctrl && e.key === " ") void s.togglePlay();
      else if (!ctrl && e.key === "Home") {
        void s.stop();
        s.setPlayhead(s.session?.clip.start ?? 0);
      } else if (!ctrl && e.key === "Escape") {
        if (s.range) s.setRange(null);
      } else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Follows the engine's playhead while playing. */
function usePlayheadPolling() {
  const playing = useSession((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 30) {
        last = t;
        void useSession.getState().poll();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

/** Files dropped on the window open; the close button asks about edits. */
function useWindowEvents(setDropping: (on: boolean) => void) {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten: Array<() => void> = [];
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "over" || p.type === "enter") setDropping(true);
        else if (p.type === "leave") setDropping(false);
        else if (p.type === "drop") {
          setDropping(false);
          const wav = p.paths.find(isWav);
          if (wav) openPath(wav);
          else if (p.paths.length) {
            useSession.getState().showToast("Only WAV files can be opened for now", { error: true });
          }
        }
      })
      .then((u) => unlisten.push(u));
    void getCurrentWindow()
      .onCloseRequested((e) => {
        if (useSession.getState().session?.dirty) {
          e.preventDefault();
          requestClose();
        }
      })
      .then((u) => unlisten.push(u));
    return () => unlisten.forEach((u) => u());
  }, [setDropping]);
}

/** The window title follows the file, for the taskbar. */
function useWindowTitle(info: AppInfo | null) {
  const name = useSession((s) => s.session?.name);
  const dirty = useSession((s) => !!s.session?.dirty);
  useEffect(() => {
    const app = info?.channel === "dev" ? "dawg dev" : "dawg";
    const title = name ? `${dirty ? "• " : ""}${name} - ${app}` : app;
    document.title = title;
    if (isTauri()) void getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [name, dirty, info]);
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [hint, setHint] = useState("");
  const [dropping, setDropping] = useState(false);
  const session = useSession((s) => s.session);

  useEffect(() => {
    let timer: number | undefined;
    void getAppInfo().then((info) => {
      setInfo(info);
      const updater = useUpdaterStore.getState();
      updater.init(info.updatesEnabled);
      if (!info.updatesEnabled) return;
      void updater.checkNow();
      timer = window.setInterval(() => void useUpdaterStore.getState().checkNow(), CHECK_INTERVAL_MS);
    });
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    // "Edit in dawg" passes the file on the command line.
    void api.startupFile().then((path) => {
      if (path) void useSession.getState().open(path);
    });
  }, []);

  useShortcuts();
  usePlayheadPolling();
  useWindowEvents(setDropping);
  useWindowTitle(info);

  const onOver = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-hint]");
    setHint(el?.dataset.hint ?? "");
  };

  return (
    <div className="app" onMouseOver={onOver} onContextMenu={(e) => e.preventDefault()}>
      <TitleBar info={info} />
      <main className="arrangement">
        {session ? <Editor /> : <EmptyState dropping={dropping} />}
        {session && dropping && <div className="dropov">Drop to open this file instead</div>}
      </main>
      <StatusBar hint={hint} />
      <Dialogs />
      <Toast />
    </div>
  );
}
