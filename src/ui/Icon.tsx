import type { ReactNode } from "react";

/* The app's icons, by name, so a screen asks for "undo" instead of
 * pasting path data. Toolbar icons (16×16) are filled or 1.4 px strokes
 * and take their colour from the button (`currentColor`); the window
 * controls are 10×10 hairlines. Add new icons here. */

const stroke = (d: ReactNode, w = 1.4, extra: React.SVGProps<SVGSVGElement> = {}) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={w} {...extra}>
    {d}
  </svg>
);
const fill = (d: string, extra: React.SVGProps<SVGSVGElement> = {}) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...extra}>
    <path d={d} />
  </svg>
);
const win = (d: string) => (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path d={d} />
  </svg>
);
/** The mixer's route row: round line icons at 2 px. */
const route = (d: ReactNode, w = 2) => stroke(d, w, { strokeLinecap: "round", strokeLinejoin: "round" });

const UNDO = "M6 3 1.5 7 6 11V8.5h4a2.5 2.5 0 0 1 0 5H8V15h2a4 4 0 0 0 0-8H6z";

const ICONS = {
  browser: fill("M2 3h12v10H2zM3.5 4.5v7h3v-7z"),
  play: fill("M4 2.5v11l9-5.5z"),
  stop: fill("M3.5 3.5h9v9h-9z"),
  loop: stroke(<path d="M4 5.5h7.5a2 2 0 0 1 2 2v.5M12 10.5H4.5a2 2 0 0 1-2-2V8M9.5 3.5l2 2-2 2M6.5 12.5l-2-2 2-2" />),
  mixer: stroke(
    <>
      <path d="M4 2.5v11M8 2.5v11M12 2.5v11" />
      <path d="M2.5 10h3M6.5 5.5h3M10.5 8.5h3" strokeWidth="2.2" />
    </>,
    1.4,
    { strokeLinecap: "round" },
  ),
  history: stroke(<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" />),
  undo: fill(UNDO),
  redo: fill(UNDO, { style: { transform: "scaleX(-1)" } }),
  export: fill("M8 10V2.5M5 5.2 8 2.3l3 2.9M2.5 9.5v3.5h11V9.5"),
  minimize: win("M0 5h10"),
  maximize: win("M.5.5h9v9h-9z"),
  "win-close": win("M0 0l10 10M10 0 0 10"),
  close: route(<path d="M5 5l6 6M11 5l-6 6" />, 1.8),
  connect: route(<path d="M4 9.5 8 5.5l4 4" />),
  source: route(<path d="M4.5 6.5 8 10l3.5-3.5" />),
  "no-loop": route(
    <>
      <path d="M4 9.5 8 5.5l4 4" />
      <path d="M3 13 13 3" strokeWidth={1.4} />
    </>,
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return ICONS[name];
}
