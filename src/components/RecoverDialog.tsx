import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, type RecoveryNote } from "@/lib/api";
import { useSession } from "@/stores/session-store";

/** How often unsaved edits are snapshotted for crash recovery. */
const AUTOSAVE_MS = 30_000;

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return today ? `today at ${time}` : `${d.toLocaleDateString()} at ${time}`;
}

/** Asks, at launch, about edits an earlier run didn't save (a crash, or
 * Windows shutting down), and keeps autosaving while this one runs. */
export function RecoverDialog() {
  const [note, setNote] = useState<RecoveryNote | null>(null);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    void api
      .recovery()
      .then(setNote)
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      if (useSession.getState().session) void api.autosave().catch(() => undefined);
    }, AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (note) primary.current?.focus();
  }, [note]);

  if (!note) return null;
  const discard = () => {
    setNote(null);
    void api.discardRecovery().catch(() => undefined);
  };
  const recover = () => {
    setNote(null);
    const s = useSession.getState();
    s.guard("recover the unsaved edits", () => void useSession.getState().recover());
  };
  return (
    <div className="scrim">
      <div className="dlg small" role="dialog" aria-label="Recover unsaved edits">
        <header>Recover {note.name}?</header>
        <div className="bd">
          <span className="dim">
            dawg closed before your edits to {note.name} were saved. The last autosave is from {when(note.savedAt)}.
          </span>
        </div>
        <footer>
          <button className="btn ghost" onClick={discard}>
            Discard
          </button>
          <span className="spacer" />
          <button ref={primary} className="btn primary" onClick={recover}>
            Recover <kbd>Enter</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
