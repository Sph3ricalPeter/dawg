import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TrackState } from "@/lib/api";
import { addFilesDialog } from "@/lib/actions";
import { startDrag } from "@/lib/drag";
import { clamp, fmtTime } from "@/lib/format";
import { knobControl } from "@/lib/knob";
import { gridOf, scrollSpan, snapStep, timelineLimit, useSession, useTracks } from "@/stores/session-store";
import { COLORS, rulerStep, trackColor, useWheel } from "@/lib/timeline";
import { ease } from "@/lib/smooth-view";
import { touched, tracksScroll } from "@/lib/view-memory";
import { BEATS_PER_BAR, barStep, beatFrames, snapTo } from "@/lib/grid";
import { Knob } from "@/ui/Knob";
import { MenuItem, MenuSep, PopMenu } from "@/ui/Menu";
import { LevelMeter } from "@/ui/Meter";
import { HEADER_LAW } from "@/ui/meter-law";
import { onFrame } from "@/lib/frame-loop";
import { Volume } from "./Volume";
import { Lane } from "./Lane";
import { PanelHead } from "./Dock";
import { LabelIcon } from "./BrowserLabels";
import { CATEGORIES, categoryById } from "@/lib/categories";
import { Playhead } from "./Playhead";
import { Button } from "@/ui/Button";


function Ruler() {
  const session = useSession((s) => s.session);
  const view = useSession((s) => s.view);
  const width = useSession((s) => s.width);
  const range = useSession((s) => s.range);
  const units = useSession((s) => gridOf(s).units);
  const ref = useRef<HTMLDivElement>(null);
  if (!session) return <div className="ruler" />;

  const rate = session.rate;
  const ticks = [];
  if (units === "bars") {
    // Labels on bars, or bar.beat zoomed in; four small ticks between.
    const beat = beatFrames(rate, session.bpm);
    const pxPerBeat = beat / view.fpp;
    const step = barStep(pxPerBeat);
    const b0 = view.start / beat;
    const b1 = (view.start + width * view.fpp) / beat;
    for (let k = Math.floor(b0 / step); k * step <= b1; k++) {
      const b = k * step;
      const x = (b - b0) * pxPerBeat;
      const bar = Math.floor(b / BEATS_PER_BAR + 1e-9) + 1;
      const inBar = b - (bar - 1) * BEATS_PER_BAR;
      const label = Math.abs(inBar) < 1e-9 ? `${bar}` : Number.isInteger(Math.round(inBar * 1e6) / 1e6) ? `${bar}.${Math.round(inBar) + 1}` : "";
      ticks.push(
        <div key={k} className={`tk maj${label.includes(".") ? " sub" : ""}`} style={{ left: x }}>
          {label && <span className="lb">{label}</span>}
        </div>,
      );
      for (let m = 1; m < 4; m++) {
        const xm = x + (m * step * pxPerBeat) / 4;
        if (xm > width) break;
        ticks.push(<div key={`${k}.${m}`} className="tk" style={{ left: xm }} />);
      }
    }
  } else {
    const pxPerSec = rate / view.fpp;
    const step = rulerStep(pxPerSec);
    const digits = step >= 1 ? 0 : step >= 0.1 ? (step === 0.25 ? 2 : 1) : step >= 0.01 ? 2 : 3;
    const t0 = view.start / rate;
    const t1 = (view.start + width * view.fpp) / rate;
    for (let k = Math.floor(t0 / step); k * step <= t1; k++) {
      const t = k * step;
      const x = (t - t0) * pxPerSec;
      ticks.push(
        <div key={k} className="tk maj" style={{ left: x }}>
          <span className="lb">{fmtTime(t, digits)}</span>
        </div>,
      );
      for (let m = 1; m < 5; m++) {
        const xm = x + (m * step * pxPerSec) / 5;
        if (xm > width) break;
        ticks.push(<div key={`${k}.${m}`} className="tk" style={{ left: xm }} />);
      }
    }
  }

  // Reads the live view, so it stays right while a drag scrolls it. Past
  // either edge of the ruler the view scrolls along with the mouse.
  const toFrame = (clientX: number, follow = false) => {
    const r = ref.current!.getBoundingClientRect();
    const st = useSession.getState();
    const over = clientX < r.left ? clientX - r.left : clientX > r.right ? clientX - r.right : 0;
    if (follow && over) st.scrollTo(st.view.start + over * st.view.fpp * 0.5);
    const v = useSession.getState().view;
    return clamp(v.start + (clamp(clientX, r.left, r.right) - r.left) * v.fpp, 0, timelineLimit(session));
  };
  // Snaps to the grid (the ruler's small ticks with snap on Line); Alt is
  // smooth (mockup snapT).
  const snapped = (clientX: number, alt: boolean, follow = false) => {
    const f = toFrame(clientX, follow);
    return alt ? f : snapTo(f, snapStep());
  };
  // As in the mockup: a plain drag scrubs the playhead, Ctrl+drag makes the
  // range (loop, crop, export), and a click places the playhead and clears
  // the range.
  const onDown = (e: React.PointerEvent) => {
    const a = snapped(e.clientX, e.altKey);
    const store = useSession.getState();
    if (e.ctrlKey || e.metaKey) {
      startDrag(e, {
        move: (_dx, _dy, ev) => {
          const b = snapped(ev.clientX, ev.altKey, true);
          // Snapped to the same tick, there's no range yet.
          store.setRange(a === b ? null : { a: Math.min(a, b), b: Math.max(a, b) });
        },
        end: (moved) => {
          if (moved && useSession.getState().range) store.rangeLoop();
          else store.setRange(null);
        },
      });
      return;
    }
    if (e.button !== 0) return;
    store.scrub(a);
    let at = a;
    startDrag(e, {
      slop: 0,
      move: (_dx, _dy, ev) => {
        at = snapped(ev.clientX, ev.altKey, true);
        store.scrub(at);
      },
      end: (moved) => {
        if (!moved) store.setRange(null);
        store.setPlayhead(at);
      },
    });
  };
  const onDouble = () => {
    const st = useSession.getState();
    const s = st.session;
    if (s && s.end > s.start) {
      st.setRange({ a: s.start, b: s.end });
      st.rangeLoop();
    }
  };

  const px = (f: number) => (f - view.start) / view.fpp;
  return (
    <div
      className="ruler"
      ref={ref}
      onPointerDown={onDown}
      onDoubleClick={onDouble}
      data-hint="Click or drag to move the playhead · Ctrl+drag sets the range (loop, crop, export) · both snap to the grid, hold Alt for smooth · double-click ranges over every clip"
    >
      {ticks}
      {range && (
        <div className="rr" style={{ left: px(range.a), width: Math.max(1, (range.b - range.a) / view.fpp) }} />
      )}
      <Playhead className="ph" />
    </div>
  );
}

function fmtRate(rate: number): string {
  const khz = rate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** The track's stereo level meter, live while playing. */
function TrackMeter({ index }: { index: number }) {
  const playing = useSession((s) => s.playing);
  return <LevelMeter className="tm" vertical law={HEADER_LAW} live={playing} read={() => useSession.getState().levels[index]} />;
}

function fmtPan(p: number): string {
  const v = Math.round(p * 100);
  return v === 0 ? "C" : v < 0 ? `L${v * -1}` : `R${v}`;
}


interface MenuAt {
  x: number;
  y: number;
}

/** The track's right-click menu. */
function TrackMenu({
  at,
  track,
  onRename,
  onClose,
}: {
  at: MenuAt;
  track: TrackState;
  onRename: () => void;
  onClose: () => void;
}) {
  const store = useSession.getState;
  // Moves past the next track with a lane, skipping mixer-only channels.
  const neighbour = (by: -1 | 1) => {
    const all = store().session?.tracks ?? [];
    const lanes = all.filter((t) => t.lane);
    return lanes[lanes.findIndex((t) => t.id === track.id) + by];
  };
  const moveTo = (by: -1 | 1) => {
    const n = neighbour(by);
    const all = store().session?.tracks ?? [];
    if (n) void store().apply({ type: "move_track", track: track.id, index: all.indexOf(n) });
  };
  const item = (label: string, keys: string, run: () => void, disabled = false) => (
    <MenuItem label={label} keys={keys} run={run} close={onClose} disabled={disabled} />
  );

  return (
    <PopMenu at={at} title={track.name || "Track"} onClose={onClose}>
      {item("Rename…", "Dbl-click", onRename)}
      <MenuSep />
      <div className="cats" role="group" aria-label="Track category">
        {CATEGORIES.map((k) => (
          <button
            key={k.id}
            className={`cat${track.category === k.id ? " on" : ""}`}
            style={{ ["--c" as string]: COLORS[k.color] }}
            data-tip={track.category === k.id ? `${k.name} · click to clear` : k.name}
            onClick={() => {
              onClose();
              void store().apply({ type: "set_track_category", track: track.id, category: track.category === k.id ? null : k.id });
            }}
          >
            <LabelIcon icon={k.icon} />
          </button>
        ))}
      </div>
      <div className="swatches" role="group" aria-label="Track colour">
        {COLORS.map((c, i) => (
          <button
            key={c}
            className={`swatch${track.color === i ? " on" : ""}`}
            style={{ background: c }}
            data-tip="Track colour"
            onClick={() => {
              onClose();
              void store().apply({ type: "set_track_color", track: track.id, color: track.color === i ? null : i });
            }}
          />
        ))}
      </div>
      <MenuSep />
      {item("Show its chain", "", () => store().selectChannel(track.id, true))}
      <MenuSep />
      {item("Move up", "Alt+↑", () => moveTo(-1), !neighbour(-1))}
      {item("Move down", "Alt+↓", () => moveTo(1), !neighbour(1))}
      <MenuSep />
      {item("Add track", "Ctrl+Shift+T", () => void store().addTrack())}
      {item("Delete track", "", () => {
        void store()
          .apply({ type: "delete_track", track: track.id })
          .then((ok) => {
            if (ok)
              store().showToast(`Deleted ${track.name || "the track"}`, {
                action: { label: "Undo", run: () => void store().undo() },
              });
          });
      })}
    </PopMenu>
  );
}

function TrackHeader({
  track,
  index,
  onResize,
}: {
  track: TrackState;
  index: number;
  onResize: (e: React.PointerEvent) => void;
}) {
  const session = useSession((s) => s.session);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const selected = useSession((s) => s.channel === track.id);
  const category = categoryById(track.category);
  if (!session) return <div className="th" />;
  const store = useSession.getState;
  const mix = (m: { gain_db?: number; pan?: number }, done: boolean) => {
    if (done) {
      void store().commit();
      return;
    }
    store().drag(
      { type: "set_track_mix", track: track.id, ...m },
      {
        kind: "track",
        track: {
          ...track,
          gainDb: m.gain_db ?? track.gainDb,
          pan: m.pan ?? track.pan,
        },
      },
    );
  };
  const setMix = (m: { gain_db?: number; pan?: number; muted?: boolean; solo?: boolean }) =>
    void store().apply({ type: "set_track_mix", track: track.id, ...m });
  const pan = Math.round(track.pan * 100);
  const panKnob = knobControl(pan, { rate: 1, min: -100, max: 100, step: 10, res: 1, detent: 4 }, (v, done) => mix({ pan: v / 100 }, done));

  return (
    <div
      className={`th${selected ? " sel" : ""}`}
      data-chan={track.id}
      style={{ ["--c" as string]: trackColor(index, track.color, track.category) }}
      onPointerDown={() => store().channel !== track.id && store().selectChannel(track.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        className="rsz"
        onPointerDown={onResize}
        data-hint="Drag to resize this track · Alt+drag resizes all · Alt+wheel over the playlist resizes all · double-click resets"
      />
      <div className="ti">
        <div className="tn">
          {renaming ? (
            <input
              className="rn"
              autoFocus
              defaultValue={track.name}
              onBlur={(e) => {
                setRenaming(false);
                if (e.target.value.trim() && e.target.value !== track.name) {
                  void store().apply({
                    type: "rename_track",
                    track: track.id,
                    name: e.target.value,
                  });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <span
              onDoubleClick={() => setRenaming(true)}
              data-hint={`${category ? `${category.name} · ` : ""}Double-click to rename · right-click for the category, colour and other track options`}
            >
              {category && <LabelIcon icon={category.icon} />}
              {track.name || `Track ${index + 1}`}
            </span>
          )}
        </div>
        <div className="tcl">
          <button
            className={`ms m${track.muted ? " on" : ""}`}
            onClick={() => setMix({ muted: !track.muted })}
            data-hint="Track on/off (click to mute)"
          >
            {index + 1}
          </button>
          <button className={`ms s${track.solo ? " on" : ""}`} onClick={() => setMix({ solo: !track.solo })} data-hint="Solo">
            S
          </button>
          <Volume
            className="trk"
            db={track.gainDb}
            hint="Track volume"
            onDrag={(gain_db, done) => mix({ gain_db }, done)}
            onSet={(gain_db) => setMix({ gain_db })}
            before={<TrackMeter index={index} />}
          />
          <div
            className="pan"
            data-hint={`Pan ${fmtPan(track.pan)} · drag up/down (Shift fine, Ctrl 10% steps) · double-click centres`}
            {...panKnob}
            onDoubleClick={() => setMix({ pan: 0 })}
          >
            <Knob f={pan / 100} bipolar color="var(--k-pan)" />
          </div>
        </div>
      </div>
      {menu && <TrackMenu at={menu} track={track} onRename={() => setRenaming(true)} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Scrollbar() {
  const session = useSession((s) => s.session);
  const view = useSession((s) => s.view);
  const width = useSession((s) => s.width);
  if (!session) return <div className="hscroll" />;
  const total = scrollSpan(session, view, width);
  const shown = width * view.fpp;
  if (shown >= total) return <div className="hscroll" />;
  const thumbW = Math.max(24, (shown / total) * width);
  const left = (view.start / (total - shown)) * (width - thumbW);
  const onDown = (e: React.PointerEvent) => {
    const s0 = view.start;
    startDrag(e, {
      move: (dx) => {
        useSession.getState().scrollTo(s0 + (dx / (width - thumbW)) * (total - shown));
      },
      end: () => undefined,
    });
  };
  return (
    <div className="hscroll">
      <div className="thumb" style={{ left, width: thumbW }} onPointerDown={onDown} />
    </div>
  );
}

/** Middle-drag grabs the arrangement and moves it, as in the mockup. */
function panWithMiddle(e: React.PointerEvent, el: HTMLElement | null) {
  if (e.button !== 1 || !el) return;
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const s0 = useSession.getState().view.start;
  const top0 = el.scrollTop;
  document.body.classList.add("panning");
  const move = (ev: PointerEvent) => {
    const s = useSession.getState();
    s.scrollTo(s0 - (ev.clientX - x0) * s.view.fpp);
    el.scrollTop = top0 - (ev.clientY - y0);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("panning");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** An Alt+wheel track-height zoom in flight: every track's height when it
 * began, scaled by `s` as it eases toward `to`. */
type VZoom = { base: Record<number, number>; s: number; to: number; lo: number; hi: number; stop: () => void };

const TRACK_MIN_H = 44;
const TRACK_MAX_H = 400;

/** The playlist: a ruler over the tracks, each a header and a lane. */
/** The Timeline panel's header: its name, track count and rate. */
export function TimelineHead() {
  const count = useSession((s) => s.session?.tracks.filter((t) => t.lane).length ?? null);
  const rate = useSession((s) => s.session?.rate ?? null);
  return (
    <PanelHead id="timeline">
      <span className="pht">Timeline</span>
      {count !== null && rate !== null && (
        <span className="phm">
          {count} track{count === 1 ? "" : "s"} · {fmtRate(rate)}
        </span>
      )}
      <span className="sp" />
    </PanelHead>
  );
}

export function Editor() {
  const session = useSession((s) => s.session);
  // Every channel, for its number and colour; the timeline shows the ones
  // with a lane.
  const channels = useTracks();
  const tracks = channels.filter((t) => t.lane);
  const ref = useRef<HTMLDivElement>(null);
  // In the store, so they're remembered with the file's view.
  const heights = useSession((s) => s.heights);
  const setHeights = useSession((s) => s.setHeights);
  const fileRev = useSession((s) => s.fileRev);
  const shown = !!session;
  // A file just opened scrolls back to where it was left.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || tracksScroll.pending === null) return;
    el.scrollTop = tracksScroll.pending;
    tracksScroll.pending = null;
    tracksScroll.top = el.scrollTop;
  }, [fileRev, shown]);
  // Alt+wheel scales every track's height, eased over a few frames; the
  // point under the mouse stays put.
  const anchor = useRef<{ row: number; frac: number; y: number } | null>(null);
  const vz = useRef<VZoom | null>(null);
  const lastClick = useRef<{ id: number; at: number } | null>(null);
  useEffect(() => () => vz.current?.stop(), []);
  useWheel(ref, (factor, clientY) => {
    const el = ref.current;
    if (!el) return;
    const rows = [...el.querySelectorAll<HTMLElement>(":scope > .trow:not(.add)")];
    const box = el.getBoundingClientRect();
    const i = rows.findIndex((r) => r.getBoundingClientRect().bottom > clientY);
    const row = i < 0 ? rows.length - 1 : i;
    const rb = rows[row]?.getBoundingClientRect();
    if (rb) anchor.current = { row, frac: (clientY - rb.top) / rb.height, y: clientY - box.top };
    if (!vz.current) {
      const base: Record<number, number> = {};
      tracks.forEach((t, j) => (base[t.id] = rows[j]?.getBoundingClientRect().height ?? 76));
      const hs = Object.values(base);
      if (!hs.length) return;
      const lo = TRACK_MIN_H / Math.max(...hs);
      const hi = TRACK_MAX_H / Math.min(...hs);
      const z: VZoom = { base, s: 1, to: 1, lo, hi, stop: () => {} };
      z.stop = onFrame((_now, dt) => {
        z.s = ease(z.s, z.to, dt);
        const done = Math.abs(Math.log(z.to / z.s)) < 1e-3;
        if (done) z.s = z.to;
        const next: Record<number, number> = {};
        for (const id in z.base) next[id] = clamp(z.base[id] * z.s, TRACK_MIN_H, TRACK_MAX_H);
        setHeights(next);
        if (done) {
          z.stop();
          vz.current = null;
        }
      });
      vz.current = z;
    }
    const z = vz.current;
    z.to = clamp(z.to * factor, z.lo, z.hi);
  });
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = ref.current;
    if (!a || !el) return;
    if (!vz.current) anchor.current = null;
    const r = el.querySelectorAll<HTMLElement>(":scope > .trow:not(.add)")[a.row];
    if (!r) return;
    const rb = r.getBoundingClientRect();
    el.scrollTop += rb.top + a.frac * rb.height - (el.getBoundingClientRect().top + a.y);
  }, [heights]);
  if (!session) return null;
  const tall = tracks.length === 1;
  // The header's bottom edge resizes the track; Alt resizes every track and
  // a double-click goes back to the default height.
  const resetHeight = (id: number, all: boolean) => {
    vz.current?.stop();
    vz.current = null;
    anchor.current = null;
    setHeights((h) => {
      const n = { ...h };
      for (const t of all ? tracks : tracks.filter((t) => t.id === id)) delete n[t.id];
      return n;
    });
  };
  const resize = (e: React.PointerEvent, id: number) => {
    const row = (e.currentTarget as HTMLElement).closest(".trow") as HTMLElement;
    const h0 = row.getBoundingClientRect().height;
    const all = e.altKey;
    document.body.classList.add("rsizing");
    startDrag(e, {
      // A click doesn't resize, so the handle stays under the mouse for the
      // second click of a double-click, which is told here rather than by
      // dblclick (the row can shift under the mouse between the two).
      move: (_dx, dy) => {
        const v = Math.round(clamp(h0 + dy, TRACK_MIN_H, TRACK_MAX_H));
        setHeights((h) => {
          const n = { ...h };
          for (const t of all ? tracks : tracks.filter((t) => t.id === id)) n[t.id] = v;
          return n;
        });
      },
      end: (moved, ev) => {
        document.body.classList.remove("rsizing");
        const now = performance.now();
        const last = lastClick.current;
        lastClick.current = moved ? null : { id, at: now };
        if (!moved && last && last.id === id && now - last.at < 450) {
          lastClick.current = null;
          resetHeight(id, ev.altKey || all);
        }
      },
    });
  };
  return (
    <div className="editor">
      <div className="corner" />
      <Ruler />
      <div
        className={`tracks${tall ? " one" : ""}`}
        ref={ref}
        onScroll={(e) => {
          tracksScroll.top = e.currentTarget.scrollTop;
          touched();
        }}
        onPointerDownCapture={(e) => panWithMiddle(e, ref.current)}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      >
        {tracks.map((t) => (
          <div
            className={`trow${t.muted ? " muted" : ""}${heights[t.id] ? " sized" : ""}`}
            key={t.id}
            style={heights[t.id] ? { height: heights[t.id] } : undefined}
          >
            <TrackHeader track={t} index={channels.indexOf(t)} onResize={(e) => resize(e, t.id)} />
            <Lane track={t} index={channels.indexOf(t)} />
          </div>
        ))}
        {/* The ghost track: one dashed drop box over header and lane, like
            the empty project's. The lane under it is the drop target. */}
        <div className="trow add" data-hint="Drop WAV or MP3 files here, each gets a new track">
          <div className="th" />
          <div className="lane addlane" />
          <div className="addbox">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3" />
            </svg>
            <div className="addmsg">
              <strong>Drop WAV or MP3 files here for new tracks</strong>
              <span>or drop onto a track to add it there</span>
            </div>
            <div className="addsep" />
            <Button
              className="addbtn"
              onClick={() => void addFilesDialog()}
              data-hint="Add WAV or MP3 files, each on a new track at the playhead (Ctrl+Shift+O)"
            >
              + Add files… <kbd>Ctrl+Shift+O</kbd>
            </Button>
            <Button variant="ghost" className="addbtn" onClick={() => void useSession.getState().addTrack()} data-hint="Add an empty track">
              + Track
            </Button>
          </div>
        </div>
      </div>
      <div className="hscroll-corner" />
      <Scrollbar />
    </div>
  );
}
