import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, type RecoveryNote } from "@/lib/api";
import { useSession } from "@/stores/session-store";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";

/** How often unsaved edits are snapshotted for crash recovery. */
const AUTOSAVE_MS = 30_000;

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return today ? `today at ${time}` : `${d.toLocaleDateString()} at ${time}`;
}

/** Asks, at launch, about edits earlier runs didn't save (a crash, or
 * Windows shutting down), and keeps autosaving every tab while this one
 * runs. Recovered sessions open as tabs. */
export function RecoverDialog() {
  const [notes, setNotes] = useState<RecoveryNote[]>([]);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    void api
      .recovery()
      .then(setNotes)
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      if (useSession.getState().tabs.length) void api.autosave().catch(() => undefined);
    }, AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (notes.length) primary.current?.focus();
  }, [notes]);

  if (!notes.length) return null;
  const discard = () => {
    setNotes([]);
    void api.discardRecovery().catch(() => undefined);
  };
  const recover = () => {
    setNotes([]);
    void useSession.getState().recover(notes.map((n) => n.key));
  };
  const one = notes.length === 1 ? notes[0] : null;
  const latest = Math.max(...notes.map((n) => n.savedAt));
  return (
    <Dialog
      label="Recover unsaved edits"
      title={one ? `Recover ${one.name}?` : `Recover ${notes.length} unsaved sessions?`}
      footer={
        <>
          <Button variant="ghost" onClick={discard}>
            Discard
          </Button>
          <span className="spacer" />
          <Button ref={primary} variant="primary" onClick={recover}>
            Recover <kbd>Enter</kbd>
          </Button>
        </>
      }
    >
      <span className="dim">
        {one
          ? `dawg closed before your edits to ${one.name} were saved. The last autosave is from ${when(one.savedAt)}.`
          : `dawg closed before these were saved. Each opens in a tab of its own. The last autosave is from ${when(latest)}.`}
      </span>
      {!one && (
        <div className="ulist">
          {notes.map((n) => (
            <div key={n.key}>
              <b>{n.name}</b>
              <span className="dim">{when(n.savedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
