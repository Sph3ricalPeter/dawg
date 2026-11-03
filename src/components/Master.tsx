import { useSession } from "@/stores/session-store";
import { LevelMeter } from "@/ui/Meter";
import { MASTER_LAW } from "@/ui/meter-law";
import { Volume } from "@/ui/Volume";

/** The master meter, live while playing. */
function MasterMeter() {
  const playing = useSession((s) => s.playing);
  return (
    <LevelMeter
      className="mstr"
      vertical={false}
      law={MASTER_LAW}
      live={playing}
      read={() => useSession.getState().master}
      hint="Master output level, after the master volume"
    />
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
