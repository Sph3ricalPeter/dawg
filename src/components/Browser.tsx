import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { openPath } from "@/lib/actions";
import { dropTarget } from "@/lib/drop";
import { fmtSeconds } from "@/lib/format";
import { baseName, dirName, joinPath, useBrowser } from "@/stores/browser-store";
import { useSession } from "@/stores/session-store";

const FOLDER = (
  <svg width="11" height="9" viewBox="0 0 11 9">
    <path d="M.5 1.2c0-.4.3-.7.7-.7h2.6l1 1.1h5c.4 0 .7.3.7.7v5.5c0 .4-.3.7-.7.7H1.2c-.4 0-.7-.3-.7-.7z" fill="none" stroke="currentColor" />
  </svg>
);
const CHEV = (
  <svg viewBox="0 0 8 8">
    <path d="M1 2.5h6L4 6z" />
  </svg>
);

function ext(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : "";
}

interface MenuItem {
  label: string;
  run?: () => void;
  keys?: string;
}
type MenuEntry = MenuItem | "-";
interface MenuState {
  x: number;
  y: number;
  title: string;
  /** The full path, shown on hover over the title. */
  path: string;
  items: MenuEntry[];
}

/** Adds a file to the session: on `track` at `start`, or on a new track; it
 * opens as a scratch session when nothing is open. */
function place(path: string, track: number | null, start: number) {
  const s = useSession.getState();
  if (!s.session) {
    openPath(path);
    return;
  }
  void s.importFiles([path], { track, start });
}

async function addFolder() {
  if (!isTauri()) return;
  const picked = await openDialog({ directory: true, multiple: true, title: "Add a folder to the Browser" });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  await useBrowser.getState().addRoots(paths);
}

/** The dragged file's chip, and where it would land. */
interface Drag {
  path: string;
  x: number;
  y: number;
  label: string;
}

function dragLabel(x: number, y: number): string {
  const s = useSession.getState();
  if (!s.session) return "Drop to open it";
  const t = dropTarget(x, y);
  if (t.over && t.track !== null) {
    const tr = s.session.tracks.find((k) => k.id === t.track);
    return `Add to ${tr?.name || "the track"}`;
  }
  const el = document.elementFromPoint(x, y);
  if (t.over || el?.closest(".arrangement")) return "Add on a new track";
  return "";
}

function FileRow({
  path,
  depth,
  onMenu,
  onDrag,
  showDir = false,
}: {
  path: string;
  depth: number;
  onMenu: (e: React.MouseEvent, path: string, recent: boolean) => void;
  onDrag: (d: Drag | null) => void;
  showDir?: boolean;
}) {
  const current = useBrowser((s) => s.current === path);
  const name = baseName(path);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      dragging = true;
      onDrag({ path, x: ev.clientX, y: ev.clientY, label: dragLabel(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dragging) return;
      onDrag(null);
      const t = dropTarget(ev.clientX, ev.clientY);
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (t.over) place(path, t.track, t.start);
      else if (el?.closest(".arrangement")) place(path, null, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`bi${current ? " cur" : ""}`}
      style={{ paddingLeft: 10 + depth * 12 }}
      onPointerDown={onDown}
      onClick={() => void useBrowser.getState().pick(path)}
      onContextMenu={(e) => onMenu(e, path, false)}
      data-tip={path}
      data-hint="Click to preview · drag onto a track or the empty lane below · right-click to add it on a new track and more"
    >
      <span className="ic">
        <span className={`ft ft-${ext(path)}`}>{ext(path).toUpperCase()}</span>
      </span>
      <span className="nm">{name}</span>
      {showDir && <span className="rp">{baseName(dirName(path))}</span>}
    </div>
  );
}

function FolderRow({
  path,
  depth,
  root,
  onMenu,
  onDrag,
}: {
  path: string;
  depth: number;
  root?: boolean;
  onMenu: (e: React.MouseEvent, path: string, root: boolean) => void;
  onDrag: (d: Drag | null) => void;
}) {
  const open = useBrowser((s) => s.expanded.includes(path));
  const listing = useBrowser((s) => s.listings[path]);
  const pinned = useBrowser((s) => s.pins.includes(path));
  const b = useBrowser.getState;
  useEffect(() => {
    if (open && !listing) void b().list(path);
  }, [open, listing, path, b]);
  const pad = 10 + depth * 12;
  const name = baseName(path);
  return (
    <>
      <div
        className={`bi fold${open ? "" : " closed"}`}
        style={{ paddingLeft: pad }}
        data-tip={path}
        onClick={() => b().toggleFolder(path)}
        onContextMenu={(e) => onMenu(e, path, !!root)}
      >
        <span className="tw">{CHEV}</span>
        <span className="ic">{FOLDER}</span>
        <span className="nm">
          {name}
          {root && <span className="rp"> {dirName(path) === path ? "" : dirName(path)}</span>}
        </span>
        {pinned && (
          <span className="pinm" data-tip="Pinned">
            •
          </span>
        )}
      </div>
      {open &&
        (listing ? (
          <>
            {listing.dirs.map((d) => (
              <FolderRow key={d} path={joinPath(path, d)} depth={depth + 1} onMenu={onMenu} onDrag={onDrag} />
            ))}
            {listing.files.map((f) => (
              <FileRow
                key={f}
                path={joinPath(path, f)}
                depth={depth + 1.85}
                onMenu={(e, p) => onMenu(e, p, false)}
                onDrag={onDrag}
              />
            ))}
            {listing.error ? (
              <div className="bi bnote" style={{ paddingLeft: pad + 22 }}>
                Can't read this folder
              </div>
            ) : (
              !listing.dirs.length &&
              !listing.files.length && (
                <div className="bi bnote" style={{ paddingLeft: pad + 22 }}>
                  No WAV or MP3 files
                </div>
              )
            )}
          </>
        ) : (
          <div className="bi bnote" style={{ paddingLeft: pad + 22 }}>
            Reading…
          </div>
        ))}
    </>
  );
}

function Section({ k, title, children }: { k: string; title: string; children: React.ReactNode }) {
  const shut = useBrowser((s) => s.shut.includes(k));
  return (
    <>
      <div className={`bsec${shut ? " shut" : ""}`} onClick={() => useBrowser.getState().toggleSection(k)} data-tip={shut ? "Expand" : "Collapse"}>
        <span className="chev">{CHEV}</span>
        <span className="bst">{title}</span>
      </div>
      {!shut && <div className="bgrp">{children}</div>}
    </>
  );
}

function Preview() {
  const current = useBrowser((s) => s.current);
  const info = useBrowser((s) => s.info);
  const playing = useBrowser((s) => s.playing);
  const at = useBrowser((s) => s.at);
  const ref = useRef<HTMLCanvasElement>(null);
  // Redraw when the Browser is resized.
  const [cw, setCw] = useState(0);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => setCw(cv.clientWidth));
    ro.observe(cv);
    return () => ro.disconnect();
  }, [current]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const x = cv.getContext("2d");
    if (!x) return;
    x.scale(dpr, dpr);
    x.clearRect(0, 0, w, h);
    if (!info) return;
    const css = getComputedStyle(document.documentElement);
    const mid = h / 2;
    const half = h / 2 - 3;
    const n = info.peaks.length;
    const col = (i: number) => info.peaks[Math.min(n - 1, Math.floor((i / w) * n))] ?? 0;
    x.fillStyle = css.getPropertyValue("--text-dim").trim() || "#a3a3a3";
    for (let px = 0; px < w; px++) {
      const a = Math.min(1, col(px));
      x.fillRect(px, mid - Math.max(0.5, a * half), 1, Math.max(1, 2 * a * half));
    }
    const over = css.getPropertyValue("--danger").trim() || "#ff4d4d";
    x.fillStyle = over;
    for (let px = 0; px < w; px++) if (col(px) > 1) x.fillRect(px, 0, 1, 2);
  }, [info, cw]);
  if (!current) {
    return (
      <div className="preview">
        <div className="pvw none">
          <span className="hintx">Click a file to hear it here</span>
        </div>
      </div>
    );
  }
  const len = info?.seconds ?? 0;
  const b = useBrowser.getState;
  return (
    <div className="preview">
      <div
        className="pvw"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void b().play(len * ((e.clientX - r.left) / r.width));
        }}
        data-hint="Click to play from there"
      >
        <canvas ref={ref} />
        {playing && len > 0 && <i className="pvph" style={{ left: `${Math.min(100, (at / len) * 100)}%` }} />}
        <span className="tl">
          <span className="pvname">{baseName(current)}</span>
          {info && (
            <span className="pvfmt">
              {info.format} · {info.rate / 1000} kHz{info.channels === 1 ? " mono" : ""}
            </span>
          )}
        </span>
        {info && (
          <>
            <span className={`tr${info.peakDb !== null && info.peakDb > 0 ? " hot" : ""}`}>
              {info.peakDb === null ? "silent" : `${info.peakDb.toFixed(1)} dBFS`}
            </span>
            <span className="bl">{fmtSeconds(len)}</span>
          </>
        )}
        <button
          className="pvplay"
          aria-label={playing ? "Stop" : "Play"}
          onClick={(e) => {
            e.stopPropagation();
            if (playing) b().stop();
            else void b().play(0);
          }}
        >
          {playing ? "■" : "▶"}
        </button>
      </div>
    </div>
  );
}

/** The 7 px handle on the Browser's right edge: drag to resize (150–380 px,
 * leaving the playlist at least 420), double-click to reset. */
function Sizer() {
  const [on, setOn] = useState(false);
  return (
    <div
      className={`sizer${on ? " on" : ""}`}
      data-hint="Drag to resize the Browser · double-click resets"
      onDoubleClick={() => useBrowser.getState().setWidth(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const h = e.currentTarget;
        const pane = h.parentElement;
        if (!pane) return;
        h.setPointerCapture(e.pointerId);
        const w0 = pane.getBoundingClientRect().width;
        const x0 = e.clientX;
        const room = (pane.parentElement?.clientWidth ?? window.innerWidth) - 420;
        const { setWidth } = useBrowser.getState();
        setOn(true);
        document.body.classList.add("sizing");
        const move = (ev: PointerEvent) => setWidth(Math.min(room, w0 + ev.clientX - x0), false);
        const up = (ev: PointerEvent) => {
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          h.removeEventListener("pointercancel", up);
          setOn(false);
          document.body.classList.remove("sizing");
          if (ev.type === "pointerup") setWidth(useBrowser.getState().width);
          else setWidth(w0);
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      }}
    />
  );
}

/** The Browser from the UX spec: pinned folders, recent files and a folder
 * tree, with search; click to preview, drag onto the playlist to place. */
export function Browser() {
  const session = useSession((s) => s.session);
  const open = useBrowser((s) => (session?.scratch ? s.openScratch : s.open));
  const roots = useBrowser((s) => s.roots);
  const pins = useBrowser((s) => s.pins);
  const recent = useBrowser((s) => s.recent);
  const query = useBrowser((s) => s.query);
  const results = useBrowser((s) => s.results);
  const autoPreview = useBrowser((s) => s.autoPreview);
  const width = useBrowser((s) => s.width);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const b = useBrowser.getState;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  if (!open) {
    return (
      <aside className="browser shut">
        <button className="rail" onClick={() => b().toggle()} data-tip="Show the Browser (Ctrl+Alt+B)">
          Browser
        </button>
      </aside>
    );
  }

  const fileMenu = (e: React.MouseEvent, path: string, isRecent: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const s = useSession.getState();
    const sel = s.session?.tracks.find((t) => t.clips.some((c) => s.selected.includes(c.id)));
    const at = Math.round(s.playhead);
    const dir = dirName(path);
    const items: MenuEntry[] = [
      { label: "Preview", keys: "Click", run: () => void b().pick(path, true) },
      { label: "Add on a new track", run: () => place(path, null, at) },
      ...(sel ? [{ label: `Add to ${sel.name || "the selected track"}`, run: () => place(path, sel.id, at) }] : []),
      { label: s.session ? "Open on its own…" : "Open", run: () => openPath(path) },
      "-",
      { label: b().pins.includes(dir) ? "Unpin its folder" : "Pin its folder", run: () => b().togglePin(dir) },
      { label: "Show in Explorer", run: () => void api.revealPath(path) },
      { label: "Copy path", run: () => void navigator.clipboard.writeText(path).catch(() => undefined) },
      ...(isRecent ? ["-" as const, { label: "Remove from Recent files", run: () => b().forgetRecent(path) }] : []),
    ];
    setMenu({ x: e.clientX, y: e.clientY, title: baseName(path), path, items });
  };
  const folderMenu = (e: React.MouseEvent, path: string, isRoot: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuEntry[] = [
      { label: b().pins.includes(path) ? "Unpin" : "Pin", run: () => b().togglePin(path) },
      { label: "Refresh", run: () => void b().list(path, true) },
      ...(isRoot ? [{ label: "Remove from Folders", run: () => b().removeRoot(path) }] : []),
      ...(!isRoot && !roots.includes(path) ? [{ label: "Add to Folders", run: () => void b().addRoots([path]) }] : []),
      "-",
      { label: "Show in Explorer", run: () => void api.revealPath(path) },
      { label: "Copy path", run: () => void navigator.clipboard.writeText(path).catch(() => undefined) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, title: baseName(path), path, items });
  };

  return (
    <aside className="browser" style={width === null ? undefined : { width }}>
      <Sizer />
      <div className="phead">
        <button className="x" aria-label="Hide the Browser" onClick={() => b().toggle()} data-tip="Hide the Browser (Ctrl+Alt+B)">
          ‹
        </button>
        <span className="pht">Browser</span>
        <label className={`chk bauto${autoPreview ? " on" : ""}`} data-hint="Clicking a file plays it; off, clicking only shows it">
          <input type="checkbox" checked={autoPreview} onChange={(e) => b().setAutoPreview(e.target.checked)} />
          <i />
          Auto-preview
        </label>
      </div>
      <label className="search">
        <svg width="11" height="11" viewBox="0 0 16 16">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="m11 11 4 4" stroke="currentColor" strokeWidth="2" />
        </svg>
        <input
          value={query}
          placeholder="Search samples"
          onChange={(e) => b().search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") b().search("");
            e.stopPropagation();
          }}
        />
      </label>
      <div className="blist">
        {results !== null ? (
          <>
            <div className="bsec nohover">
              <span className="bst">
                {results.length} result{results.length === 1 ? "" : "s"}
              </span>
            </div>
            {results.map((p) => (
              <FileRow key={p} path={p} depth={0} onMenu={fileMenu} onDrag={setDrag} showDir />
            ))}
            {results.length === 0 && <div className="bi bnote">Nothing by that name in your folders or recent files</div>}
          </>
        ) : (
          <>
            <Section k="pins" title="Pinned folders">
              {pins.map((p) => (
                <div
                  key={p}
                  className="bi"
                  data-tip={`${p}\nClick to show it in Folders · right-click to unpin`}
                  onClick={() => {
                    if (!roots.some((r) => p === r || p.startsWith(r + "\\") || p.startsWith(r + "/"))) void b().addRoots([p]);
                    else if (!b().expanded.includes(p)) b().toggleFolder(p);
                  }}
                  onContextMenu={(e) => folderMenu(e, p, false)}
                >
                  <span className="ic">{FOLDER}</span>
                  <span className="nm">{baseName(p)}</span>
                </div>
              ))}
              {pins.length === 0 && <div className="bi bnote">Right-click any folder to pin it here</div>}
            </Section>
            <Section k="recent" title="Recent files">
              {recent.map((p) => (
                <FileRow key={p} path={p} depth={0} onMenu={(e) => fileMenu(e, p, true)} onDrag={setDrag} />
              ))}
              {recent.length === 0 && <div className="bi bnote">Files you open or add show up here</div>}
            </Section>
            <Section k="folders" title="Folders">
              {roots.map((r) => (
                <FolderRow key={r} path={r} depth={0} root onMenu={folderMenu} onDrag={setDrag} />
              ))}
              <div className="bi badd" onClick={() => void addFolder()} data-tip="Add a folder to browse (or drop one here from Explorer)">
                <span className="ic">+</span>
                <span className="nm">Add folder…</span>
              </div>
            </Section>
          </>
        )}
      </div>
      <Preview />
      {menu && (
        <div className="menu ctx" role="menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <div className="menu-head">
            <b className="menu-title" data-tip={menu.path}>
              {menu.title}
            </b>
          </div>
          {menu.items.map((it, i) =>
            it === "-" ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  it.run?.();
                }}
              >
                {it.label}
                {it.keys && <kbd>{it.keys}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
      {drag && (
        <div className="dragchip" style={{ left: drag.x + 12, top: drag.y + 10 }}>
          <span className={`ft ft-${ext(drag.path)}`}>{ext(drag.path).toUpperCase()}</span>
          <span className="nm">{baseName(drag.path)}</span>
          {drag.label && <span className="dl">{drag.label}</span>}
        </div>
      )}
    </aside>
  );
}
