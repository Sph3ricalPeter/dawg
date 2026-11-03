import { clamp } from "@/lib/format";
import { token } from "./tokens";

/* Level meters: one scale law, one colour scheme (`--meter-*` tokens) and
 * the frame loop, shared by the track header, master, mixer and
 * compressor meters. DOM meters move two bars; the mixer draws all its
 * meters on one canvas with `drawLevel`. */

/** How a meter maps dB to its length: `floor` is empty, 0 dB sits at
 * `zeroAt` of the length, and the rest up to `top` dB fills it. */
export interface MeterLaw {
  floor: number;
  top: number;
  zeroAt: number;
}

/** The small meters (track header, master): 0 dB where the red starts, at
 * 15 of 16 px for the track header. */
export const HEADER_LAW: MeterLaw = { floor: -60, top: 0, zeroAt: 15 / 16 };
export const MASTER_LAW: MeterLaw = { floor: -60, top: 0, zeroAt: 0.94 };
/** The mixer: −60 dB to +6 dB, linear in dB. */
export const MIXER_LAW: MeterLaw = { floor: -60, top: 6, zeroAt: 60 / 66 };

/** Where `db` sits on a meter, 0..1. */
export function meterFrac(db: number, law: MeterLaw): number {
  if (db >= 0) return law.top <= 0 ? 1 : clamp(law.zeroAt + ((1 - law.zeroAt) * db) / law.top, 0, 1);
  return Math.max(0, ((db - law.floor) / -law.floor) * law.zeroAt);
}

/** The mixer's ballistics, per the spec: instant attack, 24 dB/s release,
 * peak hold for 1 s then a 12 dB/s fall. The compressor's gain reduction
 * releases at the same rate. */
export const RELEASE_DB = 24;
export const HOLD_S = 1;
export const PEAK_FALL_DB = 12;

/** Green to −12 dB, yellow to 0 dB, red over: as [from, to, colour]
 * fractions of a meter on `law`. */
export function meterSegments(law: MeterLaw): [number, number, string][] {
  return [
    [0, meterFrac(-12, law), token("--meter-low")],
    [meterFrac(-12, law), meterFrac(0, law), token("--meter-mid")],
    [meterFrac(0, law), 1, token("--meter-high")],
  ];
}

/** Draws one vertical meter bar at (x, y, w, h) on a canvas: the
 * background, the level in segments, and the held peak (red when over). */
export function drawLevel(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  db: number | null,
  peakDb: number | null,
  law: MeterLaw,
  segs: [number, number, string][],
) {
  c.fillStyle = token("--meter-bg");
  c.fillRect(x, y, w, h);
  if (db === null) return;
  const f = meterFrac(db, law);
  for (const [a, b, col] of segs) {
    const e = Math.min(b, f);
    if (e > a) {
      c.fillStyle = col;
      c.fillRect(x, y + h - e * h, w, (e - a) * h);
    }
  }
  if (peakDb !== null && peakDb > law.floor + 1) {
    c.fillStyle = peakDb > 0 ? token("--meter-high") : token("--meter-peak");
    c.fillRect(x, Math.round(y + h - meterFrac(peakDb, law) * h), w, 1);
  }
}
