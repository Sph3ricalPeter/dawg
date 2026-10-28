import { useEffect, useRef, useState } from "react";
import { api, type SavePreview } from "@/lib/api";
import {
  closeAfterReplace,
  replaceAndMaybeClose,
  saveAsDialog,
  setCloseAfterReplace,
  showReplaceDialog,
} from "@/lib/actions";
import { fmtDb, fmtFormat, fmtSeconds } from "@/lib/format";
import { useSession } from "@/stores/session-store";

function useEscape(onEscape: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape]);
}

/** The source waveform with the parts a crop removes hatched. */
function KeptStrip({ preview }: { preview: SavePreview }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    void api.peaks(0, preview.framesBefore, w).then((p) => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = w * dpr;
      cv.height = h * dpr;
      const x = cv.getContext("2d");
      if (!x) return;
      x.scale(dpr, dpr);
      const keepA = (preview.cutStart / preview.framesBefore) * w;
      const keepB = ((preview.framesBefore - preview.cutEnd) / preview.framesBefore) * w;
      for (let i = 0; i < w; i++) {
        const lo = p[2 * i];
        const hi = p[2 * i + 1];
        x.fillStyle = i >= keepA && i < keepB ? "#ee9f98" : "rgba(238,159,152,.3)";
        x.fillRect(i, h / 2 - hi * (h / 2 - 2), 1, Math.max(1, (hi - lo) * (h / 2 - 2)));
      }
    });
  }, [preview]);
  const a = (preview.cutStart / preview.framesBefore) * 100;
  const b = (preview.cutEnd / preview.framesBefore) * 100;
  return (
    <div className="kept">
      <canvas ref={canvas} />
      {a > 0 && <div className="cut" style={{ left: 0, width: `${a}%`, borderRightWidth: 1 }} />}
      {b > 0 && <div className="cut" style={{ right: 0, width: `${b}%`, borderLeftWidth: 1 }} />}
    </div>
  );
}

function ReplaceDialog() {
  const session = useSession((s) => s.session);
  const busy = useSession((s) => s.busy);
  const setDialog = useSession((s) => s.setDialog);
  const [preview, setPreview] = useState<SavePreview | null>(null);
  const [closeAfter, setCloseAfter] = useState(closeAfterReplace);
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = () => setDialog(null);
  useEscape(cancel);

  useEffect(() => {
    void api.savePreview().then(setPreview);
  }, [session]);
  useEffect(() => primary.current?.focus(), [preview]);

  if (!session) return null;
  const rate = session.format.sampleRate;
  const p = preview;
  const lengthLine = p
    ? p.framesAfter === p.framesBefore
      ? "length unchanged"
      : [
          p.cutStart > 0 && `cut ${fmtSeconds(p.cutStart / rate)} at the start`,
          p.cutEnd > 0 && `${fmtSeconds(p.cutEnd / rate)} at the end`,
        ]
          .filter(Boolean)
          .join(", ")
    : "";
  const chunks = session.extraChunks.filter((c) => c !== "fact");

  const doReplace = () => {
    setCloseAfterReplace(closeAfter);
    setDialog(null);
    void replaceAndMaybeClose(closeAfter);
  };
  const doSaveAs = () => {
    setDialog(null);
    void saveAsDialog();
  };

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dlg" role="dialog" aria-label={`Replace ${session.name}`}>
        <header>Replace {session.name}</header>
        <div className="sub">{session.path}</div>
        <div className="bd">
          {p && (
            <>
              <div className="row">
                <span className="k">Result</span>
                <KeptStrip preview={p} />
              </div>
              <div className="row">
                <span className="k" />
                <span className="mono dim">
                  {fmtSeconds(p.framesBefore / rate)} → <b className="hl">{fmtSeconds(p.framesAfter / rate)}</b>
                  {" · "}
                  {lengthLine}
                </span>
              </div>
              <div className="row">
                <span className="k">Format</span>
                <span className="dim">
                  Same as the original: <b className="hl">{fmtFormat(session.format)}</b>
                </span>
              </div>
              <div className="row">
                <span className="k">Peak</span>
                <span className={`mono ${p.clipped ? "bad" : "dim"}`}>
                  {fmtDb(p.peakDb, false)}FS · {p.clipped ? "clips, lower the gain" : "no clipping"}
                </span>
              </div>
            </>
          )}
          <div className="note">
            <span className="dot" />
            <span>
              {p?.untouched
                ? "Nothing changed, so the file would be written back exactly as it is."
                : "The original is backed up first; dawg menu › Restore last replace puts it back."}
              {chunks.length > 0 && ` Metadata (${chunks.join(", ")}) is kept.`}
            </span>
          </div>
          <label className={`chk${closeAfter ? " on" : ""}`}>
            <input type="checkbox" checked={closeAfter} onChange={(e) => setCloseAfter(e.target.checked)} />
            <i />
            Close dawg after replacing
          </label>
        </div>
        <footer>
          <button className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <span className="spacer" />
          <button className="btn" onClick={doSaveAs} disabled={!!busy}>
            Save as new file…
          </button>
          <button
            ref={primary}
            className="btn primary"
            onClick={doReplace}
            disabled={!p || p.untouched || !!busy}
            title={p?.untouched ? "Nothing to replace yet" : undefined}
          >
            Replace original<kbd>Enter</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}

function DiscardDialog({ verb, then }: { verb: string; then: () => void }) {
  const session = useSession((s) => s.session);
  const setDialog = useSession((s) => s.setDialog);
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = () => setDialog(null);
  useEscape(cancel);
  useEffect(() => primary.current?.focus(), []);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dlg small" role="dialog" aria-label="Unsaved changes">
        <header>Discard your edits to {session?.name}?</header>
        <div className="bd">
          <span className="dim">
            You haven't saved them. To {verb} anyway, discard them; or replace the original first.
          </span>
        </div>
        <footer>
          <button className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <span className="spacer" />
          <button className="btn" onClick={showReplaceDialog}>
            Replace original…
          </button>
          <button
            ref={primary}
            className="btn primary"
            onClick={() => {
              setDialog(null);
              then();
            }}
          >
            Discard
          </button>
        </footer>
      </div>
    </div>
  );
}

export function Dialogs() {
  const dialog = useSession((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.type === "replace") return <ReplaceDialog />;
  return <DiscardDialog verb={dialog.verb} then={dialog.then} />;
}
