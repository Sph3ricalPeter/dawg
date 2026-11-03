/** Colours that are data, not styling: saved with a label or picked by
 * index, so they live here as hex rather than in `tokens.css`. Loads
 * before the stores, so it imports nothing. */

/** The clip palette: tracks by index or category, custom labels pick from it. */
export const PALETTE = ["#ee9f98", "#f5c55c", "#c3dd76", "#7dd6c4", "#9ec8ea", "#f0a8cf", "#b9c2cf", "#dcc89f"];

/** The master's colour in chips and strips. */
export const MASTER_COLOR = "#d6d6d6";

/** The Status labels' colours: `--ok`, `--warn` and `--danger` in tokens.css. */
export const STATUS = { ok: "#3fd46a", warn: "#ffd23f", danger: "#ff4d4d" };
