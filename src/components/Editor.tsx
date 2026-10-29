import { useRef } from "react";
import { startDrag } from "@/lib/drag";
import { clamp, fmtDb, fmtFormat, fmtMs, fmtSeconds, fmtTime, stem } from "@/lib/format";
import { useClip, useSession } from "@/stores/session-store";
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

  const rate = session.format.sampleRate;
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
    return clamp(view.start + (clientX - r.left) * view.fpp, 0, session.frames);
  };
  const onDown = (e: React.PointerEvent) => {
    const a = toFrame(e.clientX);
    const store = useSession.getState();
    startDrag(e, {
      move: (_dx, _dy, ev) => {
        const b = toFrame(ev.clientX);
        store.setRange({ a: Math.min(a, b), b: Math.max(a, b) });
      },
      end: (moved) => {
        if (!moved) {
          store.setRange(null);
          store.setPlayhead(a);
        }
      },
    });
  };
  const onDouble = () => {
    const c = useSession.getState().session?.clip;
    if (c) useSession.getState().setRange({ a: c.start, b: c.start + c.len });
  };

  const px = (f: number) => (f - view.start) / view.fpp;
  return (
    <div
      className="ruler"
      ref={ref}
      onPointerDown={onDown}
      onDoubleClick={onDouble}
      data-hint="Click to place the playhead · drag for a range · double-click selects the whole clip"
    >
      {ticks}
      {range && (
        <div className="rr" style={{ left: px(range.a), width: Math.max(1, (range.b - range.a) / view.fpp) }} />
      )}
      <div className="ph" style={{ left: px(playhead) }} />
    </div>
  );
}

function TrackHeader() {
  const session = useSession((s) => s.session);
  const clip = useClip();
  if (!session || !clip) return <div className="th" />;
  const rate = session.format.sampleRate;
  const cutStart = clip.offset;
  const cutEnd = session.frames - clip.offset - clip.len;
  return (
    <div className="th">
      <div className="ti">
        <div className="tn">
          <span style={{ ["--c" as string]: "#ee9f98" }} title={session.path}>
            {stem(session.name)}
          </span>
        </div>
        <div className="tinfo">
          <div className="dim">{fmtFormat(session.format, session.kbps)}</div>
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
          </div>
          {session.truncated && (
            <div className="warn-note">The file ended early; saving writes a repaired header.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Scrollbar() {
  const session = useSession((s) => s.session);
  const view = useSession((s) => s.view);
  const width = useSession((s) => s.width);
  if (!session) return <div className="hscroll" />;
  const total = session.frames * 1.03;
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

/** The playlist, cut down to the one track a scratch session edits. */
export function Editor() {
  return (
    <div className="editor">
      <div className="corner">1 track</div>
      <Ruler />
      <TrackHeader />
      <Lane />
      <div className="hscroll-corner" />
      <Scrollbar />
    </div>
  );
}
