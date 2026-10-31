import { useState } from "react";
import { clamp, fmtDb, MIN_GAIN_DB } from "@/lib/format";
import { dragKnob, parseDb, volKnobFrac } from "@/lib/knob";
import { useSession } from "@/stores/session-store";
import { Knob } from "./Knob";

const VOL_MIN = -48;
const VOL_MAX = 6;

/** Meter width for a linear peak: -60 dBFS empty, 0 dBFS where red starts. */
function meterPct(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return db >= 0 ? 100 : Math.max(0, ((db + 60) / 60) * 94);
}

/** Master volume and the master meter, in the top bar. The readout holds
 * the loudest peak since playback began and turns red past 0 dBFS; click it
 * to reset. */
export function Master() {
  const session = useSession((s) => s.session);
  const draft = useSession((s) => (s.draft?.kind === "master" ? s.draft.db : null));
  const level = useSession((s) => (s.playing ? s.master : null));
  const peak = useSession((s) => s.masterPeak);
  const [typing, setTyping] = useState(false);
  if (!session) return null;
  const store = useSession.getState;
  const db = draft ?? session.masterDb;
  const set = (gain_db: number, done: boolean) => {
    if (done) return void store().commit();
    store().drag({ type: "set_master_gain", gain_db }, { kind: "master", db: gain_db });
  };
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : null;
  return (
    <div className="tg master">
      <div
        className="mvk"
        data-hint="Master volume · drag up/down (Shift fine, Ctrl 1 dB steps) · double-click resets to 0 dB"
        onPointerDown={(e) =>
          dragKnob(e, db <= MIN_GAIN_DB ? VOL_MIN : db, { rate: 0.25, min: VOL_MIN, max: VOL_MAX, step: 1, res: 0.1, detent: 0.3 }, (v, done) =>
            set(v <= VOL_MIN ? MIN_GAIN_DB : v, done),
          )
        }
        onDoubleClick={() => void store().apply({ type: "set_master_gain", gain_db: 0 })}
      >
        <Knob f={volKnobFrac(db)} />
      </div>
      {typing ? (
        <input
          className="ktype mtype"
          autoFocus
          defaultValue={fmtDb(db, false).replace("dB", "")}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            setTyping(false);
            const v = parseDb(e.target.value);
            if (v === -Infinity) void store().apply({ type: "set_master_gain", gain_db: MIN_GAIN_DB });
            else if (Number.isFinite(v)) void store().apply({ type: "set_master_gain", gain_db: clamp(v, VOL_MIN, 12) });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setTyping(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span className="mv" onDoubleClick={() => setTyping(true)} data-hint="Master volume · double-click to type">
          {fmtDb(db).replace(" dB", "")}
        </span>
      )}
      <div className="mstr" data-hint="Master output level, after the master volume">
        <i>
          <b style={{ width: `${meterPct(level?.[0] ?? 0)}%` }} />
        </i>
        <i>
          <b style={{ width: `${meterPct(level?.[1] ?? 0)}%` }} />
        </i>
      </div>
      <button
        className={`mpk${peakDb !== null && peakDb > 0 ? " over" : ""}`}
        onClick={() => store().resetMasterPeak()}
        data-hint={peakDb !== null && peakDb > 0 ? "The mix clipped: lower the master or the tracks · click to reset" : "Loudest peak since playback began · click to reset"}
      >
        {peakDb === null ? "−∞" : `${peakDb > 0 ? "+" : ""}${peakDb.toFixed(1)}`}
      </button>
    </div>
  );
}
