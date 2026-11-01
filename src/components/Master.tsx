import { useEffect, useRef } from "react";
import { METER_FALL_DB, meterStep, onFrame, toDb } from "@/lib/frame-loop";
import { useSession } from "@/stores/session-store";
import { Volume } from "./Volume";

/** Meter width for a level in dB: -60 dBFS empty, 0 dBFS where red starts. */
function meterPct(db: number): number {
  return db >= 0 ? 100 : Math.max(0, ((db + 60) / 60) * 94);
}

/** The master meter, drawn every frame from the latest peaks. */
function MasterMeter() {
  const ref = useRef<HTMLDivElement>(null);
  const playing = useSession((s) => s.playing);
  useEffect(() => {
    const bars = [...(ref.current?.querySelectorAll("b") ?? [])];
    const shown = [-120, -120];
    const draw = () => bars.forEach((b, i) => (b.style.width = `${meterPct(shown[i])}%`));
    if (!playing) {
      draw();
      return;
    }
    return onFrame((_, dt) => {
      const m = useSession.getState().master;
      for (let i = 0; i < 2; i++) shown[i] = meterStep(shown[i], toDb(m[i]), dt, METER_FALL_DB);
      draw();
    });
  }, [playing]);
  return (
    <div className="mstr" ref={ref} data-hint="Master output level, after the master volume">
      <i>
        <b />
      </i>
      <i>
        <b />
      </i>
    </div>
  );
}

/** Master volume and the master meter, in the top bar: the shared volume
 * control with the wide meter after it. The readout holds
 * the loudest peak since playback began and turns red past 0 dBFS; click it
 * to reset. */
export function Master() {
  const session = useSession((s) => s.session);
  const draft = useSession((s) => (s.draft?.kind === "master" ? s.draft.db : null));
  const peak = useSession((s) => s.masterPeak);
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
      <Volume
        db={db}
        hint="Master volume"
        onDrag={set}
        onSet={(gain_db) => void store().apply({ type: "set_master_gain", gain_db })}
        after={<MasterMeter />}
      />
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
