import { rulerStep } from "./timeline";

/** Snap settings from the timeline menu. "line" follows the ruler's small
 * ticks at the current zoom (FL's "Line"); the rest are musical. */
export type Snap = "off" | "line" | "bar" | "beat" | "1/2" | "1/4" | "1/8";
export type Units = "bars" | "time";

export const SNAPS: { v: Snap; label: string }[] = [
  { v: "line", label: "Line" },
  { v: "bar", label: "Bar" },
  { v: "beat", label: "Beat" },
  { v: "1/2", label: "½ beat" },
  { v: "1/4", label: "¼ beat" },
  { v: "1/8", label: "⅛ beat" },
  { v: "off", label: "Off" },
];

export const BEATS_PER_BAR = 4;

export function beatFrames(rate: number, bpm: number): number {
  return (rate * 60) / bpm;
}

/** Beats between ruler labels in bars mode, picked so labels sit at least
 * ~70 px apart. */
const BEAT_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];

export function barStep(pxPerBeat: number): number {
  return BEAT_STEPS.find((s) => s * pxPerBeat >= 70) ?? 256;
}

/** Frames between snap points, or null with snap off. */
export function snapFrames(snap: Snap, units: Units, rate: number, bpm: number, fpp: number): number | null {
  const beat = beatFrames(rate, bpm);
  switch (snap) {
    case "off":
      return null;
    case "bar":
      return beat * BEATS_PER_BAR;
    case "beat":
      return beat;
    case "1/2":
      return beat / 2;
    case "1/4":
      return beat / 4;
    case "1/8":
      return beat / 8;
    case "line":
      return units === "bars" ? (barStep(beat / fpp) / 4) * beat : (rulerStep(rate / fpp) / 5) * rate;
  }
}

/** `frame` on the nearest snap point; unchanged with snap off. */
export function snapTo(frame: number, step: number | null): number {
  return step ? Math.round(Math.round(frame / step) * step) : frame;
}

/** "5.1.1": bar, beat and sixteenth, counted from 1. */
export function fmtBars(frame: number, rate: number, bpm: number): string {
  const sixteenths = Math.floor((frame / beatFrames(rate, bpm)) * 4 + 1e-6);
  const bar = Math.floor(sixteenths / (BEATS_PER_BAR * 4)) + 1;
  const beat = (Math.floor(sixteenths / 4) % BEATS_PER_BAR) + 1;
  const six = (sixteenths % 4) + 1;
  return `${bar}.${beat}.${six}`;
}

/** A typed position: "5.1.1" (bars), "0:12.5" (time), or a number with at
 * most one dot, read in `units` ("5.3" is bar 5 beat 3, or 5.3 seconds).
 * Returns a frame, or null when it doesn't parse. */
export function parsePosition(text: string, rate: number, bpm: number, units: Units): number | null {
  const t = text.trim();
  const bars = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(t);
  const dots = t.split(".").length - 1;
  if (bars && (dots === 2 || (units === "bars" && !t.includes(":")))) {
    const bar = Number(bars[1]) - 1;
    const beat = Number(bars[2] ?? 1) - 1;
    const six = Number(bars[3] ?? 1) - 1;
    if (bar < 0 || beat < 0 || six < 0) return null;
    return Math.round((bar * BEATS_PER_BAR + beat + six / 4) * beatFrames(rate, bpm));
  }
  const time = /^(?:(\d+):)?(\d+(?:\.\d*)?)$/.exec(t);
  if (time) return Math.round(((time[1] ? Number(time[1]) * 60 : 0) + Number(time[2])) * rate);
  return null;
}
