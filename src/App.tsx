import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dialogs } from "@/components/Dialogs";
import { Editor } from "@/components/Editor";
import { TitleBar } from "@/components/TitleBar";
import { api, type RecentProject } from "@/lib/api";
import {
  addFilesDialog,
  exportDialog,
  isAudio,
  isProject,
  newProject,
  openFileDialog,
  openPath,
  openProjectDialog,
  openRecent,
  requestClose,
  saveOrExport,
  saveProjectAs,
} from "@/lib/actions";
import { getAppInfo, type AppInfo } from "@/lib/app-info";
import { fmtFormat } from "@/lib/format";
import { useSession } from "@/stores/session-store";
import { CHECK_INTERVAL_MS, useUpdaterStore } from "@/stores/updater-store";

function EmptyState({ dropping }: { dropping: boolean }) {
  // An empty project takes the files it is given; with nothing open, one
  // file opens as a scratch session.
  const project = useSession((s) => !!s.session && !s.session.scratch);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  useEffect(() => {
    if (!isTauri() || project) return;
    void api
      .recentProjects()
      .then((r) => setRecent(r.filter((p) => p.exists).slice(0, 5)))
      .catch(() => undefined);
  }, [project]);
  return (
    <div className={`empty${dropping ? " dropping" : ""}`}>
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="1.4">
        <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3" />
      </svg>
      <h3>Drop WAV or MP3 files here</h3>
      {project ? (
        <p>Each file gets its own track, all starting at the same point so they layer.</p>
      ) : (
        <p>One file opens on its own track so you can trim it, shape its volume and export it over the original. Drop several and each gets a track; Export mixes them down to one file.</p>
      )}
      <div className="row">
        <button className="btn" onClick={() => void (project ? addFilesDialog() : openFileDialog())}>
          Open files… <kbd>{project ? "Ctrl+Shift+O" : "Ctrl+O"}</kbd>
        </button>
        <button className="btn ghost" onClick={() => void openProjectDialog()}>
          Open project…
        </button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <span className="faint">Recent projects</span>
          {recent.map((r) => (
            <button key={r.path} className="link" title={r.path} onClick={() => void openRecent(r.path)}>
              {r.name}
            </button>
          ))}
        </div>
      )}
      <p className="faint tip">
        Tip: right-click any WAV or MP3 in Explorer and choose <b>Edit in dawg</b> (under “Show more options” on Windows 11).
      </p>
    </div>
  );
}

function StatusBar({ hint }: { hint: string }) {
  const session = useSession((s) => s.session);
  const busy = useSession((s) => s.busy);
  const fallback = session
    ? `Drag the ruler to move the playhead, Ctrl+drag it for a range · drag clips to move them · click a clip's line for envelope points · drop files to add tracks · ${session.scratch ? "Ctrl+S exports, Ctrl+Shift+S saves a project" : "Ctrl+S saves, Ctrl+R exports"}`
    : "Drop WAV or MP3 files anywhere, or press Ctrl+O";
  return (
    <footer className="status">
      <span className="hint">{busy ?? (hint || fallback)}</span>
      {session && (
        <span className="r">
          <span>
            {session.simple ? `${fmtFormat(session.format, session.kbps)} (from file)` : `Mixdown at ${session.rate / 1000} kHz`}
          </span>
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
      if (ctrl && e.shiftKey && k === "o") void addFilesDialog();
      else if (ctrl && e.shiftKey && k === "t") void s.addTrack();
      else if (ctrl && e.shiftKey && k === "s") void saveProjectAs();
      else if (ctrl && k === "o") void openFileDialog();
      else if (ctrl && k === "n") newProject();
      else if (ctrl && k === "s") saveOrExport();
      else if (ctrl && k === "r") void exportDialog();
      else if (ctrl && (k === "y" || (e.shiftKey && k === "z"))) void s.redo();
      else if (ctrl && k === "z") void s.undo();
      else if (ctrl && k === "t") void s.cropToRange();
      else if (ctrl && k === "b") void s.duplicateSelected();
      else if (ctrl && k === "e") void s.splitAtPlayhead();
      else if (ctrl && k === "a") s.selectAll();
      else if (ctrl && k === "w") requestClose();
      else if (ctrl && (k === "0" || k === "f")) s.fit();
      else if (ctrl && (k === "=" || k === "+")) s.zoomAt(s.width / 2, 0.5);
      else if (ctrl && k === "-") s.zoomAt(s.width / 2, 2);
      else if (!ctrl && e.key === " ") void s.togglePlay();
      else if (!ctrl && (e.key === "Delete" || e.key === "Backspace")) void s.deleteClips(s.selected);
      else if (!ctrl && k === "e" && s.session) s.toggleEnvEdit();
      else if (!ctrl && k === "l" && s.session) s.toggleLoop();
      else if (!ctrl && e.key === "Home") {
        void s.stop();
        s.setPlayhead(0);
      } else if (!ctrl && e.key === "Escape") {
        // As in the mockup: clears the range and the selection.
        s.setRange(null);
        s.select(null);
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

/** Where a drop at window point (x, y) lands: onto a track at a time, or
 * onto new tracks. */
function dropTarget(x: number, y: number): { track: number | null; start: number; over: boolean } {
  const s = useSession.getState();
  const el = document.elementFromPoint(x, y);
  const lane = el?.closest<HTMLElement>(".lane");
  if (!lane || !s.session) return { track: null, start: 0, over: false };
  const r = lane.getBoundingClientRect();
  const start = Math.max(0, Math.round(s.view.start + (x - r.left) * s.view.fpp));
  const track = lane.dataset.track ? Number(lane.dataset.track) : null;
  return { track, start, over: true };
}

export type DropState = { files: number; track: string | null } | null;

/** Dropped files open, or join the open session; the close button asks
 * about edits. */
function useWindowEvents(setDrop: (d: DropState) => void) {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten: Array<() => void> = [];
    let files = 0;
    const at = (p: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      return dropTarget(p.x / dpr, p.y / dpr);
    };
    const trackName = (id: number | null) => {
      if (id === null) return null;
      const t = useSession.getState().session?.tracks.find((t) => t.id === id);
      return t ? t.name || "the track" : null;
    };
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter") {
          files = p.paths.filter(isAudio).length;
          setDrop({ files, track: files === 1 ? trackName(at(p.position).track) : null });
        } else if (p.type === "over") {
          setDrop({ files, track: files === 1 ? trackName(at(p.position).track) : null });
        } else if (p.type === "leave") setDrop(null);
        else if (p.type === "drop") {
          setDrop(null);
          const project = p.paths.find(isProject);
          if (project) {
            openPath(project);
            return;
          }
          const audio = p.paths.filter(isAudio);
          const s = useSession.getState();
          if (!audio.length) {
            if (p.paths.length) s.showToast("Only WAV and MP3 files and dawg projects open here for now", { error: true });
            return;
          }
          if (!s.session) {
            openPath(audio[0], audio.slice(1));
            return;
          }
          const t = at(p.position);
          // One file goes where it's dropped; several get a track each.
          void s.importFiles(audio, { track: audio.length === 1 ? t.track : null, start: t.over ? t.start : 0 });
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
  }, [setDrop]);
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
  const [drop, setDrop] = useState<DropState>(null);
  const dropping = drop !== null;
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
    // "Edit in dawg" and Unity's external editor pass the file on the
    // command line. A later launch hands it to this window and says so.
    const take = () =>
      void api.startupFile().then((path) => {
        if (path) openPath(path);
      });
    take();
    const unlisten = listen("open-requested", take);
    return () => void unlisten.then((f) => f());
  }, []);

  useShortcuts();
  usePlayheadPolling();
  useWindowEvents(setDrop);
  useWindowTitle(info);

  const onOver = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-hint]");
    setHint(el?.dataset.hint ?? "");
  };

  return (
    <div className="app" onMouseOver={onOver} onContextMenu={(e) => e.preventDefault()}>
      <TitleBar info={info} />
      <main className="arrangement">
        {session && (session.scratch || session.tracks.length > 0) ? <Editor /> : <EmptyState dropping={dropping} />}
        {session && drop && (
          <div className="dropbar">
            {drop.track
              ? `Drop to add it to ${drop.track} where you let go`
              : drop.files > 1
                ? `Drop to add ${drop.files} files, each on a new track`
                : "Drop to add it on a new track"}
          </div>
        )}
      </main>
      <StatusBar hint={hint} />
      <Dialogs />
      <Toast />
    </div>
  );
}
