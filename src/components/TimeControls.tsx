import { useRef, useState } from "react";
import { fmtTime } from "@/lib/format";
import { fmtBars, parsePosition, SNAPS, type Units } from "@/lib/grid";
import { startDrag } from "@/lib/drag";
import { gridOf, useSession } from "@/stores/session-store";
import { useDismiss } from "@/ui/dismiss";
import { Menu, MenuItem, MenuLabel, MenuSep } from "@/ui/Menu";

/** The playhead readout: bars (with seconds under) or time. Double-click to
 * type a position like 5.1.1 or 0:12.5. */
export function Lcd() {
  const session = useSession((s) => s.session);
  const playhead = useSession((s) => s.playhead);
  const units = useSession((s) => gridOf(s).units);
  const [typing, setTyping] = useState(false);
  const rate = session?.rate ?? 48_000;
  const bpm = session?.bpm ?? 120;
  const go = (text: string) => {
    setTyping(false);
    const f = parsePosition(text, rate, bpm, units);
    if (f === null) {
      if (text.trim()) useSession.getState().showToast(`"${text}" isn't a position: try 5.1.1 or 0:12.5`, { error: true });
      return;
    }
    useSession.getState().setPlayhead(f);
  };
  return (
    <div
      className={`lcd${units === "bars" ? " bars" : ""}`}
      data-tip="Playhead position · double-click to type one, like 5.1.1 or 0:12.5"
      onDoubleClick={() => session && setTyping(true)}
    >
      {typing ? (
        <input
          className="lcdin"
          autoFocus
          defaultValue={units === "bars" ? fmtBars(playhead, rate, bpm) : fmtTime(playhead / rate)}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => go(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setTyping(false);
            e.stopPropagation();
          }}
        />
      ) : units === "bars" ? (
        <>
          <span className="big">{fmtBars(playhead, rate, bpm)}</span>
          <span className="small">{fmtTime(playhead / rate)}</span>
        </>
      ) : (
        <span className="big">{fmtTime(playhead / rate)}</span>
      )}
    </div>
  );
}

/** Tempo: drag up or down (Shift fine, Ctrl whole BPM), double-click to
 * type. Only in projects; a scratch session counts in seconds. */
export function Bpm() {
  const bpm = useSession((s) => (s.draft?.kind === "tempo" ? s.draft.bpm : (s.session?.bpm ?? 120)));
  const [typing, setTyping] = useState(false);
  const store = useSession.getState;
  const onDown = (e: React.PointerEvent) => {
    if (typing) return;
    const b0 = bpm;
    let v = b0;
    startDrag(e, {
      lock: true,
      move: (_dx, dy, ev) => {
        const raw = b0 - dy * (ev.shiftKey ? 0.05 : 0.5);
        v = Math.min(999, Math.max(20, ev.ctrlKey ? Math.round(raw) : Math.round(raw * 100) / 100));
        store().drag({ type: "set_tempo", bpm: v }, { kind: "tempo", bpm: v });
      },
      end: (moved) => {
        if (moved) void store().commit();
      },
    });
  };
  return (
    <span className="field" data-hint="Tempo for the bars-and-beats grid · drag up/down (Shift fine, Ctrl whole BPM) · double-click to type">
      BPM
      {typing ? (
        <input
          className="well bpmin"
          autoFocus
          defaultValue={bpm.toFixed(2)}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            setTyping(false);
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) void store().apply({ type: "set_tempo", bpm: Math.min(999, Math.max(20, v)) });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setTyping(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span className="well" onPointerDown={onDown} onDoubleClick={() => setTyping(true)}>
          {bpm.toFixed(2)}
        </span>
      )}
    </span>
  );
}

/** Timeline settings: snap, envelope editing and (in a project) units. */
export function TimelineMenu() {
  const session = useSession((s) => s.session);
  const units = useSession((s) => gridOf(s).units);
  const snap = useSession((s) => gridOf(s).snap);
  const g = { units, snap };
  const envEdit = useSession((s) => s.envEdit);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const store = useSession.getState;
  const label = SNAPS.find((s) => s.v === g.snap)?.label ?? "Off";
  const item = (text: string, on: boolean, run: () => void, keys = "", radio = true) => (
    <MenuItem key={text} label={text} checked={on} radio={radio} keys={keys} run={run} close={() => setOpen(false)} />
  );
  return (
    <div className="tg tlwrap" ref={ref}>
      <button
        className={`tb tlset${open ? " on" : ""}`}
        disabled={!session}
        onClick={() => setOpen(!open)}
        data-tip={`Timeline settings · snap ${label.toLowerCase()} · envelope editing ${envEdit ? "on" : "off"}`}
      >
        <span>Snap {label}</span>
        {!envEdit && <span className="tlenv">Env off</span>}
        <span className="car">▾</span>
      </button>
      {open && (
        <Menu className="tlmenu">
          <MenuLabel>Snap{session?.scratch ? " (this file)" : ""} · hold Alt to bypass</MenuLabel>
          {SNAPS.map((s) => item(s.label, g.snap === s.v, () => store().setSnap(s.v)))}
          <MenuSep />
          {item("Envelope editing", envEdit, () => store().toggleEnvEdit(), "E", false)}
          {!session?.scratch && (
            <>
              <MenuSep />
              <MenuLabel>Show positions in</MenuLabel>
              {(["bars", "time"] as Units[]).map((u) =>
                item(u === "bars" ? "Bars and beats" : "Minutes and seconds", g.units === u, () => store().setUnits(u)),
              )}
            </>
          )}
        </Menu>
      )}
    </div>
  );
}
