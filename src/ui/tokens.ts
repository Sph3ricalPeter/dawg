/** Canvas drawing reads the same tokens as CSS (`tokens.css`): `token`
 * once per name, cached, so a frame loop can call it freely. */

const cache = new Map<string, string>();

/** A token's value, e.g. `token("--danger")` is "#ff4d4d". */
export function token(name: `--${string}`): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }
  return v;
}

/** A hex colour token at `alpha`, as `rgba(…)` for a canvas. */
export function alpha(name: `--${string}`, a: number): string {
  const hex = token(name).replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** The knob sizes, in px. Every knob uses one of these, so a resize is
 * made here once: `badge` sits inside a clip, `sm` is a send level, `md`
 * the volume and pan knobs on tracks and mixer strips, `lg` a labelled
 * param (`KnobField`), `side` a labelled knob in a short row. */
export const KNOB = { badge: 12, sm: 21, md: 26, side: 34, lg: 36 } as const;
