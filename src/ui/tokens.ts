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
