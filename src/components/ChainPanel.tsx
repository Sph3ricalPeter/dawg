import { useEffect, useRef, useState } from "react";
import { MASTER, type DeviceState } from "@/lib/api";
import { bypassAll, setDeviceOn } from "@/lib/chain-edit";
import { startDrag } from "@/lib/drag";
import { fmtDb } from "@/lib/format";
import { chanLabel, channelName, channelNumber, chainOf, deviceNames, fmtPan, MASTER_COLOR } from "@/lib/mixer";
import { type MenuAt, under } from "@/lib/popup";
import { trackColor } from "@/lib/timeline";
import { useMasterChain, useSession, useTracks } from "@/stores/session-store";
import { CompressorBody, EqBody, UtilityBody } from "./Devices";
import { PanelHead } from "./Dock";
import { AddDeviceMenu, DeviceMenu, SendMenu, SidechainMenu } from "./RouteMenus";

const store = useSession.getState;

type Menu =
  | { kind: "add"; at: MenuAt }
  | { kind: "out"; at: MenuAt }
  | { kind: "device"; device: DeviceState; at: MenuAt }
  | { kind: "sidechain"; device: DeviceState; at: MenuAt };

/** A device's card: the power dot, name, its menu and its controls. Drag
 * the title to reorder (Alt copies), or onto another channel's strip or
 * track header to copy it there. Double-click the title folds the card. */
export function DeviceCard({
  device,
  name,
  color,
  selected,
  folded,
  listen,
  onSelect,
  onFold,
  onMenu,
  onSidechain,
  onTitleDown,
}: {
  device: DeviceState;
  name: string;
  color: string;
  selected: boolean;
  folded: boolean;
  listen: boolean;
  onSelect: () => void;
  onFold: () => void;
  onMenu: (at: MenuAt) => void;
  onSidechain: (at: MenuAt) => void;
  onTitleDown?: (e: React.PointerEvent) => void;
}) {
  const session = useSession((s) => s.session);
  const tracks = useTracks();
  const sc = device.sidechain;
  const scLabel = session && sc != null ? chanLabel({ ...session, tracks }, sc) : "Off";
  const power = (
    <button
      className="pw"
      onClick={(e) => {
        e.stopPropagation();
        setDeviceOn(device.id, !device.on);
      }}
      data-hint={device.on ? "On · click to bypass" : "Bypassed · click to turn on"}
    />
  );
  return (
    <div
      className={`card k-${device.kind}${device.on ? "" : " off"}${selected ? " sel" : ""}${folded ? " folded" : ""}`}
      data-dev={device.id}
      onPointerDownCapture={onSelect}
    >
      <div
        className="ctitle"
        onPointerDown={(e) => {
          if (e.button === 0 && !(e.target as HTMLElement).closest("button")) onTitleDown?.(e);
        }}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && onFold()}
        data-hint="Drag to reorder (Alt+drag copies) · drop on another channel to copy it there · double-click folds"
      >
        {power}
        <span className="cn">{name}</span>
        {!folded && <span className="sp" />}
        {!folded && device.kind === "compressor" && (
          <button
            className={`hb${sc != null ? " lit" : ""}`}
            onClick={(e) => onSidechain(under(e.currentTarget))}
            data-hint="Sidechain input: let another channel drive this compressor"
          >
            Sidechain: {scLabel}
          </button>
        )}
        {!folded && (
          <button className="hb" onClick={(e) => onMenu(under(e.currentTarget))} data-hint="Device menu: bypass, duplicate, delete">
            ⋯
          </button>
        )}
      </div>
      {!folded &&
        (device.kind === "eq" ? (
          <EqBody device={device} color={color} listen={listen} />
        ) : device.kind === "compressor" ? (
          <CompressorBody device={device} />
        ) : (
          <UtilityBody device={device} />
        ))}
    </div>
  );
}

/** Where a dragged card would land: the gap index among the cards. */
function gapAt(cards: HTMLElement[], x: number): number {
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return cards.length;
}

/** The Chain panel: the selected channel's devices, left to right in
 * signal order, then its volume and pan, which are always last. */
export function ChainPanel() {
  const session = useSession((s) => s.session);
  const channel = useSession((s) => s.channel);
  const tracks = useTracks();
  const masterChain = useMasterChain();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [selDev, setSelDev] = useState<number | null>(null);
  const [folded, setFolded] = useState<Set<number>>(() => new Set());
  const [drop, setDrop] = useState<{ x: number; y: number; h: number } | null>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  const index = tracks.findIndex((t) => t.id === channel);
  const track = index >= 0 ? tracks[index] : null;
  const isMaster = channel === MASTER;
  const chain = isMaster ? masterChain : (track?.chain ?? []);

  // Del deletes the selected card when no clip is selected.
  const hasSel = selDev !== null && chain.some((d) => d.id === selDev);
  useEffect(() => {
    if (selDev === null || !hasSel) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key !== "Delete" || store().selected.length) return;
      e.preventDefault();
      e.stopPropagation();
      void store().apply({ type: "remove_device", device: selDev });
      setSelDev(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selDev, hasSel]);

  if (!session || channel === null || (!isMaster && !track)) return null;
  const s = { ...session, tracks };
  const id = channel;
  const color = isMaster ? MASTER_COLOR : trackColor(index, track!.color, track!.category);
  const names = deviceNames(chain);
  // Which EQ the analyser listens after: the selected one, else the first.
  const eqs = chain.filter((d) => d.kind === "eq");
  const listenTo = eqs.find((d) => d.id === selDev)?.id ?? eqs[0]?.id ?? null;
  const ins = [
    ...(track && track.clips.length ? ["Clips"] : []),
    ...tracks.filter((t) => t.sends.some((x) => x.to === id)).map((t) => channelName(s, t.id)),
  ];
  const outs = track?.sends ?? [];

  const dragCard = (e: React.PointerEvent, d: DeviceState) => {
    const el = cardsRef.current;
    if (!el) return;
    const cards = [...el.querySelectorAll<HTMLElement>(":scope > .card")];
    const from = chain.findIndex((x) => x.id === d.id);
    let gap = from;
    let target: number | null = id;
    startDrag(e, {
      move: (_dx, _dy, ev) => {
        const over = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const chanEl = over?.closest<HTMLElement>("[data-chan]");
        const inCards = !!over?.closest(".chp .cards");
        document.querySelectorAll(".dropchan").forEach((x) => x.classList.remove("dropchan"));
        if (inCards) {
          target = id;
          gap = gapAt(cards, ev.clientX);
          const box = el.getBoundingClientRect();
          const ref = cards[gap] ?? cards[cards.length - 1];
          const r = ref.getBoundingClientRect();
          setDrop({ x: (cards[gap] ? r.left - 4 : r.right + 2) - box.left + el.scrollLeft, y: r.top - box.top, h: r.height });
        } else if (chanEl && Number(chanEl.dataset.chan) !== id) {
          target = Number(chanEl.dataset.chan);
          chanEl.classList.add("dropchan");
          setDrop(null);
        } else {
          target = null;
          setDrop(null);
        }
      },
      end: (moved, ev) => {
        setDrop(null);
        document.querySelectorAll(".dropchan").forEach((x) => x.classList.remove("dropchan"));
        if (!moved || target === null) return;
        if (target !== id) {
          void store().apply({ type: "copy_device", device: d.id, channel: target, index: chainOf(s, target).length });
          return;
        }
        if (ev.altKey) {
          void store().apply({ type: "copy_device", device: d.id, channel: id, index: gap });
          return;
        }
        const to = gap > from ? gap - 1 : gap;
        if (to !== from) void store().apply({ type: "move_device", device: d.id, channel: id, index: to });
      },
    });
  };

  const nDev = chain.length;
  const allOff = nDev > 0 && chain.every((d) => !d.on);
  const outLabel = isMaster
    ? "Out"
    : outs.length
      ? outs.map((x) => `${channelName(s, x.to)}${x.gainDb !== 0 ? ` ${fmtDb(x.gainDb)}` : ""}`).join(", ")
      : "No output";

  return (
    <section className="chp" style={{ ["--c" as string]: color }}>
      <PanelHead id="chain" className="eqh chh">
        <b>Chain</b>
        <span className="eqt" data-tip={isMaster ? "The master channel" : "The selected channel: click a track header or a mixer strip"}>
          C{channelNumber(s, id)} {channelName(s, id)}
        </span>
        <span className="chflow">
          <span className="dim">In:</span> {isMaster ? "every channel sending to it" : ins.length ? ins.join(", ") : "nothing yet"}
          <span className="dim"> → </span>
          {nDev} device{nDev === 1 ? "" : "s"}
          <span className="dim"> → </span>
          {isMaster ? "Volume" : "Volume · Pan"}
          <span className="dim"> → </span>
          {isMaster ? (
            <span>{outLabel}</span>
          ) : (
            <button
              className={`hb out${outs.length ? "" : " none"}`}
              onClick={(e) => setMenu({ kind: "out", at: under(e.currentTarget) })}
              data-hint="Where this channel sends · click to tick destinations"
            >
              {outLabel} ▾
            </button>
          )}
        </span>
        <span className="sp" />
        {nDev > 0 && (
          <button className={`eqb${allOff ? " lit" : ""}`} onClick={() => bypassAll(chain)} data-hint="Bypass every device on this channel, or turn them back on">
            Bypass all
          </button>
        )}
        <button className="eqb" onClick={(e) => setMenu({ kind: "add", at: under(e.currentTarget) })} data-hint="Add a device to the end of the chain">
          + Device
        </button>
        <button className="eqx" onClick={() => store().setChainOpen(false)} data-hint="Close the Chain panel (click a track header to show it again)">
          ✕
        </button>
      </PanelHead>
      <div className="chbody">
        <div className="cards" ref={cardsRef} onPointerDown={(e) => e.target === e.currentTarget && setSelDev(null)}>
          {chain.map((d, i) => (
            <DeviceCard
              key={d.id}
              device={d}
              name={names[i]}
              color={color}
              selected={selDev === d.id}
              folded={folded.has(d.id)}
              listen={d.id === listenTo}
              onSelect={() => setSelDev(d.id)}
              onFold={() =>
                setFolded((f) => {
                  const n = new Set(f);
                  if (!n.delete(d.id)) n.add(d.id);
                  return n;
                })
              }
              onMenu={(at) => setMenu({ kind: "device", device: d, at })}
              onSidechain={(at) => setMenu({ kind: "sidechain", device: d, at })}
              onTitleDown={(e) => dragCard(e, d)}
            />
          ))}
          {!nDev && (
            <div className="chempty dim">
              No devices on {channelName(s, id)} yet. Click <b>+</b> to add an EQ, a compressor or a utility.
            </div>
          )}
          <button className="addcard" onClick={(e) => setMenu({ kind: "add", at: under(e.currentTarget) })} data-hint="Add a device">
            +
          </button>
          <div className="tail">
            <span>
              Volume<b className="mono">{fmtDb(isMaster ? session.masterDb : track!.gainDb)}</b>
            </span>
            {!isMaster && (
              <span>
                Pan<b className="mono">{fmtPan(track!.pan)}</b>
              </span>
            )}
            <span className="dim">Not devices: always last, before the sends</span>
          </div>
          {drop && <div className="ins" style={{ left: drop.x, top: drop.y, height: drop.h }} />}
        </div>
      </div>
      {menu?.kind === "add" && <AddDeviceMenu channel={id} at={menu.at} onClose={() => setMenu(null)} />}
      {menu?.kind === "out" && <SendMenu from={id} at={menu.at} onClose={() => setMenu(null)} />}
      {menu?.kind === "device" && <DeviceMenu device={menu.device} channel={id} at={menu.at} onClose={() => setMenu(null)} />}
      {menu?.kind === "sidechain" && <SidechainMenu device={menu.device} channel={id} at={menu.at} onClose={() => setMenu(null)} />}
    </section>
  );
}
