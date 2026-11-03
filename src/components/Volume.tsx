import { type ReactNode, useState } from "react";
import { clamp, fmtDb, MIN_GAIN_DB } from "@/lib/format";
import { knobControl, parseDb, volKnobFrac } from "@/lib/knob";
import { Knob } from "@/ui/Knob";

/** The volume knob's travel; the bottom of it is off (−∞). */
export const VOL_MIN = -48;
export const VOL_MAX = 6;
/** Typing can go past the knob's top. */
const VOL_TYPE_MAX = 12;
const DRAG = { rate: 0.25, min: VOL_MIN, max: VOL_MAX, step: 1, res: 0.1, detent: 0.3 };

/** A small text field for typing a value in place of a knob readout. */
export function TypeIn({ value, onDone }: { value: string; onDone: (text: string | null) => void }) {
  return (
    <input
      className="ktype"
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => onDone(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onDone(null);
        e.stopPropagation();
      }}
    />
  );
}

/** The one volume control, for the master and every track: the knob, then
 * the value with "dB", with a level meter before or after it. Drag or wheel
 * anywhere on it (Shift fine, Ctrl 1 dB steps), double-click the knob for
 * 0 dB, double-click the number to type. `onDrag` gets each value and
 * `done` on release; `onSet` is a one-off change (reset, typed value). */
export function Volume({
  db,
  onDrag,
  onSet,
  hint,
  before,
  after,
  className = "",
}: {
  db: number;
  onDrag: (db: number, done: boolean) => void;
  onSet: (db: number) => void;
  hint: string;
  before?: ReactNode;
  after?: ReactNode;
  className?: string;
}) {
  const [typing, setTyping] = useState(false);
  const { ref, onPointerDown } = knobControl(db <= MIN_GAIN_DB ? VOL_MIN : db, DRAG, (v, done) =>
    onDrag(v <= VOL_MIN ? MIN_GAIN_DB : v, done),
  );
  const onText = (e: React.SyntheticEvent) => !!(e.target as HTMLElement).closest(".vv, .ktype");
  return (
    <div
      className={`vol ${className}`}
      data-hint={`${hint} · drag up/down (Shift fine, Ctrl 1 dB steps) · double-click the number to type, the knob to reset`}
      ref={ref}
      onPointerDown={(e) => {
        if (!onText(e)) onPointerDown(e);
      }}
      onDoubleClick={(e) => {
        if (!onText(e)) onSet(0);
      }}
    >
      {before}
      <Knob f={volKnobFrac(db)} />
      {typing ? (
        <TypeIn
          value={fmtDb(db, false).replace("dB", "")}
          onDone={(t) => {
            setTyping(false);
            if (t === null) return;
            const v = parseDb(t);
            if (v === -Infinity) onSet(MIN_GAIN_DB);
            else if (Number.isFinite(v)) onSet(clamp(v, VOL_MIN, VOL_TYPE_MAX));
          }}
        />
      ) : (
        <span className="vv" onDoubleClick={() => setTyping(true)}>
          {fmtDb(db, false)}
        </span>
      )}
      {after}
    </div>
  );
}
