import type { BandKind, EqBand } from "./api";

/** Limits, as in `dawg_core::eq`. */
export const MAX_BANDS = 12;
export const MIN_FREQ = 10;
export const MAX_FREQ = 30_000;
export const MAX_GAIN_DB = 30;
export const MIN_Q = 0.025;
export const MAX_Q = 40;
export const SLOPES = [6, 12, 18, 24, 36, 48];

export const KIND_NAMES: Record<BandKind, string> = {
  bell: "Bell",
  low_shelf: "Low shelf",
  high_shelf: "High shelf",
  low_cut: "Low cut",
  high_cut: "High cut",
  notch: "Notch",
  band_pass: "Band pass",
};

/** Bands whose gain means something. */
export function hasGain(kind: BandKind): boolean {
  return kind === "bell" || kind === "low_shelf" || kind === "high_shelf";
}

export function isCut(kind: BandKind): boolean {
  return kind === "low_cut" || kind === "high_cut";
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** The band's biquads at `rate`, as `EqBand::sections` in dawg-core. */
function sections(b: EqBand, rate: number): Biquad[] {
  const f = Math.min(b.freq, (rate / 2) * 0.98);
  const w0 = (2 * Math.PI * f) / rate;
  const c = Math.cos(w0);
  const alpha = (q: number) => Math.sin(w0) / (2 * q);
  const A = Math.pow(10, b.gainDb / 40);
  switch (b.kind) {
    case "bell": {
      const al = alpha(b.q);
      return [norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A)];
    }
    case "low_shelf":
    case "high_shelf": {
      const s = 2 * Math.sqrt(A) * alpha(b.q);
      return b.kind === "high_shelf"
        ? [
            norm(
              A * (A + 1 + (A - 1) * c + s),
              -2 * A * (A - 1 + (A + 1) * c),
              A * (A + 1 + (A - 1) * c - s),
              A + 1 - (A - 1) * c + s,
              2 * (A - 1 - (A + 1) * c),
              A + 1 - (A - 1) * c - s,
            ),
          ]
        : [
            norm(
              A * (A + 1 - (A - 1) * c + s),
              2 * A * (A - 1 - (A + 1) * c),
              A * (A + 1 - (A - 1) * c - s),
              A + 1 + (A - 1) * c + s,
              -2 * (A - 1 + (A + 1) * c),
              A + 1 + (A - 1) * c - s,
            ),
          ];
    }
    case "notch": {
      const al = alpha(b.q);
      return [norm(1, -2 * c, 1, 1 + al, -2 * c, 1 - al)];
    }
    case "band_pass": {
      const al = alpha(b.q);
      return [norm(al, 0, -al, 1 + al, -2 * c, 1 - al)];
    }
    case "low_cut":
    case "high_cut": {
      const high = b.kind === "low_cut";
      const order = Math.max(1, Math.floor(b.slope / 6));
      const out: Biquad[] = [];
      if (order % 2 === 1) {
        const k = Math.tan(w0 / 2);
        out.push(high ? norm(1, -1, 0, 1 + k, k - 1, 0) : norm(k, k, 0, 1 + k, k - 1, 0));
      }
      const pairs = Math.floor(order / 2);
      for (let k = 0; k < pairs; k++) {
        let qk = 1 / (2 * Math.sin((Math.PI * (2 * k + 1)) / (2 * order)));
        if (k === 0) qk *= b.q / Math.SQRT1_2;
        const al = alpha(qk);
        out.push(
          high
            ? norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al)
            : norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al),
        );
      }
      return out;
    }
  }
}

function magnitude(s: Biquad, w: number): number {
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = s.b0 + s.b1 * c1 + s.b2 * c2;
  const ni = -(s.b1 * s1 + s.b2 * s2);
  const dr = 1 + s.a1 * c1 + s.a2 * c2;
  const di = -(s.a1 * s1 + s.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** A band's response, ready to evaluate at any frequency. */
export function bandResponse(b: EqBand, rate: number): (hz: number) => number {
  const secs = sections(b, rate);
  return (hz) => {
    const w = (2 * Math.PI * hz) / rate;
    let g = 1;
    for (const s of secs) g *= magnitude(s, w);
    return 20 * Math.log10(Math.max(g, 1e-12));
  };
}

/** A band with every value in range, as `EqBand::clamped`. */
export function clampBand(b: EqBand): EqBand {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const slope = SLOPES.reduce((best, s) => (Math.abs(s - b.slope) < Math.abs(best - b.slope) ? s : best), 12);
  return {
    ...b,
    freq: c(b.freq, MIN_FREQ, MAX_FREQ),
    gainDb: c(b.gainDb, -MAX_GAIN_DB, MAX_GAIN_DB),
    q: c(b.q, MIN_Q, MAX_Q),
    slope,
  };
}

/** "120 Hz", "2.40 kHz" */
export function fmtHz(hz: number): string {
  if (hz >= 10_000) return `${(hz / 1000).toFixed(1)} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${hz >= 100 ? Math.round(hz) : hz.toFixed(1)} Hz`;
}

/** "120", "1k", "10k" for the graph's axis. */
export function fmtHzShort(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}
