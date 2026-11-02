import { type DeviceKind, type DeviceState } from "@/lib/api";
import { commitDrag, removeSend, setSend } from "@/lib/chain-edit";
import { fmtDb, MIN_GAIN_DB } from "@/lib/format";
import { knobControl } from "@/lib/knob";
import {
  chanLabel,
  channelName,
  channelNumber,
  chainOf,
  DEVICE_HINTS,
  DEVICE_KINDS,
  DEVICE_NAMES,
  MAX_DEVICES,
  mixerOrder,
  SEND_MAX_DB,
  sendFrac,
  wouldLoop,
} from "@/lib/mixer";
import type { MenuAt } from "@/lib/popup";
import { useSession, useTracks } from "@/stores/session-store";
import { Knob } from "./Knob";
import { MenuItem, PopMenu } from "./PopMenu";
import { VOL_MIN } from "./Volume";

const store = useSession.getState;

/** A send level knob: −∞ at the bottom, 0 dB at 75%, +6 dB at the top. */
export function SendKnob({ from, to, db, size = 16 }: { from: number; to: number; db: number; size?: number }) {
  const ctl = knobControl(
    db <= MIN_GAIN_DB ? VOL_MIN : db,
    { rate: 0.25, min: VOL_MIN, max: SEND_MAX_DB, step: 1, res: 0.1, detent: 0.3 },
    (v, done) => (done ? commitDrag() : setSend(from, to, v <= VOL_MIN ? MIN_GAIN_DB : v, true)),
  );
  return (
    <span
      className="sendk"
      {...ctl}
      onDoubleClick={() => setSend(from, to, 0, false)}
      data-hint={`Send level ${fmtDb(db)} · drag up or down (Shift fine) · double-click for 0 dB`}
    >
      <Knob f={sendFrac(db)} size={size} color="var(--k-vol)" />
    </span>
  );
}

/** Where a channel sends: a checklist of every other channel and the
 * master, each connected one with its level. Ticking keeps the menu open;
 * a channel that would make a loop can't be ticked. */
export function SendMenu({ from, at, onClose }: { from: number; at: MenuAt; onClose: () => void }) {
  const session = useSession((s) => s.session);
  const tracks = useTracks();
  if (!session) return null;
  const s = { ...session, tracks };
  const me = tracks.find((t) => t.id === from);
  if (!me) return null;
  return (
    <PopMenu at={at} onClose={onClose} title={`${chanLabel(s, from)} sends to`} className="sendmenu">
      {mixerOrder(tracks)
        .filter((id) => id !== from)
        .map((id) => {
          const snd = me.sends.find((x) => x.to === id);
          const loop = !snd && wouldLoop(s, from, id);
          return (
            <div className="srow" key={id}>
              <MenuItem
                close={onClose}
                keep
                checked={!!snd}
                disabled={loop}
                hint={loop ? `${channelName(s, id)} already feeds ${channelName(s, from)}, so this would loop` : undefined}
                label={
                  <>
                    <span className="mno mono">C{channelNumber(s, id)}</span>
                    {channelName(s, id)}
                    {loop && <span className="dim"> · would loop</span>}
                  </>
                }
                run={() => (snd ? removeSend(from, id) : setSend(from, id, 0, false))}
              />
              {snd && (
                <>
                  <SendKnob from={from} to={id} db={snd.gainDb} />
                  <span className="sv mono">{fmtDb(snd.gainDb)}</span>
                </>
              )}
            </div>
          );
        })}
      {me.sends.length === 0 && <div className="menu-note warn">No output: this channel is silent</div>}
    </PopMenu>
  );
}

/** A compressor's "Input from": its own signal, or another channel's. */
export function SidechainMenu({ device, channel, at, onClose }: { device: DeviceState; channel: number; at: MenuAt; onClose: () => void }) {
  const session = useSession((s) => s.session);
  const tracks = useTracks();
  if (!session) return null;
  const s = { ...session, tracks };
  const set = (from: number | null) => void store().apply({ type: "set_sidechain", device: device.id, from });
  return (
    <PopMenu at={at} onClose={onClose} title="Sidechain: listen to" className="scmenu">
      <MenuItem close={onClose} checked={device.sidechain == null} label="Off (its own input)" run={() => set(null)} />
      <div className="menu-sep" />
      {tracks
        .filter((t) => t.id !== channel)
        .map((t) => {
          const loop = wouldLoop(s, t.id, channel);
          return (
            <MenuItem
              key={t.id}
              close={onClose}
              checked={device.sidechain === t.id}
              disabled={loop && device.sidechain !== t.id}
              hint={loop ? `${channelName(s, channel)} already feeds ${channelName(s, t.id)}, so this would loop` : undefined}
              label={
                <>
                  <span className="mno mono">C{channelNumber(s, t.id)}</span>
                  {channelName(s, t.id)}
                  {loop && <span className="dim"> · would loop</span>}
                </>
              }
              run={() => set(t.id)}
            />
          );
        })}
    </PopMenu>
  );
}

/** Adds a device to the end of a chain (or at `index`). */
export function AddDeviceMenu({ channel, index, at, onClose }: { channel: number; index?: number; at: MenuAt; onClose: () => void }) {
  const session = useSession((s) => s.session);
  if (!session) return null;
  const full = chainOf(session, channel).length >= MAX_DEVICES;
  const add = (kind: DeviceKind) =>
    void store().apply(index === undefined ? { type: "add_device", channel, kind } : { type: "add_device", channel, kind, index });
  return (
    <PopMenu at={at} onClose={onClose} title={`Add to ${channelName(session, channel)}`}>
      {DEVICE_KINDS.map((k) => (
        <MenuItem key={k} close={onClose} disabled={full} hint={DEVICE_HINTS[k]} label={DEVICE_NAMES[k]} run={() => add(k)} />
      ))}
      {full && <div className="menu-note">A chain holds {MAX_DEVICES} devices</div>}
    </PopMenu>
  );
}

/** A device's ⋯ menu. */
export function DeviceMenu({ device, channel, at, onClose }: { device: DeviceState; channel: number; at: MenuAt; onClose: () => void }) {
  const session = useSession((s) => s.session);
  if (!session) return null;
  const chain = chainOf(session, channel);
  const i = chain.findIndex((d) => d.id === device.id);
  return (
    <PopMenu at={at} onClose={onClose} title={DEVICE_NAMES[device.kind]}>
      <MenuItem
        close={onClose}
        label={device.on ? "Bypass" : "Enable"}
        run={() => void store().apply({ type: "set_device", device: device.id, on: !device.on })}
      />
      <MenuItem
        close={onClose}
        label="Duplicate"
        disabled={chain.length >= MAX_DEVICES}
        run={() => void store().apply({ type: "copy_device", device: device.id, channel, index: i + 1 })}
      />
      <div className="menu-sep" />
      <MenuItem close={onClose} label="Delete" keys="Del" run={() => void store().apply({ type: "remove_device", device: device.id })} />
    </PopMenu>
  );
}
