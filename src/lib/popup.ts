import type { PopupAt } from "@/stores/browser-store";

/** Where a popup opens under an element. */
export function below(el: Element): PopupAt {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
}
