import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { richTips } from "@/lib/rich-tips";

/** How long the pointer rests on something before its tooltip shows. */
const DELAY_MS = 450;
/** After a tooltip hides, the next one within this window shows at once,
 * so sweeping along a row of buttons reads each label without waiting. */
const WARM_MS = 400;
const GAP = 6;
const MARGIN = 6;

interface Tip {
  el: HTMLElement;
  text: string;
}

/** The element under (x, y) that has a tooltip. A native `title` found on the
 * way is moved to `data-tip`, so the browser's own tooltip never shows. */
function tipAt(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.hasAttribute("title")) {
      const t = el.getAttribute("title");
      el.removeAttribute("title");
      if (t) el.dataset.tip = t;
    }
    if (el.dataset.tip) return el;
  }
  return null;
}

/** The app's one tooltip. Anything with a `data-tip` attribute (or a stray
 * `title`) gets it on hover, styled to match the app. It follows the attribute
 * live, so a label that changes while shown (undo's next step) updates in
 * place. Mounted once, at the root. */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    let target: HTMLElement | null = null;
    let warmUntil = 0;
    let shown = false;
    let observer: MutationObserver | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      observer = null;
      if (shown) warmUntil = performance.now() + WARM_MS;
      shown = false;
      setTip(null);
    };
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text || !el.isConnected) return hide();
      shown = true;
      setTip({ el, text });
      observer?.disconnect();
      observer = new MutationObserver(() => {
        if (!el.isConnected || !el.dataset.tip) hide();
        else setTip({ el, text: el.dataset.tip });
      });
      observer.observe(el, { attributes: true, attributeFilter: ["data-tip"] });
    };

    const move = (e: PointerEvent) => {
      if (e.buttons) return; // dragging: no tooltips
      const el = tipAt(e.clientX, e.clientY);
      if (el === target) return;
      target = el;
      const warm = shown || performance.now() < warmUntil;
      hide();
      if (!el) return;
      if (warm) show(el);
      else timer = window.setTimeout(() => show(el), DELAY_MS);
    };
    // Any press, key, scroll or leaving the window puts it away; it comes back
    // only once the pointer moves onto something else.
    const dismiss = () => {
      hide();
      warmUntil = 0;
    };
    const leave = (e: PointerEvent) => {
      if (!e.relatedTarget) {
        target = null;
        dismiss();
      }
    };

    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("wheel", dismiss, { capture: true, passive: true });
    window.addEventListener("blur", dismiss);
    document.addEventListener("pointerout", leave);
    return () => {
      hide();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("pointerout", leave);
    };
  }, []);

  // Below the element, centred and kept on screen; above it when there's no
  // room below. Placed straight on the DOM before paint, so it never flashes
  // at the wrong spot.
  useLayoutEffect(() => {
    const el = box.current;
    if (!tip || !el) return;
    const r = tip.el.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = r.bottom + GAP + b.height <= vh - MARGIN || r.top - GAP - b.height < MARGIN;
    const y = below ? r.bottom + GAP : r.top - GAP - b.height;
    const x = Math.min(Math.max(r.left + r.width / 2 - b.width / 2, MARGIN), vw - MARGIN - b.width);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.classList.toggle("above", !below);
    el.classList.add("on");
  }, [tip]);

  if (!tip) return null;
  const rich = tip.el.dataset.tipRich ? richTips.get(tip.el.dataset.tipRich) : undefined;
  return (
    <div ref={box} className={rich ? "tooltip rich" : "tooltip"} role="tooltip">
      {rich ?? tip.text}
    </div>
  );
}
