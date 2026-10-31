import { useEffect, useRef, useState } from "react";
import { api, type Codec, type ExportOptions } from "@/lib/api";
import { exportTo } from "@/lib/actions";
import { fmtSeconds, MIN_GAIN_DB } from "@/lib/format";
import { useSession } from "@/stores/session-store";

type RangeKind = "song" | "zero" | "range";

interface Choice {
  range: RangeKind;
  codec: Codec;
  bits: number;
  /** 0 is the session's own rate. */
  rate: number;
  kbps: number;
}

const KEY = "dawg.export";
const DEFAULT: Choice = { range: "song", codec: "wav", bits: 24, rate: 0, kbps: 320 };

/** Last export's choices, remembered between exports. */
function load(): Choice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Choice> | null;
    return { ...DEFAULT, ...(v ?? {}) };
  } catch {
    return DEFAULT;
  }
}

function keep(c: Choice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Only a convenience.
  }
}

function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string; disabled?: boolean; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="seg">
      {options.map((o) => (
        <button
          key={String(o.v)}
          className={value === o.v ? "on" : ""}
          disabled={o.disabled}
          title={o.hint}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** "Export mixdown" from the UX spec: what to mix, in what format, and a peak
 * readout that warns before the file clips. */
export function ExportDialog() {
  const open = useSession((s) => s.exportOpen);
  if (!open) return null;
  return <ExportDialogBody />;
}

function ExportDialogBody() {
  const session = useSession((s) => s.session);
  const range = useSession((s) => s.range);
  const masterDb = useSession((s) => s.session?.masterDb ?? 0);
  const [c, setC] = useState<Choice>(() => {
    const l = load();
    // A range made since the last export is probably what to export.
    return useSession.getState().range ? { ...l, range: "range" } : { ...l, range: l.range === "range" ? "song" : l.range };
  });
  const [measured, setMeasured] = useState<{ key: string; peak: number | null } | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const close = () => useSession.setState({ exportOpen: false });

  const rate = session?.rate ?? 48_000;
  const span: [number, number] | null =
    !session ? null : c.range === "range" && range ? [Math.round(range.a), Math.round(range.b)] : c.range === "zero" ? [0, session.end] : null;
  const spanKey = `${span ? span.join(":") : "song"}@${masterDb}`;
  // undefined while measuring.
  const peak = measured && measured.key === spanKey ? measured.peak : undefined;

  useEffect(() => {
    let live = true;
    api
      .mixPeak(span)
      .then((p) => live && setMeasured({ key: spanKey, peak: p }))
      .catch(() => live && setMeasured({ key: spanKey, peak: null }));
    return () => {
      live = false;
    };
    // The span's frames, not the array, decide it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spanKey]);

  useEffect(() => {
    primary.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!session) return null;
  const set = (p: Partial<Choice>) => setC((old) => ({ ...old, ...p }));
  const mp3 = c.codec === "mp3";
  const fileRate = c.rate || rate;
  const a = span ? span[0] : session.start;
  const b = span ? span[1] : session.end;
  const clips = peak !== undefined && peak !== null && peak > 0;
  const lower = () => {
    if (peak === null || peak === undefined) return;
    void useSession.getState().apply({ type: "set_master_gain", gain_db: Math.max(MIN_GAIN_DB, masterDb - (peak + 1)) });
  };
  const go = async () => {
    keep(c);
    const options: ExportOptions = {
      range: span,
      bits: mp3 ? null : c.bits,
      rate: c.rate && c.rate !== rate ? c.rate : null,
      kbps: mp3 ? c.kbps : null,
    };
    close();
    await exportTo(options, c.codec);
  };
  const khz = (r: number) => `${r / 1000} kHz`;

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dlg export" role="dialog" aria-label="Export mixdown">
        <header>Export mixdown</header>
        <div className="bd">
          <div className="row">
            <span className="k">Range</span>
            <Seg<RangeKind>
              value={c.range}
              onChange={(range) => set({ range })}
              options={[
                { v: "song", label: "Whole song", hint: "From the first clip heard to the end of the last" },
                { v: "zero", label: "From 0", hint: "Keeps any silence before the first clip" },
                { v: "range", label: "Range", disabled: !range, hint: range ? "The range on the ruler" : "Ctrl+drag the ruler to make a range" },
              ]}
            />
          </div>
          <div className="row">
            <span className="k" />
            <span className="dim mono">
              {fmtSeconds(Math.max(0, b - a) / rate)} · {(a / rate).toFixed(3)} to {(b / rate).toFixed(3)} s
            </span>
          </div>
          <div className="row">
            <span className="k">File</span>
            <Seg<Codec>
              value={c.codec}
              onChange={(codec) => set({ codec, rate: codec === "mp3" && c.rate > 48_000 ? 0 : c.rate })}
              options={[
                { v: "wav", label: "WAV" },
                { v: "mp3", label: "MP3" },
              ]}
            />
          </div>
          <div className="row">
            <span className="k">{mp3 ? "Bitrate" : "Depth"}</span>
            {mp3 ? (
              <Seg<number>
                value={c.kbps}
                onChange={(kbps) => set({ kbps })}
                options={[128, 192, 256, 320].map((v) => ({ v, label: `${v}` }))}
              />
            ) : (
              <Seg<number>
                value={c.bits}
                onChange={(bits) => set({ bits })}
                options={[
                  { v: 16, label: "16-bit" },
                  { v: 24, label: "24-bit" },
                  { v: 32, label: "32-bit float", hint: "Never clips: keeps anything over 0 dBFS" },
                ]}
              />
            )}
          </div>
          <div className="row">
            <span className="k">Rate</span>
            <Seg<number>
              value={c.rate === rate ? 0 : c.rate}
              onChange={(r) => set({ rate: r })}
              options={[
                { v: 0, label: `${khz(rate)} (project)` },
                ...[44_100, 48_000, 96_000]
                  .filter((r) => r !== rate && !(mp3 && r > 48_000))
                  .map((v) => ({ v, label: khz(v) })),
              ]}
            />
          </div>
          <div className="row">
            <span className="k">Peak</span>
            <span className={`mono ${clips && !(c.bits === 32 && !mp3) ? "bad" : "dim"}`}>
              {peak === undefined
                ? "measuring…"
                : peak === null
                  ? "silent"
                  : `${peak > 0 ? "+" : ""}${peak.toFixed(1)} dBFS${clips ? (c.bits === 32 && !mp3 ? " · over 0 dBFS, kept by float" : " · clips") : ""}`}
            </span>
            {peak !== undefined && peak !== null && peak > -0.95 && (
              <button className="btn ghost small" onClick={lower} data-hint="Turns the master down so the loudest peak is at −1 dBFS">
                Lower master to peak at −1 dBFS
              </button>
            )}
          </div>
          <div className="row">
            <span className="k" />
            <span className="faint">
              {mp3 ? `MP3 ${c.kbps} kbps` : c.bits === 32 ? "32-bit float WAV" : `${c.bits}-bit WAV`} · {khz(fileRate)}
            </span>
          </div>
        </div>
        <footer>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <span className="spacer" />
          <button ref={primary} className="btn primary" onClick={() => void go()}>
            Export… <kbd>Enter</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
