import { below } from "@/lib/popup";
import { useBrowser } from "@/stores/browser-store";
import { useLibrary } from "@/stores/library-store";

/** F and L while the Browser is under the mouse or has focus: favourite the
 * file in the preview, or open its labels. True when handled. */
export function browserKey(k: "f" | "l"): boolean {
  const el = document.querySelector(".browser:not(.shut)");
  if (!el || !(el.matches(":hover") || el.contains(document.activeElement))) return false;
  const path = useBrowser.getState().current;
  if (!path) return false;
  if (k === "f") useLibrary.getState().toggleFav(path);
  else {
    const add = el.querySelector(".bmeta [data-addlabel]");
    const r = el.getBoundingClientRect();
    useBrowser.getState().openPicker(path, add ? below(add) : { x: r.left + 8, y: r.top + 80 });
  }
  return true;
}
