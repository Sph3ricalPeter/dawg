/* Draws one waveform tile; shared by the tile worker and the main thread's
 * fallback, so the two look the same. */

/** Tile width in device pixels, plus a pixel of the neighbours each side so
 * scaled tiles join without seams. */
export const TILE_W = 256;

export interface TileJob {
  /** Level: one bucket per `2^lv` source frames, one tile pixel each. */
  lv: number;
  /** Height in device pixels. */
  h: number;
  dpr: number;
  /** `(min, max)` of the `TILE_W + 4` buckets from the one two left of the
   * tile's first pixel. */
  d: Float32Array;
  /** The clip's level (gain, fades, envelope) at each of those buckets. */
  gs: Float32Array;
}

/** Draws `job` on `x`, a canvas `TILE_W + 2` by `job.h`. */
export function drawTile(x: OffscreenCanvasRenderingContext2D, job: TileJob) {
  const { d, gs, h: H, dpr, lv } = job;
  const n = gs.length;
  x.clearRect(0, 0, TILE_W + 2, H);
  const mid = H / 2;
  const half = H / 2 - 2 * dpr;
  // Pixel 0 of the tile is the bucket left of its first, at its centre.
  const xs = (i: number) => i - 0.5;
  // Zoomed in, the outline is about as thick as the sample line it gives
  // way to; further out, a hairline.
  const hair = (lv <= 1 ? 1.4 : lv === 2 ? 1.05 : 0.75) * dpr;
  const shape = (g: (i: number) => number, cap: boolean) => {
    const yt = (i: number) => mid - (cap ? Math.min(1, d[2 * i + 1] * g(i)) : d[2 * i + 1] * g(i)) * half;
    const yb = (i: number) => mid - (cap ? Math.max(-1, d[2 * i] * g(i)) : d[2 * i] * g(i)) * half;
    x.beginPath();
    x.moveTo(xs(0), yt(0));
    for (let i = 1; i < n; i++) x.lineTo(xs(i), yt(i));
    // At least a hairline where it's silent.
    for (let i = n - 1; i >= 0; i--) x.lineTo(xs(i), Math.max(yb(i), yt(i) + hair));
    x.closePath();
    x.fill();
  };
  x.fillStyle = "rgba(16,16,16,.2)";
  shape(() => 1, false);
  x.fillStyle = "rgba(16,16,16,.8)";
  shape((i) => gs[i], true);
  // Anything over full scale.
  x.fillStyle = "#ff4d4d";
  for (let i = 1; i < n - 1; i++) {
    if (d[2 * i + 1] * gs[i] > 1 || d[2 * i] * gs[i] < -1) {
      x.fillRect(i - 1, dpr, 1, 2 * dpr);
      x.fillRect(i - 1, H - 3 * dpr, 1, 2 * dpr);
    }
  }
}
