import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { openPath } from "@/lib/actions";
import { dropTarget, setDropHover } from "@/lib/drop";
import { fmtSeconds } from "@/lib/format";
import { onFrame, snapPx } from "@/lib/frame-loop";
import { baseName, dirName, disambiguate, joinPath, previewClock, useBrowser } from "@/stores/browser-store";
import { useLayout } from "@/stores/layout-store";
import { type LibraryFile, type LibraryFilter, libraryKey, matchesEntry, useFileLibrary, useLibrary } from "@/stores/library-store";
import { TYPE_LABELS } from "@/lib/labels";
import { FavStar, FileMeta, LabelCloud, LabelDialogView, LabelIcon, LabelPicker, LabelSubmenu, ManageLabels } from "./BrowserLabels";
import { useSession } from "@/stores/session-store";
import { PanelHead } from "./Dock";
import { token } from "@/ui/tokens";

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

/** From this width a row shows four label icons instead of three. */
const WIDE_PX = 300;

const TAG = (
  <svg width="11" height="11" viewBox="0 0 12 12">
    <path d="M1.4 1.4h4.4l4.8 4.8-4.4 4.4-4.8-4.8z" fill="none" stroke="currentColor" />
    <circle cx="3.9" cy="3.9" r=".9" fill="currentColor" />
  </svg>
);

const SPEAKER = <path d="M2 6h2.5L8 3v10L4.5 10H2z" />;

/** The Browser's settings dropdown (the speaker in its header): auto-preview
 * and file type icons. The speaker shows a cross while auto-preview is off. */
function BrowserOptions() {
  const autoPreview = useBrowser((s) => s.autoPreview);
  const typeIcons = useBrowser((s) => s.typeIcons);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // It hangs left from the button; in a narrow Browser by the window's left
  // edge it moves right to stay on screen.
  useLayoutEffect(() => {
    const m = menuRef.current;
    if (!open || !m) return;
    m.style.transform = "";
    const r = m.getBoundingClientRect();
    if (r.left < 4) m.style.transform = `translateX(${4 - r.left}px)`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        e.stopPropagation();
      } else if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close, true);
    };
  }, [open]);
  const b = useBrowser.getState;
  const item = (text: string, on: boolean, run: () => void) => (
    <button key={text} className={`menu-item${on ? " checked" : ""}`} role="menuitemcheckbox" aria-checked={on} onClick={run}>
      {text}
    </button>
  );
  return (
    <div className="bopts" ref={ref}>
      <button
        className={`tb tlset${open ? " on" : ""}${autoPreview ? "" : " manual"}`}
        aria-label="Browser settings"
        onClick={() => setOpen(!open)}
        data-tip={`Browser settings · auto-preview ${autoPreview ? "on" : "off"}`}
      >
        <svg viewBox="0 0 16 16">
          {SPEAKER}
          {autoPreview ? (
            <path d="M10.3 5.6a3.4 3.4 0 0 1 0 4.8M12 4a5.6 5.6 0 0 1 0 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          ) : (
            <path d="M10.5 6l4 4m0-4-4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          )}
        </svg>
        <span className="car">▾</span>
      </button>
      {open && (
        <div className="menu bmenu" role="menu" ref={menuRef}>
          <div className="menu-head">
            <b className="menu-title">Browser settings</b>
          </div>
          {item("Auto-preview on click", autoPreview, () => b().setAutoPreview(!autoPreview))}
          {item("Show file type icons", typeIcons, () => b().setTypeIcons(!typeIcons))}
        </div>
      )}
    </div>
  );
}

/** The tree's indent guides: one vertical line per ancestor folder, under its chevron. */
function Guides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <i key={i} className="guide" style={{ left: 15 + i * 12 }} />
      ))}
    </>
  );
}

function ext(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : "";
}

interface MenuItem {
  label: string;
  run?: () => void;
  keys?: string;
  /** Opens the label picker for this file as a submenu to the right. */
  labelsFor?: string;
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

function dragLabel(x: number, y: number): string | null {
  const s = useSession.getState();
  if (!s.session) return "Drop to open it";
  const t = dropTarget(x, y);
  // Over a lane the ghost clip shows where it lands, so the chip hides.
  if (t.over) return null;
  const el = document.elementFromPoint(x, y);
  if (el?.closest(".arrangement")) return "Add on a new track";
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
  const { labels, fav } = useFileLibrary(path);
  const max = useBrowser((s) => s.wide) ? 4 : 3;
  // With type icons on, the badge already says WAV or MP3.
  const typeIcons = useBrowser((s) => s.typeIcons);
  const name = typeIcons ? baseName(path).replace(/\.[a-z0-9]+$/i, "") : baseName(path);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      dragging = true;
      setDropHover({ paths: [path], x: ev.clientX, y: ev.clientY, free: ev.altKey });
      const label = dragLabel(ev.clientX, ev.clientY);
      onDrag(label === null ? null : { path, x: ev.clientX, y: ev.clientY, label });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dragging) return;
      onDrag(null);
      setDropHover(null);
      const t = dropTarget(ev.clientX, ev.clientY, ev.altKey);
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
      data-hint="Click to preview · drag onto a track or the empty lane below · F favourites it · L opens labels · right-click for more"
    >
      <Guides depth={depth} />
      {typeIcons && (
        <span className="ic">
          <span className={`ft ft-${ext(path)}`}>{ext(path).toUpperCase()}</span>
        </span>
      )}
      <span className="nm">
        {name}
        {showDir && <span className="rp"> {baseName(dirName(path))}</span>}
      </span>
      {labels.length > 0 && (
        <span className="lbl">
          {labels.slice(0, max).map((l) => (
            <LabelIcon key={l.id} icon={l.icon} color={l.color} />
          ))}
          {labels.length > max && <span className="more">+{labels.length - max}</span>}
        </span>
      )}
      <FavStar path={path} fav={fav} />
    </div>
  );
}

function FolderRow({
  path,
  depth,
  root,
  hint,
  onMenu,
  onFileMenu,
  onDrag,
}: {
  path: string;
  depth: number;
  root?: boolean;
  /** Parent folders that tell this root apart from another of the same name. */
  hint?: string;
  onMenu: (e: React.MouseEvent, path: string, root: boolean) => void;
  /** Right-click on a file in the folder. */
  onFileMenu: (e: React.MouseEvent, path: string, recent: boolean) => void;
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
        <Guides depth={depth} />
        <span className="tw">{CHEV}</span>
        <span className="ic">{FOLDER}</span>
        <span className="nm">
          {name}
          {hint && <span className="rp"> {hint}</span>}
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
              <FolderRow key={d} path={joinPath(path, d)} depth={depth + 1} onMenu={onMenu} onFileMenu={onFileMenu} onDrag={onDrag} />
            ))}
            {listing.files.map((f) => (
              <FileRow
                key={f}
                path={joinPath(path, f)}
                depth={depth + 1.85}
                onMenu={(e, p) => onFileMenu(e, p, false)}
                onDrag={onDrag}
              />
            ))}
            {listing.error ? (
              <div className="bi bnote" style={{ paddingLeft: pad + 22 }}>
                <Guides depth={depth + 1} />
                Can't read this folder
              </div>
            ) : (
              !listing.dirs.length &&
              !listing.files.length && (
                <div className="bi bnote" style={{ paddingLeft: pad + 22 }}>
                  <Guides depth={depth + 1} />
                  No WAV or MP3 files
                </div>
              )
            )}
          </>
        ) : (
          <div className="bi bnote" style={{ paddingLeft: pad + 22 }}>
            <Guides depth={depth + 1} />
            Reading…
          </div>
        ))}
    </>
  );
}

/** Whether `path` is inside folder `root` (as Windows compares paths). */
function under(path: string, root: string): boolean {
  const k = libraryKey(path);
  const r = libraryKey(root).replace(/[\\/]+$/, "");
  const sep = r.includes("\\") || /^[a-z]:/.test(r) ? "\\" : "/";
  return k.startsWith(r + sep);
}

/** The folders between `root` and `path`, and the file's name. */
function relParts(path: string, root: string): string[] {
  return path
    .slice(root.replace(/[\\/]+$/, "").length)
    .split(/[\\/]/)
    .filter(Boolean);
}

interface VNode {
  path: string;
  dirs: Map<string, VNode>;
  files: string[];
}

function byName(a: string, b: string): number {
  return baseName(a).localeCompare(baseName(b), undefined, { numeric: true, sensitivity: "base" });
}

/** While filtering, the folder tree shows only the folders that hold a
 * matching file, open, built from the library rather than from listings. */
function FilteredTree({
  entries,
  onMenu,
  folderMenu,
  onDrag,
}: {
  entries: LibraryFile[];
  onMenu: (e: React.MouseEvent, path: string, recent: boolean) => void;
  folderMenu: (e: React.MouseEvent, path: string, root: boolean) => void;
  onDrag: (d: Drag | null) => void;
}) {
  const roots = useBrowser((s) => s.roots);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const hints = disambiguate(roots);
  const toggle = (p: string) => setShut((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])));
  const placed = new Set<string>();
  const trees = roots.map((root) => {
    const top: VNode = { path: root, dirs: new Map(), files: [] };
    for (const e of entries) {
      if (!under(e.path, root)) continue;
      placed.add(e.path);
      const parts = relParts(e.path, root);
      let n = top;
      for (const d of parts.slice(0, -1)) {
        let c = n.dirs.get(d.toLowerCase());
        if (!c) {
          c = { path: joinPath(n.path, d), dirs: new Map(), files: [] };
          n.dirs.set(d.toLowerCase(), c);
        }
        n = c;
      }
      n.files.push(e.path);
    }
    return top;
  });
  const rows: React.ReactNode[] = [];
  const walk = (n: VNode, depth: number, hint?: string) => {
    const open = !shut.has(n.path);
    rows.push(
      <div
        key={`d:${n.path}`}
        className={`bi fold${open ? "" : " closed"}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        data-tip={n.path}
        onClick={() => toggle(n.path)}
        onContextMenu={(e) => folderMenu(e, n.path, depth === 0)}
      >
        <Guides depth={depth} />
        <span className="tw">{CHEV}</span>
        <span className="ic">{FOLDER}</span>
        <span className="nm">
          {baseName(n.path)}
          {hint && <span className="rp"> {hint}</span>}
        </span>
      </div>,
    );
    if (!open) return;
    for (const c of [...n.dirs.values()].sort((a, b) => byName(a.path, b.path))) walk(c, depth + 1);
    for (const f of [...n.files].sort(byName)) rows.push(<FileRow key={f} path={f} depth={depth + 1.85} onMenu={(e, p) => onMenu(e, p, false)} onDrag={onDrag} />);
  };
  trees.forEach((t, i) => {
    if (t.dirs.size || t.files.length) walk(t, 0, hints[roots[i]]);
  });
  const rest = entries.filter((e) => !placed.has(e.path)).map((e) => e.path);
  if (rest.length) {
    rows.push(
      <div key="elsewhere" className="bsec nohover sub">
        <span className="bst">Elsewhere</span>
      </div>,
    );
    for (const p of rest.sort(byName)) rows.push(<FileRow key={p} path={p} depth={0} onMenu={(e) => onMenu(e, p, false)} onDrag={onDrag} showDir />);
  }
  if (!rows.length) rows.push(<div key="none" className="bi bnote">No files match. Clear a filter to see more.</div>);
  return <>{rows}</>;
}

/** Group by Type: one virtual folder per Type label, favourites first.
 * Files without a Type label sit in "No type yet". */
function ByType({ entries, onMenu, onDrag }: { entries: LibraryFile[]; onMenu: (e: React.MouseEvent, path: string, recent: boolean) => void; onDrag: (d: Drag | null) => void }) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setShut((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const order = (fs: LibraryFile[]) => [...fs].sort((a, b) => Number(b.fav) - Number(a.fav) || byName(a.path, b.path));
  const types = new Set(TYPE_LABELS.map((l) => l.id));
  const groups: { k: string; title: string; icon: React.ReactNode; files: LibraryFile[] }[] = [];
  for (const l of TYPE_LABELS) {
    const fs = entries.filter((e) => e.labels.includes(l.id));
    if (fs.length) groups.push({ k: l.id, title: l.name, icon: <LabelIcon icon={l.icon} color={l.color} />, files: order(fs) });
  }
  const none = entries.filter((e) => !e.labels.some((x) => types.has(x)));
  if (none.length) groups.push({ k: "", title: "No type yet", icon: <span className="tag">{TAG}</span>, files: order(none) });
  if (!groups.length) {
    return <div className="bi bnote">Favourite or label files to see them here by type</div>;
  }
  return (
    <>
      {groups.map((g) => {
        const open = !shut.has(g.k);
        return (
          <div key={g.k || "none"}>
            <div className={`bi fold${open ? "" : " closed"}`} onClick={() => toggle(g.k)}>
              <span className="tw">{CHEV}</span>
              {g.icon}
              <span className="nm">{g.title}</span>
              <span className="cnt">{g.files.length}</span>
            </div>
            {open && g.files.map((f) => <FileRow key={f.path} path={f.path} depth={1.85} onMenu={onMenu} onDrag={onDrag} showDir />)}
          </div>
        );
      })}
    </>
  );
}

/** The Browser's filter: label filters, ★ and `#label ★` in search. */
function useFilter(): LibraryFilter {
  useBrowser((s) => s.query);
  useBrowser((s) => s.filters);
  useBrowser((s) => s.favOnly);
  useLibrary((s) => s.custom);
  return useBrowser.getState().filter();
}


/** Where a dragged section header would land: before `before` (null: last). */
interface SecDrop {
  key: string;
  before: string | null;
  /** The section the line is drawn on, and on which side. */
  at: string;
  side: "before" | "after";
}

/** A collapsible section. Click the header to collapse it; drag the header
 * to reorder. Collapsed sections sit at the bottom of the panel. */
function Section({
  k,
  title,
  extra,
  drop,
  onDrop,
  children,
}: {
  k: string;
  title: string;
  /** Header controls, right-aligned (they don't collapse or drag it). */
  extra?: React.ReactNode;
  drop: SecDrop | null;
  onDrop: (d: SecDrop | null) => void;
  children: React.ReactNode;
}) {
  const shut = useBrowser((s) => s.shut.includes(k));
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const head = e.currentTarget;
    const y0 = e.clientY;
    let moved = false;
    let cur: SecDrop | null = null;
    head.setPointerCapture(e.pointerId);
    const target = (y: number): SecDrop | null => {
      // The sections in the group this one is shown in (open, or collapsed).
      const group = [...document.querySelectorAll<HTMLElement>(".browser .bsecw")].filter((el) => el.classList.contains("isshut") === shut);
      for (const el of group) {
        const r = el.getBoundingClientRect();
        const at = el.dataset.k ?? "";
        if (y < r.top + r.height / 2) return { key: k, before: at, at, side: "before" };
      }
      const last = group[group.length - 1]?.dataset.k;
      if (!last) return null;
      // Below the group's last section: before whatever follows it in the order.
      const order = useBrowser.getState().order;
      const next = order.slice(order.indexOf(last) + 1).find((x) => x !== k) ?? null;
      return { key: k, before: next, at: last, side: "after" };
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      if (!moved) {
        moved = true;
        document.body.classList.add("secdrag");
      }
      cur = target(ev.clientY);
      // Dropping right next to itself changes nothing: no line.
      onDrop(cur && cur.at !== k ? cur : { key: k, before: null, at: "", side: "before" });
    };
    const up = (ev: PointerEvent) => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      document.body.classList.remove("secdrag");
      onDrop(null);
      if (ev.type !== "pointerup") return;
      if (!moved) useBrowser.getState().toggleSection(k);
      else if (cur && cur.at !== k) useBrowser.getState().moveSection(k, cur.before);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  };
  const line = drop && drop.at === k ? ` drop-${drop.side}` : "";
  return (
    <div className={`bsecw${shut ? " isshut" : ""}${line}`} data-k={k}>
      <div
        className={`bsec${shut ? " shut" : ""}${drop?.key === k ? " dragging" : ""}`}
        onPointerDown={onDown}
        data-tip={shut ? "Expand" : "Collapse"}
        data-hint="Click to collapse or expand · drag to reorder the sections · collapsed sections sit at the bottom"
      >
        <span className="chev">{CHEV}</span>
        <span className="bst">{title}</span>
        {extra}
      </div>
      {!shut && <div className="bgrp">{children}</div>}
    </div>
  );
}

/** The preview's playhead, placed every frame from its clock. */
function PreviewHead({ len, width }: { len: number; width: number }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return onFrame((now) => {
      const x = Math.min(1, Math.max(0, previewClock.read(now) / len)) * width;
      el.style.transform = `translate3d(${snapPx(x)}px,0,0)`;
    });
  }, [len, width]);
  return <i className="pvph" ref={ref} />;
}

function Preview() {
  const current = useBrowser((s) => s.current);
  const info = useBrowser((s) => s.info);
  const playing = useBrowser((s) => s.playing);
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
    const mid = h / 2;
    const half = h / 2 - 3;
    const n = info.peaks.length;
    const col = (i: number) => info.peaks[Math.min(n - 1, Math.floor((i / w) * n))] ?? 0;
    x.fillStyle = token("--text-dim");
    for (let px = 0; px < w; px++) {
      const a = Math.min(1, col(px));
      x.fillRect(px, mid - Math.max(0.5, a * half), 1, Math.max(1, 2 * a * half));
    }
    x.fillStyle = token("--danger");
    for (let px = 0; px < w; px++) if (col(px) > 1) x.fillRect(px, 0, 1, 2);
  }, [info, cw]);
  // Nothing selected: no preview section at all, the list gets the room.
  if (!current) return null;
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
        data-hint="Click to play from there · Esc stops the preview"
      >
        <canvas ref={ref} />
        {playing && len > 0 && <PreviewHead len={len} width={cw} />}
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
      <FileMeta path={current} />
    </div>
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
  const order = useBrowser((s) => s.order);
  const shutSecs = useBrowser((s) => s.shut);
  const group = useBrowser((s) => s.group);
  const filters = useBrowser((s) => s.filters);
  const favOnly = useBrowser((s) => s.favOnly);
  const files = useLibrary((s) => s.files);
  const filter = useFilter();
  const filtering = filter.labels.length > 0 || filter.fav;
  const wide = useBrowser((s) => s.wide);
  const asideRef = useRef<HTMLElement>(null);
  const [secDrop, setSecDrop] = useState<SecDrop | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** The Labels submenu, open beside its item. */
  const [sub, setSub] = useState<{ x: number; y: number; flip: number; of: MenuState } | null>(null);
  const openSub = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const m = el.closest(".menu")?.getBoundingClientRect() ?? r;
    if (menu) setSub({ x: m.right - 2, y: r.top - 5, flip: m.left + 2, of: menu });
  };
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

  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => useBrowser.setState({ wide: el.clientWidth >= WIDE_PX }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!open) {
    return (
      <aside className="browser shut">
        <button
          className="rail"
          onClick={() => b().toggle()}
          onContextMenu={(e) => {
            e.preventDefault();
            useLayout.getState().openMenu("browser", e.clientX, e.clientY);
          }}
          data-tip="Show the Browser (Ctrl+Alt+B)"
        >
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
    const start = Math.round(s.playhead);
    const dir = dirName(path);
    const lib = useLibrary.getState();
    const items: MenuEntry[] = [
      { label: lib.isFav(path) ? "Remove from favourites" : "Add to favourites", keys: "F", run: () => lib.toggleFav(path) },
      { label: "Labels", keys: "L", labelsFor: path },
      "-",
      { label: "Preview", keys: "Click", run: () => void b().pick(path, true) },
      { label: "Add on a new track", run: () => place(path, null, start) },
      ...(sel ? [{ label: `Add to ${sel.name || "the selected track"}`, run: () => place(path, sel.id, start) }] : []),
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

  const entries = Object.values(files).filter((e) => matchesEntry(e, filter));
  const passes = (p: string) => matchesEntry(files[libraryKey(p)], filter);
  const shownRecent = filtering ? recent.filter(passes) : recent;
  const shownResults = results && filtering ? results.filter(passes) : results;
  const rootHints = disambiguate(roots);
  const pinHints = disambiguate(pins);
  const sections: Record<string, { title: string; extra?: React.ReactNode; body: React.ReactNode }> = {
    pins: {
      title: "Pinned folders",
      body: (
        <>
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
              <span className="nm">
                {baseName(p)}
                {pinHints[p] && <span className="rp"> {pinHints[p]}</span>}
              </span>
            </div>
          ))}
          {pins.length === 0 && <div className="bi bnote">Right-click any folder to pin it here</div>}
        </>
      ),
    },
    recent: {
      title: "Recent files",
      body: (
        <>
          {shownRecent.map((p) => (
            <FileRow key={p} path={p} depth={0} onMenu={(e) => fileMenu(e, p, true)} onDrag={setDrag} />
          ))}
          {shownRecent.length === 0 && <div className="bi bnote">{filtering ? "No recent files match" : "Files you open or add show up here"}</div>}
        </>
      ),
    },
    labels: {
      title: "Labels",
      extra: <ManageLabels />,
      body: <LabelCloud />,
    },
    folders: {
      title: group === "type" ? "By type" : "Folders",
      body:
        group === "type" ? (
          <ByType entries={entries} onMenu={fileMenu} onDrag={setDrag} />
        ) : filtering ? (
          <FilteredTree entries={entries} onMenu={fileMenu} folderMenu={folderMenu} onDrag={setDrag} />
        ) : (
          <>
            {roots.map((r) => (
              <FolderRow key={r} path={r} depth={0} root hint={rootHints[r]} onMenu={folderMenu} onFileMenu={fileMenu} onDrag={setDrag} />
            ))}
            <div className="bi badd" onClick={() => void addFolder()} data-tip="Add a folder to browse (or drop one here from Explorer)">
              <span className="ic">+</span>
              <span className="nm">Add folder…</span>
            </div>
          </>
        ),
    },
  };
  const section = (k: string) => (
    <Section key={k} k={k} title={sections[k].title} extra={sections[k].extra} drop={secDrop} onDrop={setSecDrop}>
      {sections[k].body}
    </Section>
  );

  return (
    <aside className={`browser${wide ? " wide" : ""}`} ref={asideRef}>
      <PanelHead id="browser">
        <button className="x" aria-label="Hide the Browser" onClick={() => b().toggle()} data-tip="Hide the Browser (Ctrl+Alt+B)">
          ‹
        </button>
        <span className="pht">Browser</span>
        <span className="sp" />
        <BrowserOptions />
      </PanelHead>
      <label className="search">
        <svg width="11" height="11" viewBox="0 0 16 16">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="m11 11 4 4" stroke="currentColor" strokeWidth="2" />
        </svg>
        <input
          value={query}
          placeholder="Search · #label · ★"
          aria-label="Search samples"
          onChange={(e) => b().search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") b().search("");
            e.stopPropagation();
          }}
        />
      </label>
      <div className="bview">
        <span className="glab">Group</span>
        <span className="grp">
          {(
            [
              ["folder", "Folder"],
              ["type", "Type"],
            ] as const
          ).map(([k, t]) => (
            <button key={k} className={group === k ? "on" : ""} onClick={() => b().setGroup(k)} data-tip={k === "type" ? "Group your labelled files by their Type label" : "Your folders, as they are on disk"}>
              {t}
            </button>
          ))}
        </span>
        <button className={`favf${favOnly ? " on" : ""}`} onClick={() => b().setFavOnly(!favOnly)} data-tip={favOnly ? "Showing only favourites · click to show all" : "Show only favourites"} aria-pressed={favOnly}>
          ★
        </button>
        {filters.map((id) => {
          const l = useLibrary.getState().label(id);
          if (!l) return null;
          return (
            <span key={id} className="chip flt">
              <LabelIcon icon={l.icon} color={l.color} />
              {l.name}
              <button className="chipx" aria-label={`Stop filtering by ${l.name}`} onClick={() => b().toggleFilter(id)}>
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div className="blist">
        {shownResults !== null ? (
          <>
            <div className="bsec nohover">
              <span className="bst">
                {shownResults.length} result{shownResults.length === 1 ? "" : "s"}
              </span>
            </div>
            {shownResults.map((p) => (
              <FileRow key={p} path={p} depth={0} onMenu={fileMenu} onDrag={setDrag} showDir />
            ))}
            {shownResults.length === 0 && (
              <div className="bi bnote">{filtering ? "Nothing by that name matches the filters" : "Nothing by that name in your folders or recent files"}</div>
            )}
          </>
        ) : (
          order.filter((k) => !shutSecs.includes(k)).map(section)
        )}
      </div>
      {shownResults === null && shutSecs.length > 0 && <div className="bshut">{order.filter((k) => shutSecs.includes(k)).map(section)}</div>}
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
            ) : it.labelsFor ? (
              <button
                key={i}
                className={`menu-item subm${sub?.of === menu ? " open" : ""}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={sub?.of === menu}
                onMouseEnter={(e) => openSub(e.currentTarget)}
                onClick={(e) => openSub(e.currentTarget)}
              >
                {it.label}
                <span className="subr">
                  {it.keys && <kbd>{it.keys}</kbd>}
                  <i className="car">▸</i>
                </span>
              </button>
            ) : (
              <button
                key={i}
                className="menu-item"
                role="menuitem"
                onMouseEnter={() => setSub(null)}
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
          {sub?.of === menu && <LabelSubmenu path={menu.path} at={sub} flip={sub.flip} close={() => setMenu(null)} />}
        </div>
      )}
      {drag && (
        <div className="dragchip" style={{ left: drag.x + 12, top: drag.y + 10 }}>
          <span className={`ft ft-${ext(drag.path)}`}>{ext(drag.path).toUpperCase()}</span>
          <span className="nm">{baseName(drag.path)}</span>
          {drag.label && <span className="dl">{drag.label}</span>}
        </div>
      )}
      <LabelPicker />
      <LabelDialogView />
    </aside>
  );
}
