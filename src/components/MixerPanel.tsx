import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MASTER, type SessionState, type TrackState, type DeviceState } from "@/lib/api";
import { commitDrag, removeSend, setMasterGain, setMix, setSend } from "@/lib/chain-edit";
import { startDrag } from "@/lib/drag";
import { clamp } from "@/lib/format";
import { onFrame, toDb } from "@/lib/frame-loop";
import { knobControl } from "@/lib/knob";
import { chanLabel, channelName, channelNumber, fmtPan, MASTER_COLOR, wouldLoop } from "@/lib/mixer";
import { type MenuAt, under } from "@/lib/popup";
import { trackColor } from "@/lib/timeline";
import { useMasterChain, useSession, useTracks } from "@/stores/session-store";
import { PanelHead } from "./Dock";
import { Knob } from "./Knob";
import { MenuItem, PopMenu } from "./PopMenu";
import { SendKnob, SendMenu } from "./RouteMenus";
import { Volume } from "./Volume";

const store = useSession.getState;

/* ------------------------------------------------------------------ */
/* Laws and meters                                                     */
/* ------------------------------------------------------------------ */

/** Meter scale: −60 dB at the bottom, +6 dB at the top. */
const mfr = (db: number) => clamp((db + 60) / 66, 0, 1);
const SEG: [number, number, string][] = [
  [0, mfr(-12), "#3fd46a"],
  [mfr(-12), mfr(0), "#ffd23f"],
  [mfr(0), 1, "#ff4d4d"],
];
/** Meter ballistics, per the spec: instant attack, 24 dB/s release, peak
 * hold for 1 s then a 12 dB/s fall. */
const RELEASE_DB = 24;
const HOLD_S = 1;
const PEAK_FALL_DB = 12;
const FLOOR = -70;

interface MeterState {
  v: [number, number];
  pk: [number, number];
  hold: [number, number];
}

/* ------------------------------------------------------------------ */
/* Icons: SVG line icons at the app's stroke                           */
/* ------------------------------------------------------------------ */

const Icon = ({ d, w = 2 }: { d: React.ReactNode; w?: number }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);
const IC = {
  connect: <Icon d={<path d="M4 9.5 8 5.5l4 4" />} />,
  remove: <Icon d={<path d="M5 5l6 6M11 5l-6 6" />} w={1.8} />,
  source: <Icon d={<path d="M4.5 6.5 8 10l3.5-3.5" />} />,
  loop: (
    <Icon
      d={
        <>
          <path d="M4 9.5 8 5.5l4 4" />
          <path d="M3 13 13 3" strokeWidth={1.4} />
        </>
      }
    />
  ),
};

/* ------------------------------------------------------------------ */
/* One strip                                                           */
/* ------------------------------------------------------------------ */

interface Chan {
  id: number;
  /** In `session.tracks`, for meters and colours; -1 for the master. */
  index: number;
  track: TrackState | null;
  name: string;
  number: number;
  color: string;
  db: number;
  chain: DeviceState[];
}

type Menu =
  | { kind: "chan"; chan: number; at: MenuAt }
  | { kind: "out"; chan: number; at: MenuAt };

function Strip({
  c,
  s,
  sel,
  onMenu,
  onSourceDown,
}: {
  c: Chan;
  s: SessionState;
  sel: number | null;
  onMenu: (m: Menu) => void;
  onSourceDown: (e: React.PointerEvent) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const t = c.track;
  const isMaster = c.id === MASTER;
  const selected = sel === c.id;
  const onVol = (db: number, done: boolean) => {
    if (done) return commitDrag();
    if (isMaster) setMasterGain(db, true);
    else setMix(t!, { gain_db: db }, true);
  };
  const setVol = (db: number) => (isMaster ? setMasterGain(db, false) : setMix(t!, { gain_db: db }, false));
  const pan = t ? Math.round(t.pan * 100) : 0;
  const panCtl = knobControl(pan, { rate: 1, min: -100, max: 100, step: 10, res: 1, detent: 4 }, (v, done) =>
    done ? commitDrag() : t && setMix(t, { pan: v / 100 }, true),
  );

  // The route cell: relative to the selected strip, as in FL.
  const src = sel !== null && sel !== MASTER ? s.tracks.find((x) => x.id === sel) : undefined;
  let route: React.ReactNode = null;
  if (selected && !isMaster) {
    route = (
      <span
        className="rsrc"
        onPointerDown={onSourceDown}
        data-hint={`${c.name} is the source · click the chevron on any strip to send there, or drag from here onto a strip (onto a compressor slot to sidechain it)`}
      >
        {IC.source}
      </span>
    );
  } else if (src && !selected) {
    const snd = src.sends.find((x) => x.to === c.id);
    if (snd) {
      route = (
        <>
          <button className="rdel" onClick={() => removeSend(src.id, c.id)} data-hint={`Remove the send from ${channelName(s, src.id)} to ${c.name}`}>
            {IC.remove}
          </button>
          <SendKnob from={src.id} to={c.id} db={snd.gainDb} />
        </>
      );
    } else {
      const loop = wouldLoop(s, src.id, c.id);
      route = (
        <button
          className="rcon"
          disabled={loop}
          onClick={() => setSend(src.id, c.id, 0, false)}
          data-hint={loop ? `${c.name} already feeds ${channelName(s, src.id)}, so this would loop` : `Send ${channelName(s, src.id)} to ${c.name}`}
        >
          {loop ? IC.loop : IC.connect}
        </button>
      );
    }
  }
  const outs = t ? [...t.sends].sort((a, b) => channelNumber(s, a.to) - channelNumber(s, b.to)) : [];

  return (
    <div
      className={`mxs${isMaster ? " master" : ""}${selected ? " sel" : ""}`}
      data-chan={c.id}
      style={{ ["--c" as string]: c.color }}
      onPointerDown={(e) => {
        // The route cell acts on the selected strip, so it never selects.
        if (sel !== c.id && !(e.target as HTMLElement).closest(".rcell")) store().selectChannel(c.id, true);
      }}
    >
      <div className="sname" onDoubleClick={() => !isMaster && setRenaming(true)} data-hint={isMaster ? "The master channel" : "Double-click to rename"}>
        <span className="cno mono">C{c.number}</span>
        {renaming && t ? (
          <input
            className="rn"
            autoFocus
            defaultValue={t.name}
            onBlur={(e) => {
              setRenaming(false);
              const v = e.target.value.trim();
              if (v && v !== t.name) void store().apply({ type: "rename_track", track: t.id, name: v });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
              e.stopPropagation();
            }}
          />
        ) : (
          <span className="nm">{c.name}</span>
        )}
        {!isMaster && (
          <button className="cm" onClick={(e) => onMenu({ kind: "chan", chan: c.id, at: under(e.currentTarget) })} data-hint="Channel menu: rename, duplicate, delete">
            ⋯
          </button>
        )}
      </div>
      <div className="prow">
        {isMaster ? (
          <span className="pk-pad" />
        ) : (
          <span
            className="pan"
            {...panCtl}
            onDoubleClick={() => t && setMix(t, { pan: 0 }, false)}
            data-hint={`Pan ${fmtPan(t!.pan)} · drag up or down (Shift fine, Ctrl 10% steps) · double-click centres`}
          >
            <Knob f={pan / 100} bipolar size={20} color="var(--k-pan)" />
          </span>
        )}
        <span className="msrow">
          {isMaster ? (
            <span className="ms" style={{ visibility: "hidden" }} />
          ) : (
            <button
              className={`ms mm${t!.muted ? " on" : ""}`}
              onClick={() => void store().apply({ type: "set_track_mix", track: t!.id, muted: !t!.muted })}
              data-hint="Mute"
            >
              M
            </button>
          )}
          {isMaster ? (
            <span className="ms" style={{ visibility: "hidden" }} />
          ) : (
            <button
              className={`ms s${t!.solo ? " on" : ""}`}
              onClick={() => void store().apply({ type: "set_track_mix", track: t!.id, solo: !t!.solo })}
              data-hint="Solo: also plays what it sends to and what feeds it"
            >
              S
            </button>
          )}
        </span>
      </div>
      <div className="fz">
        <Volume
          className="mxvol"
          db={c.db}
          hint={isMaster ? "Master volume" : "Volume"}
          onDrag={onVol}
          onSet={setVol}
          after={<div className="mtr" data-mtr={c.index} />}
        />
      </div>
      <div className="rrow" data-rr={c.id}>
        {isMaster ? (
          <span className="oport static">
            <span className="ot">Out</span>
          </span>
        ) : (
          <button
            className={`oport${outs.length ? "" : " none"}`}
            onClick={(e) => onMenu({ kind: "out", chan: c.id, at: under(e.currentTarget) })}
            data-hint={`Where ${c.name} sends · click to tick destinations and set their levels`}
          >
            <span className="ot">{outs.length ? `→ ${outs.map((x) => `C${channelNumber(s, x.to)}`).join(", ")}` : "No output"}</span>
          </button>
        )}
        <div className="rcell">{route}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

/** A hanging cable from one strip's route row to another's. */
function cablePath(x1: number, y1: number, x2: number, y2: number, h: number): string {
  const sag = Math.min(h - 4, Math.max(y1, y2) + 16 + Math.abs(x2 - x1) * 0.04);
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} C${x1.toFixed(1)} ${sag.toFixed(1)} ${x2.toFixed(1)} ${sag.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

interface Cable {
  d: string;
  on: boolean;
}

/** The Mixer panel: the master pinned left (C0), then a strip per channel
 * in timeline order, then + for a mixer-only channel. Meters draw into one
 * canvas over the strips every frame; cables are redrawn only when the
 * routing or the layout changes. */
export function MixerPanel() {
  const session = useSession((s) => s.session);
  const tracks = useTracks();
  const masterChain = useMasterChain();
  const masterDraft = useSession((s) => (s.draft?.kind === "master" ? s.draft.db : null));
  const sel = useSession((s) => s.channel);
  const playing = useSession((s) => s.playing);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [cables, setCables] = useState<Cable[]>([]);
  const [ghost, setGhost] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const body = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const meters = useRef<Map<number, MeterState>>(new Map());

  const s: SessionState | null = session ? { ...session, tracks, masterChain } : null;
  const chans: Chan[] = s
    ? [
        {
          id: MASTER,
          index: -1,
          track: null,
          name: "Master",
          number: 0,
          color: MASTER_COLOR,
          db: masterDraft ?? s.masterDb,
          chain: masterChain,
        },
        ...tracks.map((t, i) => ({
          id: t.id,
          index: i,
          track: t,
          name: t.name || `Track ${i + 1}`,
          number: i + 1,
          color: trackColor(i, t.color, t.category),
          db: t.gainDb,
          chain: t.chain,
        })),
      ]
    : [];

  // Size of the strips, for the meter canvas over them.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Cables: measured from the route rows whenever routing or layout moves.
  const routing = s
    ? JSON.stringify([
        tracks.map((t) => [t.id, t.sends.map((x) => x.to), t.chain.map((d) => d.sidechain ?? 0)]),
        masterChain.length,
        sel,
        size,
      ])
    : "";
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !s) {
      setCables([]);
      return;
    }
    const box = el.getBoundingClientRect();
    const h = el.scrollHeight;
    const at = (id: number): [number, number] | null => {
      const r = el.querySelector(`[data-rr="${id}"]`)?.getBoundingClientRect();
      return r ? [r.left - box.left + r.width / 2, r.bottom - box.top - 3] : null;
    };
    const out: Cable[] = [];
    const line = (a: number, b: number, on: boolean) => {
      const p = at(a);
      const q = at(b);
      if (p && q) out.push({ d: cablePath(p[0], p[1], q[0], q[1], h), on });
    };
    for (const t of tracks) for (const x of t.sends) line(t.id, x.to, t.id === sel);
    for (const c of chans) for (const d of c.chain) if (d.sidechain != null) line(d.sidechain, c.id, d.sidechain === sel);
    // Selected cables draw last, over the grey ones.
    out.sort((a, b) => Number(a.on) - Number(b.on));
    setCables(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routing]);

  // Meters: one canvas, every frame while anything moves.
  useEffect(() => {
    const c = canvas.current;
    const el = inner.current;
    if (!c || !el) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    const x = c.getContext("2d");
    if (!x) return;
    let rects: [number, number, number, number, number][] = [];
    const measure = () => {
      const b = el.getBoundingClientRect();
      rects = [...el.querySelectorAll<HTMLElement>("[data-mtr]")].map((m) => {
        const r = m.getBoundingClientRect();
        return [Number(m.dataset.mtr), r.left - b.left, r.top - b.top, r.width, r.height];
      });
    };
    measure();
    const draw = () => {
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, size.w, size.h);
      for (const [i, mx, my, mw, mh] of rects) {
        const m = meters.current.get(i);
        const bw = Math.max(1, Math.floor((mw - 1) / 2));
        for (let ch = 0; ch < 2; ch++) {
          const bx = mx + ch * (bw + 1);
          x.fillStyle = "#060606";
          x.fillRect(bx, my, bw, mh);
          if (!m) continue;
          const f = mfr(m.v[ch]);
          for (const [a, b, col] of SEG) {
            const e = Math.min(b, f);
            if (e > a) {
              x.fillStyle = col;
              x.fillRect(bx, my + mh - e * mh, bw, (e - a) * mh);
            }
          }
          if (m.pk[ch] > -59) {
            x.fillStyle = m.pk[ch] > 0 ? "#ff4d4d" : "#d0d0d0";
            x.fillRect(bx, Math.round(my + mh - mfr(m.pk[ch]) * mh), bw, 1);
          }
        }
      }
    };
    const step = (dt: number): boolean => {
      const st = useSession.getState();
      let moving = false;
      for (const [i] of rects) {
        const level = i < 0 ? st.master : st.levels[i];
        let m = meters.current.get(i);
        if (!m) meters.current.set(i, (m = { v: [FLOOR, FLOOR], pk: [FLOOR, FLOOR], hold: [0, 0] }));
        for (let ch = 0; ch < 2; ch++) {
          const target = st.playing ? Math.max(FLOOR, toDb(level?.[ch] ?? 0)) : FLOOR;
          m.v[ch] = target >= m.v[ch] ? target : Math.max(target, m.v[ch] - RELEASE_DB * dt);
          if (m.v[ch] >= m.pk[ch]) {
            m.pk[ch] = m.v[ch];
            m.hold[ch] = HOLD_S;
          } else if ((m.hold[ch] -= dt) < 0) m.pk[ch] = Math.max(m.v[ch], m.pk[ch] - PEAK_FALL_DB * dt);
          if (m.v[ch] > FLOOR || m.pk[ch] > FLOOR) moving = true;
        }
      }
      return moving;
    };
    draw();
    let stop: (() => void) | null = null;
    const run = () => {
      if (stop) return;
      stop = onFrame((_, dt) => {
        const moving = step(dt);
        draw();
        if (!moving && !useSession.getState().playing) {
          stop?.();
          stop = null;
        }
      });
    };
    if (playing || [...meters.current.values()].some((m) => m.v.some((v) => v > FLOOR) || m.pk.some((v) => v > FLOOR))) run();
    return () => {
      stop?.();
    };
    // Re-measured whenever the strips change.
  }, [playing, size, routing, tracks.length]);

  if (!s) return null;

  const addChannel = () => {
    const n = tracks.filter((t) => !t.lane).length + 1;
    void store()
      .apply({ type: "add_track", name: `Channel ${n}`, lane: false })
      .then((ok) => {
        const last = store().session?.tracks.at(-1);
        if (ok && last) store().selectChannel(last.id, true);
      });
  };

  /** Drags a cable from the selected strip's source chevron onto a strip
   * to send there. */
  const dragSource = (e: React.PointerEvent) => {
    const from = sel;
    const el = inner.current;
    if (from === null || from === MASTER || !el) return;
    const box = el.getBoundingClientRect();
    const r = el.querySelector(`[data-rr="${from}"]`)?.getBoundingClientRect();
    if (!r) return;
    const x0 = r.left - box.left + r.width / 2;
    const y0 = r.bottom - box.top - 3;
    const clear = () => document.querySelectorAll(".mxs.drop, .mxs.nogo").forEach((x) => x.classList.remove("drop", "nogo"));
    const targetAt = (cx: number, cy: number) =>
      (document.elementFromPoint(cx, cy) as HTMLElement | null)?.closest<HTMLElement>(".mxs[data-chan]") ?? null;
    startDrag(e, {
      slop: 3,
      move: (_dx, _dy, ev) => {
        clear();
        const strip = targetAt(ev.clientX, ev.clientY);
        const to = strip ? Number(strip.dataset.chan) : null;
        if (strip && to !== from) strip.classList.add(wouldLoop(s, from, to!) ? "nogo" : "drop");
        const b = el.getBoundingClientRect();
        setGhost(cablePath(x0, y0, ev.clientX - b.left, ev.clientY - b.top, el.scrollHeight));
      },
      end: (moved, ev) => {
        clear();
        setGhost(null);
        if (!moved) return;
        const strip = targetAt(ev.clientX, ev.clientY);
        const to = strip ? Number(strip.dataset.chan) : null;
        if (to === null || to === from || wouldLoop(s, from, to)) return;
        if (!tracks.find((t) => t.id === from)?.sends.some((x) => x.to === to)) setSend(from, to, 0, false);
      },
    });
  };

  const menuChan = menu && "chan" in menu ? chans.find((c) => c.id === menu.chan) : undefined;
  const closeMenu = () => setMenu(null);

  return (
    <section className="mxp">
      <PanelHead id="mixer" className="eqh">
        <b>Mixer</b>
        <span className="dim mxhint">
          {sel !== null && sel !== MASTER
            ? `${chanLabel(s, sel)} selected · click the chevron on another strip to send there`
            : "Select a channel, then click the chevron on another strip to send there"}
        </span>
        <span className="sp" />
        <button className="eqx" onClick={() => store().toggleMixer()} data-hint="Close the mixer (F9)">
          ✕
        </button>
      </PanelHead>
      <div className="mxbody" ref={body}>
        <div className="strips" ref={inner}>
          {chans.map((c) => (
            <Strip
              key={c.id}
              c={c}
              s={s}
              sel={sel}
              onMenu={setMenu}
              onSourceDown={dragSource}
            />
          ))}
          <button className="addstrip" onClick={addChannel} data-hint="Add a mixer-only channel (a bus or a return): it gets no timeline lane">
            +
          </button>
          <svg className="cables" width="100%" height="100%">
            {cables.map((c, i) => (
              <path key={i} d={c.d} className={c.on ? "on" : ""} />
            ))}
            {ghost && <path d={ghost} className="on ghost" />}
          </svg>
          <canvas ref={canvas} className="mxmeters" />
        </div>
      </div>
      {menu?.kind === "chan" && menuChan?.track && (
        <PopMenu at={menu.at} onClose={closeMenu} title={chanLabel(s, menu.chan)}>
          <MenuItem
            close={closeMenu}
            label="Rename"
            run={() => {
              const el = document.querySelector<HTMLElement>(`.mxs[data-chan="${menu.chan}"] .sname`);
              el?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            }}
          />
          <MenuItem
            close={closeMenu}
            checked={menuChan.track.lane}
            disabled={menuChan.track.lane && menuChan.track.clips.length > 0}
            hint={menuChan.track.lane && menuChan.track.clips.length > 0 ? "It has clips, so it keeps its lane" : undefined}
            label="Show in timeline"
            run={() => void store().apply({ type: "set_track_lane", track: menu.chan, lane: !menuChan.track!.lane })}
          />
          <MenuItem close={closeMenu} label="Duplicate" run={() => void store().apply({ type: "duplicate_track", track: menu.chan })} />
          <div className="menu-sep" />
          <MenuItem
            close={closeMenu}
            label="Delete channel"
            run={() =>
              void store()
                .apply({ type: "delete_track", track: menu.chan })
                .then((ok) => {
                  if (ok) store().showToast(`Deleted ${menuChan.name}`, { action: { label: "Undo", run: () => void store().undo() } });
                })
            }
          />
        </PopMenu>
      )}
      {menu?.kind === "out" && <SendMenu from={menu.chan} at={menu.at} onClose={closeMenu} />}
    </section>
  );
}
