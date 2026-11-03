import { useEffect, useRef, useState } from "react";
import tokensCss from "../../tokens.css?raw";
import { onFrame } from "@/lib/frame-loop";
import { clamp, fmtDb, MIN_GAIN_DB } from "@/lib/format";
import { knobControl } from "@/lib/knob";
import { Button, CloseButton, PowerButton, ToolButton } from "../Button";
import { Dialog } from "../Dialog";
import type { IconName } from "../Icon";
import { Knob, KnobField } from "../Knob";
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSep } from "../Menu";
import { LevelMeter } from "../Meter";
import { drawLevel, HEADER_LAW, MASTER_LAW, meterSegments, MIXER_LAW } from "../meter-law";
import { Volume } from "../Volume";

/* Every token and shared component on one page, in each state, so a
 * change to one shows everywhere it's used. Tokens are read from
 * tokens.css itself, so a new one appears here without touching this. */

interface Tok {
  name: string;
  value: string;
}

/** Every token in tokens.css, in file order. */
const TOKENS: Tok[] = [...tokensCss.matchAll(/^\s*(--[\w-]+):\s*(.+);/gm)].map((m) => ({ name: m[1], value: m[2] }));

const isColour = (t: Tok) => /^(#|rgba?\(|color-mix)/.test(t.value);
const COLOUR_GROUPS: [string, RegExp][] = [
  ["Surfaces", /^--(page|bg-)/],
  ["Lines and fills", /^--(line|fill|edge|white|black|ink|scrim)/],
  ["Text", /^--(text|accent)/],
  ["Timeline", /^--(grid|range|playhead)/],
  ["Knobs", /^--(knob|k-)/],
  ["Meters", /^--meter/],
  ["AI", /^--ai/],
];
const ICONS: IconName[] = ["browser", "play", "stop", "loop", "mixer", "history", "undo", "redo", "export", "connect", "source", "no-loop", "close", "minimize", "maximize", "win-close"];

/** A fake stereo signal for the meters: two slow, offset swells. */
function useSignal() {
  const level = useRef<[number, number]>([0, 0]);
  useEffect(
    () =>
      onFrame((now) => {
        const t = now / 1000;
        level.current = [0.55 + 0.5 * Math.sin(t * 1.3), 0.5 + 0.5 * Math.sin(t * 1.3 + 0.9)].map((v) => clamp(v, 0, 1.2)) as [number, number];
      }),
    [],
  );
  return level;
}

/** The mixer's canvas meters, with peak hold, drawn from the fake signal. */
function MixerMeters({ signal }: { signal: React.RefObject<[number, number]> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const x = c?.getContext("2d");
    if (!c || !x) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 9;
    const h = 96;
    c.width = w * dpr;
    c.height = h * dpr;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const segs = meterSegments(MIXER_LAW);
    const pk = [-70, -70];
    return onFrame((_, dt) => {
      x.clearRect(0, 0, w, h);
      for (let ch = 0; ch < 2; ch++) {
        const v = signal.current[ch];
        const db = v > 0 ? 20 * Math.log10(v) : -70;
        pk[ch] = db >= pk[ch] ? db : pk[ch] - 12 * dt;
        drawLevel(x, ch * 5, 0, 4, h, db, pk[ch], MIXER_LAW, segs);
      }
    });
  }, [signal]);
  return <canvas className="mixmeter" ref={ref} />;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {note && <p className="note">{note}</p>}
      {children}
    </section>
  );
}

function Swatches() {
  const colours = TOKENS.filter(isColour);
  const groups = COLOUR_GROUPS.map(([g, re]) => [g, colours.filter((t) => re.test(t.name))] as const);
  const rest = colours.filter((t) => !COLOUR_GROUPS.some(([, re]) => re.test(t.name)));
  return (
    <>
      {[...groups, ["One meaning each", rest] as const].map(([g, ts]) => (
        <div key={g} style={{ marginBottom: "var(--sp-6)" }}>
          <p className="tag">{g}</p>
          <div className="grid">
            {ts.map((t) => (
              <div className="sw" key={t.name}>
                <i style={{ background: `var(${t.name})` }} />
                <div style={{ minWidth: 0 }}>
                  <code className="nm">{t.name}</code>
                  <code>{t.value}</code>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export function Gallery() {
  const signal = useSignal();
  const [vol, setVol] = useState(-4.5);
  const [gain, setGain] = useState(2);
  const [time, setTime] = useState(0.35);
  const [pan, setPan] = useState(-0.3);
  const [snap, setSnap] = useState("Beat");
  const [env, setEnv] = useState(true);
  const [on, setOn] = useState(true);
  const [dialog, setDialog] = useState(false);
  const sizes = TOKENS.filter((t) => t.name.startsWith("--fs-"));
  const radii = TOKENS.filter((t) => t.name.startsWith("--r-"));
  const gaps = TOKENS.filter((t) => t.name.startsWith("--sp-"));
  const shadows = TOKENS.filter((t) => t.name.startsWith("--shadow-"));
  return (
    <div className="gal">
      <div>
        <h1>dawg components</h1>
        <p className="lede">
          The tokens in <code>src/tokens.css</code> and the shared components in <code>src/ui</code>, live. Knobs drag and
          wheel, meters run on a test signal. The rules are in <code>design/design-system.md</code> (project files) and CLAUDE.md.
        </p>
      </div>

      <Section title="Colour" note="Surfaces, lines and text, then colours that each mean one thing (solo, mute, gain reduction…). Use the token, never the value.">
        <Swatches />
      </Section>

      <Section title="Type" note="Manrope everywhere, numbers included, with tabular figures.">
        <div className="cell">
          {sizes.map((t) => (
            <div className="row" key={t.name} style={{ gap: "var(--sp-5)" }}>
              <code className="tag" style={{ width: 110 }}>
                {t.name} {t.value}
              </code>
              <span style={{ fontSize: `var(${t.name})` }}>Snare top 2 · −12.5 dB · 124.00 BPM</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Corners, gaps and shadows">
        <div className="row" style={{ marginBottom: "var(--sp-6)" }}>
          {radii.map((t) => (
            <div className="cell" key={t.name}>
              <div className="box" style={{ borderRadius: `var(${t.name})` }} />
              <code className="tag">{t.name}</code>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginBottom: "var(--sp-6)", alignItems: "flex-end" }}>
          {gaps.map((t) => (
            <div className="cell" key={t.name}>
              <div style={{ width: `var(${t.name})`, height: 24, background: "var(--knob)" }} />
              <code className="tag">
                {t.name} {t.value}
              </code>
            </div>
          ))}
        </div>
        <div className="row" style={{ gap: "var(--sp-7)" }}>
          {shadows.map((t) => (
            <div className="cell" key={t.name}>
              <div className="shadow" style={{ boxShadow: `var(${t.name})` }} />
              <code className="tag">{t.name}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Knob" note="Arc knob, coloured by concern: level (blue), stereo (orange), time and shape (green). Bipolar knobs fill from the centre.">
        <div className="row panel">
          {[12, 16, 20, 26, 28].map((s) => (
            <div className="cell" key={s}>
              <Knob f={0.62} size={s} />
              <code className="tag">{s}px</code>
            </div>
          ))}
          <Knob f={0.4} size={26} color="var(--k-time)" />
          <Knob f={-0.5} bipolar size={26} color="var(--k-pan)" />
          <Knob f={0.6} bipolar size={26} color="var(--k-pan)" />
        </div>
      </Section>

      <Section title="KnobField" note="A knob with its value and name. Drag up or down (Shift fine, Ctrl steps), wheel, double-click resets. Stack for device and clip params, side for a short row (EQ bands).">
        <div className="row panel">
          <KnobField
            label="Makeup"
            value={fmtDb(gain)}
            f={(gain + 12) / 36}
            control={knobControl(gain, { rate: 0.1, min: -12, max: 24, step: 1, res: 0.1, detent: 0.3 }, (v) => setGain(v))}
            onReset={() => setGain(0)}
            hint="Makeup"
          />
          <KnobField
            label="Attack"
            value={`${Math.round(time * 200)} ms`}
            f={time}
            concern="time"
            control={knobControl(time, { rate: 1 / 160, min: 0, max: 1, step: 0.05, res: 0.001, detent: 0 }, (v) => setTime(v))}
            onReset={() => setTime(0.35)}
            hint="Attack"
          />
          <KnobField
            layout="side"
            label="Gain"
            value={fmtDb(gain)}
            f={gain / 24}
            bipolar
            size={26}
            control={knobControl(gain, { rate: 0.1, min: -24, max: 24, step: 1, res: 0.1, detent: 0.3 }, (v) => setGain(v))}
            onReset={() => setGain(0)}
            hint="Gain"
          />
          <KnobField
            layout="side"
            label="Pan"
            value={pan === 0 ? "C" : `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`}
            f={pan}
            bipolar
            size={26}
            concern="pan"
            control={knobControl(pan * 100, { rate: 1, min: -100, max: 100, step: 10, res: 1, detent: 4 }, (v) => setPan(v / 100))}
            onReset={() => setPan(0)}
            hint="Pan"
          />
        </div>
      </Section>

      <Section title="Volume and meters" note="The one volume control (knob, dB, meter) for tracks and the master; the mixer draws its meters on a canvas with the same scale and colours.">
        <div className="row panel">
          <div style={{ width: 150 }}>
            <Volume
              className="trk"
              db={vol}
              hint="Track volume"
              onDrag={(v) => setVol(v)}
              onSet={(v) => setVol(v)}
              before={<LevelMeter className="tm" vertical law={HEADER_LAW} live read={() => signal.current} />}
            />
          </div>
          <div className="tg master">
            <Volume
              db={vol}
              hint="Master volume"
              onDrag={(v) => setVol(v)}
              onSet={(v) => setVol(v <= MIN_GAIN_DB ? MIN_GAIN_DB : v)}
              after={<LevelMeter className="mstr" vertical={false} law={MASTER_LAW} live read={() => signal.current} />}
            />
          </div>
          <MixerMeters signal={signal} />
        </div>
      </Section>

      <Section title="Buttons">
        <div className="row panel">
          <Button>Export…</Button>
          <Button variant="primary">
            Save <kbd>Enter</kbd>
          </Button>
          <Button variant="ghost">Cancel</Button>
          <Button disabled>Disabled</Button>
          <Button small>Small</Button>
          <Button small variant="primary">
            Restart now
          </Button>
        </div>
        <div className="row panel" style={{ marginTop: "var(--sp-4)" }}>
          <ToolButton icon="play" on aria-label="Play" />
          <ToolButton icon="loop" aria-label="Loop" />
          <ToolButton icon="undo" disabled aria-label="Undo" />
          <ToolButton icon="history" className="hb" aria-label="History">
            <span className="car">▾</span>
          </ToolButton>
          <CloseButton aria-label="Close" />
          <span className="chip">
            Kick
            <CloseButton size="sm" aria-label="Remove" />
          </span>
          <PowerButton on={on} onClick={() => setOn(!on)} aria-label="Power" />
          <PowerButton on={false} aria-label="Power off" />
        </div>
      </Section>

      <Section title="Icons" note="Named in ui/Icon.tsx; they take the button's colour.">
        <div className="row panel">
          {ICONS.map((n) => (
            <div className="cell" key={n} style={{ alignItems: "center", width: 64 }}>
              <ToolButton icon={n} aria-label={n} />
              <code className="tag">{n}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Menu" note="Rows, ticks (left column), group names, lines and notes. PopMenu places the same box at a point.">
        <div className="row">
          <div className="menuspot">
            <Menu title="Kick">
              <MenuItem label="Rename…" keys="Dbl-click" run={() => undefined} />
              <MenuItem label="Move up" keys="Alt+↑" disabled run={() => undefined} />
              <MenuSep />
              <MenuItem label="Delete track" run={() => undefined} />
              <MenuNote warn>No output: this channel is silent</MenuNote>
            </Menu>
          </div>
          <div className="menuspot">
            <Menu>
              <MenuLabel>Snap</MenuLabel>
              {["Bar", "Beat", "Off"].map((s) => (
                <MenuItem key={s} label={s} checked={snap === s} radio keep run={() => setSnap(s)} />
              ))}
              <MenuSep />
              <MenuItem label="Envelope editing" keys="E" checked={env} keep run={() => setEnv(!env)} />
            </Menu>
          </div>
        </div>
      </Section>

      <Section title="Dialog">
        <Button onClick={() => setDialog(true)}>Show a dialog</Button>
        {dialog && (
          <Dialog
            label="Unsaved changes"
            title="Save changes to demo?"
            onCancel={() => setDialog(false)}
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialog(false)}>
                  Cancel
                </Button>
                <span className="spacer" />
                <Button onClick={() => setDialog(false)}>Don't save</Button>
                <Button variant="primary" onClick={() => setDialog(false)}>
                  Save <kbd>Enter</kbd>
                </Button>
              </>
            }
          >
            <span className="dim">Your changes will be lost if you don't save them.</span>
          </Dialog>
        )}
      </Section>
    </div>
  );
}
