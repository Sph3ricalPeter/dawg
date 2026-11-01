import { useLayoutEffect, useRef } from "react";
import { onFrame, snapPx } from "@/lib/frame-loop";
import { playClock, useSession } from "@/stores/session-store";

/** The playhead: the marker in the ruler, or the line in a lane. While
 * playing, every one of them is placed from the same clock in the same
 * frame, straight to the DOM, so they move together at the display's
 * refresh rate and nothing else re-renders. */
export function Playhead({ className, lane = false }: { className: string; lane?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useSession((s) => s.playing && !s.scrubbing);
  // Only followed while stopped or scrubbing; while playing the clock is.
  const still = useSession((s) => (s.playing && !s.scrubbing ? 0 : s.playhead));
  const view = useSession((s) => s.view);
  const width = useSession((s) => s.width);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = (frame: number) => {
      const x = (frame - view.start) / view.fpp;
      // A stopped playhead at 0 stays out of the lanes, as before.
      const show = !lane || ((live || x > 0) && x >= 0 && x <= width);
      el.style.visibility = show ? "" : "hidden";
      el.style.transform = `translate3d(${snapPx(x)}px,0,0)`;
    };
    if (!live) {
      place(still);
      return;
    }
    place(playClock.read());
    return onFrame((now) => place(playClock.read(now)));
  }, [live, still, view, width, lane]);

  return <div ref={ref} className={className} />;
}
