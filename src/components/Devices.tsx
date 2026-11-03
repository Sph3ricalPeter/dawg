import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, type BandKind, type CompParams, type DeviceParams, type DeviceState, type EqBand, type Spectrum, type UtilityParams } from "@/lib/api";
import { commitDrag, setDeviceParams } from "@/lib/chain-edit";
import { startDrag } from "@/lib/drag";
import {
  bandResponse,
  clampBand,
  fmtHz,
  fmtHzShort,
  hasGain,
  isCut,
  KIND_NAMES,
  MAX_BANDS,
  MAX_FREQ,
  MAX_GAIN_DB,
  MAX_Q,
  MIN_FREQ,
  MIN_Q,
  SLOPES,
} from "@/lib/eq";
import { clamp, fmtDb } from "@/lib/format";
import { everyFrameAtMost, meterStep, onFrame } from "@/lib/frame-loop";
import { type KnobControl, knobControl } from "@/lib/knob";
import { paramsOf } from "@/lib/mixer";
import { choice, setSetting } from "@/lib/settings";
import { useSession } from "@/stores/session-store";
import { Knob } from "./Knob";
import { alpha, token } from "@/ui/tokens";

/* ------------------------------------------------------------------ */
/* Knobs with real units                                               */
/* ------------------------------------------------------------------ */

type Concern = "vol" | "pan" | "time";

/** A device parameter: its range, unit and what its knob colour means. */
export interface ParamDef<K extends string> {
  key: K;
  label: string;
  min: number;
  max: number;
  /** Logarithmic travel (times, ratios). */
  log?: boolean;
  unit: "dB" | "ms" | ":1" | "%" | "x%";
  concern: Concern;
  hint: string;
}

const norm = (d: ParamDef<string>, v: number) =>
  d.log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min);
const denorm = (d: ParamDef<string>, n: number) => (d.log ? d.min * Math.pow(d.max / d.min, n) : d.min + n * (d.max - d.min));

/** A value as its knob reads it. */
function fmtParam(d: ParamDef<string>, v: number): string {
  switch (d.unit) {
    case "dB":
      return fmtDb(v);
    case "ms":
      return v < 10 ? `${v.toFixed(1)} ms` : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
    case ":1":
      return `${v < 10 ? v.toFixed(1) : Math.round(v)}:1`;
    case "%":
      return `${Math.round(v * 100)}%`;
    case "x%":
      return `${Math.round(v * 100)}%`;
  }
}

/** Rounds a dragged value to what its readout can show. */
function tidy(d: ParamDef<string>, v: number): number {
  if (d.unit === "dB") return Math.round(v * 10) / 10;
  if (d.unit === "%" || d.unit === "x%") return Math.round(v * 100) / 100;
  if (d.unit === "ms") return v < 10 ? Math.round(v * 100) / 100 : Math.round(v);
  return Math.round(v * 10) / 10;
}

/** Knob travel in 0..1, so log and linear params drag alike. */
const TRAVEL = { rate: 1 / 160, min: 0, max: 1, step: 0.05, res: 0.0005, detent: 0 };

export function ParamKnob<K extends string>({
  def,
  value,
  reset,
  onValue,
  size = 28,
}: {
  def: ParamDef<K>;
  value: number;
  reset: number;
  onValue: (v: number, done: boolean) => void;
  size?: number;
}) {
  const ctl: KnobControl = knobControl(norm(def, value), TRAVEL, (n, done) => onValue(tidy(def, denorm(def, n)), done));
  return (
    <div
      className="pk"
      {...ctl}
      onDoubleClick={() => onValue(reset, true)}
      data-hint={`${def.label} ${fmtParam(def, value)} · ${def.hint} · drag up or down (Shift fine) · double-click resets`}
    >
      <Knob f={norm(def, value)} size={size} color={`var(--k-${def.concern})`} />
      <b className="mono">{fmtParam(def, value)}</b>
      <label>{def.label}</label>
    </div>
  );
}

/** Changes one field of a device's params. `done` ends a drag (its last
 * value becomes one undo step); a one-off change (a reset, a toggle) comes
 * as `done` with no drag before it and applies straight away. */
function paramSetter<P extends DeviceParams>(device: DeviceState, params: P) {
  return <K extends keyof P>(key: K, v: P[K], done: boolean) => {
    if (done && useSession.getState().draft) commitDrag();
    else setDeviceParams(device, { ...params, [key]: v }, !done);
  };
}

/* ------------------------------------------------------------------ */
/* Compressor                                                          */
/* ------------------------------------------------------------------ */

const COMP: ParamDef<keyof CompParams>[] = [
  { key: "thresholdDb", label: "Threshold", min: -60, max: 0, unit: "dB", concern: "vol", hint: "Level where it starts to compress" },
  { key: "ratio", label: "Ratio", min: 1, max: 20, log: true, unit: ":1", concern: "time", hint: "How hard it pushes down over the threshold" },
  { key: "attackMs", label: "Attack", min: 0.05, max: 200, log: true, unit: "ms", concern: "time", hint: "How fast it clamps down" },
  { key: "releaseMs", label: "Release", min: 5, max: 2000, log: true, unit: "ms", concern: "time", hint: "How fast it lets go" },
  { key: "kneeDb", label: "Knee", min: 0, max: 24, unit: "dB", concern: "time", hint: "Softens the turn at the threshold" },
  { key: "makeupDb", label: "Makeup", min: -12, max: 24, unit: "dB", concern: "vol", hint: "Gain after compression" },
  { key: "mix", label: "Mix", min: 0, max: 1, unit: "%", concern: "time", hint: "Dry and compressed blend (parallel compression)" },
];
const COMP_DEFAULT: CompParams = { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 100, kneeDb: 6, makeupDb: 0, mix: 1 };

/** Most gain reduction the meter shows. */
const GR_RANGE = 24;

/** The compressor's gain reduction meter: falls from the top, drawn every
 * frame from the latest reading with the meters' ballistics. */
function GrMeter({ device }: { device: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const playing = useSession((s) => s.playing);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let shown = 0;
    let w = 0;
    let h = 0;
    let lastText = "";
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(c.clientWidth * dpr);
      const ch = Math.round(c.clientHeight * dpr);
      if (cw !== w || ch !== h) {
        w = c.width = cw;
        h = c.height = ch;
      }
      const x = c.getContext("2d");
      if (!x) return;
      x.fillStyle = "#060606";
      x.fillRect(0, 0, w, h);
      const f = clamp(shown / GR_RANGE, 0, 1);
      x.fillStyle = "#e07a3c";
      x.fillRect(0, 0, w, Math.round(f * h));
      const t = shown >= 0.05 ? `−${shown.toFixed(1)}` : "0.0";
      if (text.current && t !== lastText) text.current.textContent = lastText = t;
    };
    if (!playing) {
      draw();
      return;
    }
    return onFrame((_, dt) => {
      const gr = useSession.getState().reduction[device] ?? 0;
      // Attack instant, release at 24 dB/s, as the level meters.
      shown = gr >= shown ? gr : Math.max(gr, shown - 24 * dt);
      draw();
    });
  }, [playing, device]);
  return (
    <div className="grm" data-hint="Gain reduction: how far the compressor is turning the signal down">
      <span ref={text} className="mono">
        0.0
      </span>
      <canvas ref={canvas} />
      <label>GR</label>
    </div>
  );
}

export function CompressorBody({ device }: { device: DeviceState & { kind: "compressor" } }) {
  const p = paramsOf(device);
  const set = paramSetter(device, p);
  return (
    <div className="cbody">
      <div className="kgrid">
        {COMP.map((d) => (
          <ParamKnob key={d.key} def={d} value={p[d.key]} reset={COMP_DEFAULT[d.key]} onValue={(v, done) => set(d.key, v, done)} />
        ))}
      </div>
      <GrMeter device={device.id} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */

const UTIL: ParamDef<"gainDb" | "width">[] = [
  { key: "gainDb", label: "Gain", min: -48, max: 24, unit: "dB", concern: "vol", hint: "Level before the fader" },
  { key: "width", label: "Width", min: 0, max: 2, unit: "x%", concern: "pan", hint: "Stereo width: 0% mono, 100% as is, 200% twice as wide" },
];

export function UtilityBody({ device }: { device: DeviceState & { kind: "utility" } }) {
  const p = paramsOf(device);
  const set = paramSetter(device, p);
  const toggle = (key: keyof UtilityParams & ("mono" | "flipL" | "flipR" | "dc"), label: string, hint: string) => (
    <button className={p[key] ? "on" : ""} onClick={() => set(key, !p[key], true)} data-hint={hint}>
      {label}
    </button>
  );
  return (
    <div className="cbody">
      <div className="kgrid two">
        <ParamKnob def={UTIL[0]} value={p.gainDb} reset={0} onValue={(v, done) => set("gainDb", v, done)} />
        <ParamKnob def={UTIL[1]} value={p.width} reset={1} onValue={(v, done) => set("width", v, done)} />
      </div>
      <div className="tgl">
        {toggle("mono", "Mono", "Sums left and right to mono")}
        {toggle("flipL", "Ø Left", "Flips the left channel's phase")}
        {toggle("flipR", "Ø Right", "Flips the right channel's phase")}
        {toggle("dc", "DC", "Removes DC offset (a very low cut)")}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* EQ: a Pro-Q style curve with a node per band                        */
/* ------------------------------------------------------------------ */

const GRID_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
/** Display ranges in dB, as in Pro-Q: the curve's scale, not a limit. */
const RANGES = [12, 30];

/** The graph's scales: frequency ↔ x across `w` px, log from 10 Hz to
 * `top`; dB ↔ y over `h` px, ±`range` dB. */
function geometry(w: number, h: number, top: number, range: number) {
  const l0 = Math.log(MIN_FREQ);
  const l1 = Math.log(top);
  return {
    x: (hz: number) => ((Math.log(hz) - l0) / (l1 - l0)) * w,
    hz: (x: number) => Math.exp(l0 + (x / w) * (l1 - l0)),
    y: (db: number) => h / 2 - (db / range) * (h / 2 - 8),
    dbAt: (py: number) => ((h / 2 - py) / (h / 2 - 8)) * range,
  };
}

/** The analyser's scale: 0 dBFS at the top, this many dB below at the
 * bottom. */
const SPECTRUM_FLOOR = 96;
/** Analyser tilt in dB per octave around 1 kHz, as in Pro-Q, so pink noise
 * reads flat. */
const TILT = 4.5;
/** How fast the analyser falls, in dB per second. */
const SPECTRUM_FALL = 50;

/** The analyser as drawn: what the last poll said (`target`, null when
 * nothing new played) and where each bin is shown, easing toward it every
 * frame with Pro-Q style rise-and-fall. */
interface Analyser {
  target: Spectrum | null;
  shown: Spectrum | null;
}

/** Polls the spectrum after `device` while its card is shown, and calls
 * `draw` every frame the analyser moves. One analyser listens at a time:
 * the selected EQ's. */
function useSpectrum(device: number | null, an: Analyser, draw: () => void) {
  useEffect(() => {
    if (device === null || !isTauri()) return;
    let live = true;
    const stopPoll = everyFrameAtMost(30, () =>
      api
        .spectrum(device)
        .then((s) => {
          if (live) an.target = s;
        })
        .catch(() => undefined),
    );
    const stopFrame = onFrame((_, dt) => {
      const { target } = an;
      let shown = an.shown;
      if (!shown && !target) return;
      if (target && (!shown || shown.db.length !== target.db.length)) shown = { ...target, db: target.db.map(() => -SPECTRUM_FLOOR - 48) };
      if (!shown) return;
      const db = shown.db.map((d, i) => meterStep(d, target ? target.db[i] : -Infinity, dt, SPECTRUM_FALL, 0.02));
      an.shown = !target && db.every((d) => d < -SPECTRUM_FLOOR - 24) ? null : { ...(target ?? shown), db };
      draw();
    });
    return () => {
      live = false;
      stopPoll();
      stopFrame();
      an.target = null;
      an.shown = null;
      draw();
      void api.spectrum(null).catch(() => undefined);
    };
  }, [device, an, draw]);
}

/** A new band where the user double-clicked: cuts at the far ends, a bell
 * anywhere else. */
function newBand(hz: number, db: number): EqBand {
  const kind: BandKind = hz < 40 ? "low_cut" : hz > 14_000 ? "high_cut" : "bell";
  return clampBand({ kind, freq: hz, gainDb: hasGain(kind) ? db : 0, q: kind === "bell" ? 1 : Math.SQRT1_2, slope: 24, on: true });
}

export function EqBody({ device, color, listen }: { device: DeviceState & { kind: "eq" }; color: string; listen: boolean }) {
  const rate = useSession((s) => s.session?.rate ?? 48_000);
  const bands = device.bands;
  const off = !device.on;
  const [sel, setSel] = useState(0);
  const [range, setRangeState] = useState(() => choice<number>("eqRange", RANGES, RANGES[0]));
  const setRange = (r: number) => {
    setSetting("eqRange", r);
    setRangeState(r);
  };
  const graph = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 360, h: 160 });
  const wheelTimer = useRef<number | undefined>(undefined);
  // The grid and analyser go on a canvas of their own under the curve, so
  // the analyser redraws every frame without redrawing the bands.
  const back = useRef<HTMLCanvasElement>(null);
  const [an] = useState<Analyser>(() => ({ target: null, shown: null }));
  const drawBack = useRef<() => void>(() => undefined);
  const redrawBack = useCallback(() => drawBack.current(), []);
  useSpectrum(listen ? device.id : null, an, redrawBack);

  useLayoutEffect(() => {
    const el = graph.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const top = Math.min(MAX_FREQ, rate / 2);
  const ax = geometry(size.w, size.h, top, range);
  const { y, dbAt } = ax;

  useLayoutEffect(() => {
    const c = back.current;
    if (!c) return;
    const ax = geometry(size.w, size.h, top, range);
    const { y } = ax;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const x = c.getContext("2d");
    if (!x) return;
    drawBack.current = () => {
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      // Grid.
      x.font = `500 10px ${getComputedStyle(c).getPropertyValue("--mono") || "sans-serif"}`;
      x.textBaseline = "top";
      for (const hz of GRID_HZ) {
        if (hz > top) continue;
        const gx = Math.round(ax.x(hz)) + 0.5;
        x.fillStyle = token("--line");
        x.fillRect(gx, 0, 1, h);
        x.fillStyle = token("--fill-strong");
        x.fillText(fmtHzShort(hz), gx + 3, h - 12);
      }
      const step = range <= 12 ? 6 : 10;
      for (let db = -range; db <= range; db += step) {
        const gy = Math.round(y(db)) + 0.5;
        x.fillStyle = db === 0 ? token("--line-dash") : token("--bg-3");
        x.fillRect(0, gy, w, 1);
        if (db !== -range && db !== range) {
          x.fillStyle = token("--fill-strong");
          x.fillText(`${db > 0 ? "+" : ""}${db}`, w - 22, gy + 2);
        }
      }
      // What the channel sounds like after the EQ.
      const spec = an.shown;
      if (spec) {
        const n = spec.db.length;
        const ratio = spec.toHz / spec.fromHz;
        x.beginPath();
        x.moveTo(0, h);
        for (let i = 0; i < n; i++) {
          const hz = spec.fromHz * Math.pow(ratio, i / (n - 1));
          if (hz > top) break;
          const db = spec.db[i] + TILT * Math.log2(hz / 1000);
          x.lineTo(ax.x(hz), clamp((-db / SPECTRUM_FLOOR) * h, 0, h));
        }
        x.lineTo(w, h);
        x.closePath();
        x.fillStyle = alpha("--white", 0.07);
        x.fill();
        x.strokeStyle = alpha("--white", 0.16);
        x.lineWidth = 1;
        x.stroke();
      }
    };
    drawBack.current();
  }, [size, range, top, an]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ax = geometry(size.w, size.h, top, range);
    const { y } = ax;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const x = c.getContext("2d");
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    // Each band faintly, then the sum.
    const live = off ? [] : bands.filter((b) => b.on);
    const fns = live.map((b) => bandResponse(b, rate));
    const pts: number[] = [];
    for (let px = 0; px <= w; px += 2) {
      const hz = ax.hz(px);
      pts.push(fns.reduce((sum, f) => sum + f(hz), 0));
    }
    fns.forEach((f, i) => {
      const selected = bands.indexOf(live[i]) === sel;
      x.beginPath();
      for (let px = 0; px <= w; px += 2) {
        const py = y(clamp(f(ax.hz(px)), -range * 1.2, range * 1.2));
        if (px === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
      }
      x.lineTo(w, y(0));
      x.lineTo(0, y(0));
      x.closePath();
      x.fillStyle = selected ? alpha("--white", 0.1) : alpha("--white", 0.04);
      x.fill();
    });
    x.beginPath();
    pts.forEach((db, i) => {
      const py = y(clamp(db, -range * 1.2, range * 1.2));
      if (i === 0) x.moveTo(0, py);
      else x.lineTo(i * 2, py);
    });
    x.strokeStyle = off ? token("--text-faint") : color;
    x.lineWidth = 2;
    x.stroke();
  }, [bands, off, size, range, rate, sel, color, top]);

  const band = bands[sel] ?? null;

  const send = (next: EqBand[], live: boolean) => setDeviceParams(device, { kind: "eq", bands: next }, live);
  const setBand = (i: number, b: EqBand, live: boolean) => send(bands.map((x, k) => (k === i ? clampBand(b) : x)), live);

  // Wheel changes Q, as in Pro-Q; the steps settle into one undo step.
  const onWheelBand = (i: number, e: React.WheelEvent) => {
    e.stopPropagation();
    const b = bands[i];
    setSel(i);
    setBand(i, { ...b, q: b.q * Math.exp(e.deltaY * (e.shiftKey ? 0.0003 : 0.0015)) }, true);
    window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(commitDrag, 350);
  };

  const dragNode = (e: React.PointerEvent, i: number, bs: EqBand[]) => {
    const b0 = bs[i];
    const r = graph.current!.getBoundingClientRect();
    const x0 = ax.x(b0.freq);
    const g0 = b0.gainDb;
    const dbPerPx = range / (size.h / 2 - 8);
    startDrag(e, {
      slop: 1,
      move: (dx, dy, ev) => {
        // Shift moves a tenth as far.
        const k = ev.shiftKey ? 0.1 : 1;
        const hz = ax.hz(clamp(x0 + dx * k, 0, r.width));
        let g = hasGain(b0.kind) ? clamp(Math.round((g0 - dy * k * dbPerPx) * 10) / 10, -MAX_GAIN_DB, MAX_GAIN_DB) : 0;
        if (!ev.altKey && Math.abs(g) < 0.3) g = 0;
        const next = bs.map((x, j) => (j === i ? clampBand({ ...b0, freq: Math.round(hz * 10) / 10, gainDb: g }) : x));
        send(next, true);
      },
      end: (moved) => {
        if (moved) commitDrag();
      },
    });
  };

  const onGraphDouble = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".eqn")) return;
    if (bands.length >= MAX_BANDS) {
      useSession.getState().showToast(`An EQ holds ${MAX_BANDS} bands`);
      return;
    }
    const r = graph.current!.getBoundingClientRect();
    const b = newBand(ax.hz(e.clientX - r.left), Math.round(dbAt(e.clientY - r.top) * 10) / 10);
    send([...bands, b], false);
    setSel(bands.length);
  };

  const remove = (i: number) => {
    send(
      bands.filter((_, k) => k !== i),
      false,
    );
    setSel((s) => (s >= i ? Math.max(0, s - 1) : s));
  };

  const knob = (
    label: string,
    value: string,
    f: number,
    bipolar: boolean,
    onDown: KnobControl,
    onReset: (() => void) | null,
    hint: string,
    concern: Concern,
  ) => (
    <div className="eqk" {...onDown} onDoubleClick={onReset ?? undefined} data-hint={hint}>
      <Knob f={f} bipolar={bipolar} size={26} color={`var(--k-${concern})`} />
      <div>
        <div className="eql">{label}</div>
        <div className="eqv mono">{value}</div>
      </div>
    </div>
  );

  const lf = (hz: number) => (Math.log(hz) - Math.log(MIN_FREQ)) / (Math.log(MAX_FREQ) - Math.log(MIN_FREQ));
  const lq = (q: number) => (Math.log(q) - Math.log(MIN_Q)) / (Math.log(MAX_Q) - Math.log(MIN_Q));
  const drag = (f: (v: number) => EqBand) => (v: number, done: boolean) => (done ? commitDrag() : setBand(sel, f(v), true));

  return (
    <div className="cbody eqbody" style={{ ["--c" as string]: color }}>
      <div
        className="eqg"
        ref={graph}
        onDoubleClick={onGraphDouble}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || e.target === canvas.current) setSel(-1);
        }}
        data-hint="Double-click to add a band (a cut at either end, a bell between) · drag a band to move it · wheel over a band for its width · right-click deletes"
      >
        <canvas ref={back} />
        <canvas ref={canvas} />
        {bands.map((b, i) => {
          const nx = ax.x(Math.min(b.freq, top));
          const ny = hasGain(b.kind) ? y(clamp(b.gainDb, -range, range)) : y(clamp(bandResponse(b, rate)(b.freq), -range, range));
          return (
            <div
              key={i}
              className={`eqn${i === sel ? " sel" : ""}${b.on && !off ? "" : " off"}`}
              style={{ left: nx, top: ny }}
              onPointerDown={(e) => {
                setSel(i);
                dragNode(e, i, bands);
              }}
              onWheel={(e) => onWheelBand(i, e)}
              onDoubleClick={() => hasGain(b.kind) && setBand(i, { ...b, gainDb: 0 }, false)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                remove(i);
              }}
              data-hint={`${KIND_NAMES[b.kind]} ${fmtHz(b.freq)}${hasGain(b.kind) ? ` ${fmtDb(b.gainDb)}` : ""} · drag to move (Shift fine, Alt skips the 0 dB snap) · wheel for width · double-click for 0 dB · right-click deletes`}
            >
              {i + 1}
            </div>
          );
        })}
        <button
          className="eqrange mono"
          onClick={() => setRange(RANGES[(RANGES.indexOf(range) + 1) % RANGES.length])}
          data-hint="Display range of the curve"
        >
          ±{range}
        </button>
      </div>
      <div className="eqs">
        {band ? (
          <>
            <div className="eqrow">
              <span className="eqnum">{sel + 1}</span>
              <select value={band.kind} onChange={(e) => setBand(sel, { ...band, kind: e.target.value as BandKind }, false)} data-hint="Band shape">
                {(Object.keys(KIND_NAMES) as BandKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_NAMES[k]}
                  </option>
                ))}
              </select>
              <button className={`pw${band.on ? "" : " off"}`} onClick={() => setBand(sel, { ...band, on: !band.on }, false)} data-hint="Turns this band on or off" />
              <button className="eqx" onClick={() => remove(sel)} data-hint="Deletes this band (or right-click it)">
                ✕
              </button>
            </div>
            <div className="eqrow knobs">
              {knob(
                "Freq",
                fmtHz(band.freq),
                lf(band.freq),
                false,
                knobControl(
                  Math.log2(band.freq),
                  { rate: 0.02, min: Math.log2(MIN_FREQ), max: Math.log2(MAX_FREQ), step: 1 / 3, res: 0.001, detent: 0 },
                  drag((v) => ({ ...band, freq: Math.round(2 ** v * 10) / 10 })),
                ),
                null,
                "Frequency · drag up or down (Shift fine, Ctrl in third-octaves)",
                "time",
              )}
              {hasGain(band.kind) &&
                knob(
                  "Gain",
                  fmtDb(band.gainDb),
                  band.gainDb / MAX_GAIN_DB,
                  true,
                  knobControl(
                    band.gainDb,
                    { rate: 0.1, min: -MAX_GAIN_DB, max: MAX_GAIN_DB, step: 1, res: 0.1, detent: 0.3 },
                    drag((v) => ({ ...band, gainDb: v })),
                  ),
                  () => setBand(sel, { ...band, gainDb: 0 }, false),
                  "Gain · drag up or down (Shift fine, Ctrl 1 dB steps) · double-click for 0 dB",
                  "vol",
                )}
              {knob(
                isCut(band.kind) ? "Reso" : "Q",
                band.q.toFixed(2),
                lq(band.q),
                false,
                knobControl(
                  Math.log2(band.q),
                  { rate: 0.015, min: Math.log2(MIN_Q), max: Math.log2(MAX_Q), step: 0.5, res: 0.001, detent: 0 },
                  drag((v) => ({ ...band, q: Math.round(2 ** v * 1000) / 1000 })),
                ),
                () => setBand(sel, { ...band, q: isCut(band.kind) || band.kind.endsWith("shelf") ? Math.SQRT1_2 : 1 }, false),
                isCut(band.kind) ? "Resonance at the corner · 0.71 is flat · double-click resets" : "Width: higher is narrower · double-click resets",
                "time",
              )}
              {isCut(band.kind) && (
                <div className="eqslope" data-hint="Slope of the cut in dB per octave">
                  {SLOPES.map((s) => (
                    <button key={s} className={s === band.slope ? "on" : ""} onClick={() => setBand(sel, { ...band, slope: s }, false)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="dim eqhelp">
            {bands.length ? `${bands.length} band${bands.length === 1 ? "" : "s"}. ` : ""}Double-click the curve to add a band. Drag a band to
            move it, use the wheel over it for its width, and right-click to delete it.
          </p>
        )}
      </div>
    </div>
  );
}
