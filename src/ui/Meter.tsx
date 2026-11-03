import { useEffect, useRef } from "react";
import { METER_FALL_DB, meterStep, onFrame, toDb } from "@/lib/frame-loop";
import { meterFrac, type MeterLaw } from "./meter-law";

/** A stereo level meter of two bars, moved every frame from `read` (the
 * latest linear peaks, left and right) while `live`, and empty otherwise.
 * `vertical` bars grow up, others grow right. The look is the caller's
 * class (`.vol .tm` in a track header, `.mstr` for the master). */
export function LevelMeter({
  read,
  live,
  law,
  vertical,
  className,
  hint,
}: {
  read: () => readonly [number, number] | undefined;
  live: boolean;
  law: MeterLaw;
  vertical: boolean;
  className: string;
  hint?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // The latest `read`, without restarting the loop when it changes.
  const reader = useRef(read);
  useEffect(() => {
    reader.current = read;
  });
  useEffect(() => {
    const bars = [...(ref.current?.querySelectorAll("b") ?? [])];
    const shown = [-120, -120];
    const prop = vertical ? "height" : "width";
    const draw = () => bars.forEach((b, i) => (b.style[prop] = `${meterFrac(shown[i], law) * 100}%`));
    if (!live) {
      draw();
      return;
    }
    return onFrame((_, dt) => {
      const level = reader.current();
      for (let i = 0; i < 2; i++) shown[i] = meterStep(shown[i], toDb(level?.[i] ?? 0), dt, METER_FALL_DB);
      draw();
    });
  }, [live, law, vertical]);
  return (
    <span className={className} ref={ref} data-hint={hint}>
      <i>
        <b />
      </i>
      <i>
        <b />
      </i>
    </span>
  );
}
