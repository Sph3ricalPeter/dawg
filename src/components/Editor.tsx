import { useRef, useState } from "react";
import type { TrackState } from "@/lib/api";
import { addFilesDialog } from "@/lib/actions";
import { startDrag } from "@/lib/drag";
import { clamp, fmtDb, fmtMs, fmtSeconds, fmtTime } from "@/lib/format";
import { timelineEnd, useSession, useTracks } from "@/stores/session-store";
import { trackColor, useWheel } from "@/lib/timeline";
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

/** A value dragged up and down, FL style. */
function DragValue({
  value,
  label,
  hint,
  step,
  min,
  max,
  onDrag,
  onReset,
}: {
  value: number;
  label: string;
  hint: string;
  step: number;
  min: number;
  max: number;
  onDrag: (v: number, done: boolean) => void;
  onReset: () => void;
}) {
  const onDown = (e: React.PointerEvent) => {
    const v0 = value;
    let last = v0;
    startDrag(e, {
      move: (_dx, dy, ev) => {
        last = clamp(v0 - dy * step * (ev.shiftKey ? 0.2 : 1), min, max);
        onDrag(last, false);
      },
      end: (moved) => {
        if (moved) onDrag(last, true);
      },
    });
  };
  return (
    <span className="dv" onPointerDown={onDown} onDoubleClick={onReset} data-hint={hint}>
      {label}
    </span>
  );
}

function fmtRate(rate: number): string {
  const khz = rate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

function fmtPan(p: number): string {
  const v = Math.round(p * 100);
  return v === 0 ? "C" : v < 0 ? `L${-v}` : `R${v}`;
}

function TrackHeader({ track, index, tall }: { track: TrackState; index: number; tall: boolean }) {
  const session = useSession((s) => s.session);
  const selected = useSession((s) => s.selected);
  const [renaming, setRenaming] = useState(false);
  if (!session) return <div className="th" />;
  const store = useSession.getState;
  const mix = (m: { gain_db?: number; pan?: number; muted?: boolean; solo?: boolean }, done: boolean) => {
    const cmd = { type: "set_track_mix" as const, track: track.id, ...m };
    if (done) {
      void store().commit();
      return;
    }
    store().drag(cmd, {
      kind: "track",
      track: {
        ...track,
        gainDb: m.gain_db ?? track.gainDb,
        pan: m.pan ?? track.pan,
      },
    });
  };
  const rate = session.rate;
  // In a tall track, details of its selected clip (the scratch session's view).
  const clip = tall ? track.clips.find((c) => selected.includes(c.id)) ?? (track.clips.length === 1 ? track.clips[0] : null) : null;
  const src = clip ? session.sources.find((s) => s.id === clip.source) : null;
  const cutStart = clip ? clip.offset : 0;
  const cutEnd = clip && src ? src.frames - clip.offset - clip.len : 0;

  return (
    <div className="th">
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
                  void store().apply({ type: "rename_track", track: track.id, name: e.target.value });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <span
              style={{ ["--c" as string]: trackColor(index) }}
              onDoubleClick={() => setRenaming(true)}
              data-hint="Double-click to rename"
            >
              {track.name || `Track ${index + 1}`}
            </span>
          )}
          <button
            className="tx"
            title="Delete track"
            onClick={() => {
              void store()
                .apply({ type: "delete_track", track: track.id })
                .then((ok) => {
                  if (ok) store().showToast(`Deleted ${track.name || "the track"}`, { action: { label: "Undo", run: () => void store().undo() } });
                });
            }}
            data-hint="Delete the track and its clips"
          >
            ✕
          </button>
        </div>
        <div className="tcl">
          <button
            className={`ms m${track.muted ? " on" : ""}`}
            onClick={() => void store().apply({ type: "set_track_mix", track: track.id, muted: !track.muted })}
            data-hint="Mute"
          >
            M
          </button>
          <button
            className={`ms s${track.solo ? " on" : ""}`}
            onClick={() => void store().apply({ type: "set_track_mix", track: track.id, solo: !track.solo })}
            data-hint="Solo"
          >
            S
          </button>
          <DragValue
            value={track.gainDb <= -96 ? -60 : track.gainDb}
            label={fmtDb(track.gainDb)}
            hint="Track volume · drag up or down (Shift for fine) · double-click for 0 dB"
            step={0.25}
            min={-60}
            max={12}
            onDrag={(v, done) => {
              let db = Math.round(v * 10) / 10;
              if (Math.abs(db) < 0.3) db = 0;
              mix({ gain_db: db <= -60 ? -96 : db }, done);
            }}
            onReset={() => void store().apply({ type: "set_track_mix", track: track.id, gain_db: 0 })}
          />
          <DragValue
            value={track.pan}
            label={fmtPan(track.pan)}
            hint="Pan · drag up for right, down for left · double-click to centre"
            step={0.01}
            min={-1}
            max={1}
            onDrag={(v, done) => {
              let pan = Math.round(v * 100) / 100;
              if (Math.abs(pan) < 0.03) pan = 0;
              mix({ pan }, done);
            }}
            onReset={() => void store().apply({ type: "set_track_mix", track: track.id, pan: 0 })}
          />
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

/** The playlist: a ruler over the tracks, each a header and a lane. */
export function Editor() {
  const session = useSession((s) => s.session);
  const tracks = useTracks();
  const ref = useRef<HTMLDivElement>(null);
  useWheel(ref);
  if (!session) return null;
  const tall = tracks.length === 1;
  return (
    <div className="editor">
      <div className="corner">
        {tracks.length} track{tracks.length === 1 ? "" : "s"}
        <span className="r">{fmtRate(session.rate)}</span>
      </div>
      <Ruler />
      <div className={`tracks${tall ? " one" : ""}`} ref={ref} onPointerDownCapture={(e) => panWithMiddle(e, ref.current)}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      >
        {tracks.map((t, i) => (
          <div className={`trow${t.muted ? " muted" : ""}`} key={t.id}>
            <TrackHeader track={t} index={i} tall={tall} />
            <Lane track={t} index={i} />
          </div>
        ))}
        <div className="trow add">
          <div className="th">
            <button className="btn addbtn" onClick={() => void addFilesDialog()} data-hint="Add WAV or MP3 files, each on a new track at the playhead (Ctrl+Shift+O)">
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

