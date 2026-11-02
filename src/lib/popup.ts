import type { PopupAt } from "@/stores/browser-store";

/** A point a menu opens at, in window px. */
export interface MenuAt {
  x: number;
  y: number;
}

/** Where a menu opens right under an element. */
export function under(el: Element): MenuAt {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2 };
}

/** Where a popup opens under an element. */
export function below(el: Element): PopupAt {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
}
