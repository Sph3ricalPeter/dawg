import { useEffect, useRef, useState } from "react";
import type { TrackState } from "@/lib/api";
import { addFilesDialog } from "@/lib/actions";
import { startDrag } from "@/lib/drag";
import { clamp, fmtDb, fmtMs, fmtSeconds, fmtTime, MIN_GAIN_DB } from "@/lib/format";
import { dragKnob, parseDb, volKnobFrac } from "@/lib/knob";
import { timelineEnd, useSession, useTracks } from "@/stores/session-store";
import { trackColor, useWheel } from "@/lib/timeline";
import { Knob } from "./Knob";
import { Lane } from "./Lane";

/** Seconds between ruler labels, picked so labels sit at least ~70 px apart. */
const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function Ruler() {
  const session = useSession((s) => s.session);
  const view = useSession((s) => s.view);
  const width = useSession((s) => s.width);
  const playhead = useSession((s) => s.playhead);
  const range = useSession((s) => s.range);
  const ref = useRef<HTMLDivElement>(null);
  if (!session) return <div className="ruler" />;

  const rate = session.rate;
  const pxPerSec = rate / view.fpp;
  const step = STEPS.find((s) => s * pxPerSec >= 70) ?? 600;
  const digits = step >= 1 ? 0 : step >= 0.1 ? (step === 0.25 ? 2 : 1) : step >= 0.01 ? 2 : 3;
  const t0 = view.start / rate;
  const t1 = (view.start + width * view.fpp) / rate;
  const ticks = [];
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

  const toFrame = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp(view.start + (clientX - r.left) * view.fpp, 0, timelineEnd(session) * 1.5);
  };
  // As in the mockup: a plain drag scrubs the playhead, Ctrl+drag makes the
  // range (loop, crop, export), and a click places the playhead and clears
  // the range.
  const onDown = (e: React.PointerEvent) => {
    const a = toFrame(e.clientX);
    const store = useSession.getState();
    if (e.ctrlKey || e.metaKey) {
      startDrag(e, {
        move: (_dx, _dy, ev) => {
          const b = toFrame(ev.clientX);
          store.setRange({ a: Math.min(a, b), b: Math.max(a, b) });
        },
        end: (moved) => {
          if (moved) store.rangeLoop();
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
        at = toFrame(ev.clientX);
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
      data-hint="Click or drag to move the playhead · Ctrl+drag sets the range (loop, crop, export) · double-click ranges over every clip"
    >
      {ticks}
      {range && (
        <div className="rr" style={{ left: px(range.a), width: Math.max(1, (range.b - range.a) / view.fpp) }} />
      )}
      <div className="ph" style={{ left: px(playhead) }} />
    </div>
  );
}

function fmtRate(rate: number): string {
  const khz = rate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

function fmtPan(p: number): string {
  const v = Math.round(p * 100);
  return v === 0 ? "C" : v < 0 ? `L${v * -1}` : `R${v}`;
}

/** Track volume knob range, as in the mockup. */
const VOL_MIN = -48;
const VOL_MAX = 6;

/** A number typed in place of a knob's readout. */
function TypeIn({ value, onDone }: { value: string; onDone: (text: string | null) => void }) {
  return (
    <input
      className="ktype"
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => onDone(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onDone(null);
        e.stopPropagation();
      }}
    />
  );
}

interface MenuAt {
  x: number;
  y: number;
}

/** The track's right-click menu. */
function TrackMenu({ at, track, onRename, onClose }: { at: MenuAt; track: TrackState; onRename: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);
  const store = useSession.getState;
  const item = (label: string, keys: string, run: () => void) => (
    <button
      className="menu-item"
      role="menuitem"
      onClick={() => {
        onClose();
        run();
      }}
    >
      {label}
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
  return (
    <div className="menu ctx" role="menu" ref={ref} style={{ left: at.x, top: at.y }}>
      <div className="menu-head">
        <b>{track.name || "Track"}</b>
      </div>
      {item("Rename…", "Dbl-click", onRename)}
      <div className="menu-sep" />
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
    </div>
  );
}

function TrackHeader({
  track,
  index,
  tall,
  onResize,
  onResetHeight,
}: {
  track: TrackState;
  index: number;
  tall: boolean;
  onResize: (e: React.PointerEvent) => void;
  onResetHeight: (all: boolean) => void;
}) {
  const session = useSession((s) => s.session);
  const selected = useSession((s) => s.selected);
  const [renaming, setRenaming] = useState(false);
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);
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
  const vol = track.gainDb <= MIN_GAIN_DB ? VOL_MIN : track.gainDb;
  const pan = Math.round(track.pan * 100);
  const rate = session.rate;
  // In a tall track, details of its selected clip (the scratch session's view).
  const clip = tall ? (track.clips.find((c) => selected.includes(c.id)) ?? (track.clips.length === 1 ? track.clips[0] : null)) : null;
  const src = clip ? session.sources.find((s) => s.id === clip.source) : null;
  const cutStart = clip ? clip.offset : 0;
  const cutEnd = clip && src ? src.frames - clip.offset - clip.len : 0;

  return (
    <div
      className="th"
      style={{ ["--c" as string]: trackColor(index) }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        className="rsz"
        onPointerDown={onResize}
        onDoubleClick={(e) => onResetHeight(e.altKey)}
        data-hint="Drag to resize this track · Alt+drag resizes all · double-click resets"
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
            <span onDoubleClick={() => setRenaming(true)} data-hint="Double-click to rename · right-click for track options">
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
          <div
            className="vk"
            data-hint="Track volume · drag up/down (Shift fine, Ctrl 1 dB steps) · double-click the number to type, the knob to reset"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest(".vv, .ktype")) return;
              dragKnob(
                e,
                vol,
                {
                  rate: 0.25,
                  min: VOL_MIN,
                  max: VOL_MAX,
                  step: 1,
                  res: 0.1,
                  detent: 0.3,
                },
                (v, done) => mix({ gain_db: v }, done),
              );
            }}
            onDoubleClick={(e) => {
              if (!(e.target as HTMLElement).closest(".vv, .ktype")) setMix({ gain_db: 0 });
            }}
          >
            <span className="tm">
              <i>
                <b />
              </i>
              <i>
                <b />
              </i>
            </span>
            <Knob f={volKnobFrac(track.gainDb)} />
            {typing ? (
              <TypeIn
                value={fmtDb(track.gainDb, false).replace("dB", "")}
                onDone={(t) => {
                  setTyping(false);
                  if (t === null) return;
                  const db = parseDb(t);
                  if (db === -Infinity) setMix({ gain_db: MIN_GAIN_DB });
                  else if (Number.isFinite(db)) setMix({ gain_db: clamp(db, VOL_MIN, 12) });
                }}
              />
            ) : (
              <span className="vv" onDoubleClick={() => setTyping(true)}>
                {fmtDb(track.gainDb).replace(" dB", "")}
              </span>
            )}
          </div>
          <div
            className="pan"
            data-hint={`Pan ${fmtPan(track.pan)} · drag up/down (Shift fine, Ctrl 10% steps) · double-click centres`}
            onPointerDown={(e) =>
              dragKnob(e, pan, { rate: 1, min: -100, max: 100, step: 10, res: 1, detent: 4 }, (v, done) => mix({ pan: v / 100 }, done))
            }
            onDoubleClick={() => setMix({ pan: 0 })}
          >
            <Knob f={pan / 100} bipolar />
          </div>
        </div>
        {clip && src && (
          <div className="tinfo">
            <div className="dim">{src.name}</div>
            <div className="kv">
              <span>Length</span>
              <span className="mono">{fmtSeconds(clip.len / rate)}</span>
              {(cutStart > 0 || cutEnd > 0) && (
                <>
                  <span>Cut</span>
                  <span className="mono">
                    {(cutStart / rate).toFixed(3)} + {(cutEnd / rate).toFixed(3)} s
                  </span>
                </>
              )}
              <span>Gain</span>
              <span className="mono">{fmtDb(clip.gainDb)}</span>
              <span>Fades</span>
              <span className="mono">
                {fmtMs(clip.fadeIn, rate)} · {fmtMs(clip.fadeOut, rate)}
              </span>
              {clip.envelope.length > 0 && (
                <>
                  <span>Envelope</span>
                  <span className="mono">{clip.envelope.length} points</span>
                </>
              )}
            </div>
            {session.truncated && src.path === session.path && (
              <div className="warn-note">The file ended early; saving writes a repaired header.</div>
            )}
          </div>
        )}
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
  const total = timelineEnd(session) * 1.5;
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

const TRACK_MIN_H = 44;
const TRACK_MAX_H = 400;

/** The playlist: a ruler over the tracks, each a header and a lane. */
export function Editor() {
  const session = useSession((s) => s.session);
  const tracks = useTracks();
  const ref = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<Record<number, number>>({});
  useWheel(ref);
  if (!session) return null;
  const tall = tracks.length === 1;
  // The header's bottom edge resizes the track; Alt resizes every track and
  // a double-click goes back to the default height.
  const resetHeight = (id: number, all: boolean) =>
    setHeights((h) => {
      const n = { ...h };
      for (const t of all ? tracks : tracks.filter((t) => t.id === id)) delete n[t.id];
      return n;
    });
  const resize = (e: React.PointerEvent, id: number) => {
    const row = (e.currentTarget as HTMLElement).closest(".trow") as HTMLElement;
    const h0 = row.getBoundingClientRect().height;
    const all = e.altKey;
    document.body.classList.add("rsizing");
    startDrag(e, {
      slop: 0,
      move: (_dx, dy) => {
        const v = Math.round(clamp(h0 + dy, TRACK_MIN_H, TRACK_MAX_H));
        setHeights((h) => {
          const n = { ...h };
          for (const t of all ? tracks : tracks.filter((t) => t.id === id)) n[t.id] = v;
          return n;
        });
      },
      end: () => document.body.classList.remove("rsizing"),
    });
  };
  return (
    <div className="editor">
      <div className="corner">
        {tracks.length} track{tracks.length === 1 ? "" : "s"}
        <span className="r">{fmtRate(session.rate)}</span>
      </div>
      <Ruler />
      <div
        className={`tracks${tall ? " one" : ""}`}
        ref={ref}
        onPointerDownCapture={(e) => panWithMiddle(e, ref.current)}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      >
        {tracks.map((t, i) => (
          <div
            className={`trow${t.muted ? " muted" : ""}${heights[t.id] ? " sized" : ""}`}
            key={t.id}
            style={heights[t.id] ? { height: heights[t.id] } : undefined}
          >
            <TrackHeader
              track={t}
              index={i}
              tall={tall}
              onResize={(e) => resize(e, t.id)}
              onResetHeight={(all) => resetHeight(t.id, all)}
            />
            <Lane track={t} index={i} />
          </div>
        ))}
        <div className="trow add">
          <div className="th">
            <button
              className="btn addbtn"
              onClick={() => void addFilesDialog()}
              data-hint="Add WAV or MP3 files, each on a new track at the playhead (Ctrl+Shift+O)"
            >
              + Add files…
            </button>
            <button className="btn ghost addbtn" onClick={() => void useSession.getState().addTrack()} data-hint="Add an empty track">
              + Track
            </button>
          </div>
          <div className="lane addlane" data-hint="Drop WAV or MP3 files here, each gets a new track">
            <span className="lhint">Drop files here for new tracks · drop onto a track to add there</span>
          </div>
        </div>
      </div>
      <div className="hscroll-corner" />
      <Scrollbar />
    </div>
  );
}
