import { useEffect, useRef } from "react";
import { exportDialog, saveProject } from "@/lib/actions";
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
            You haven't exported them. To {verb} anyway, discard them, or export first.
          </span>
        </div>
        <footer>
          <button className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              setDialog(null);
              void exportDialog();
            }}
          >
            Export…
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

/** A project asks to save, like any document app. */
function SaveDialog({ then }: { then: () => void }) {
  const session = useSession((s) => s.session);
  const setDialog = useSession((s) => s.setDialog);
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = () => setDialog(null);
  useEscape(cancel);
  useEffect(() => primary.current?.focus(), []);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dlg small" role="dialog" aria-label="Unsaved changes">
        <header>Save changes to {session?.name}?</header>
        <div className="bd">
          <span className="dim">Your changes will be lost if you don't save them.</span>
        </div>
        <footer>
          <button className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              setDialog(null);
              then();
            }}
          >
            Don't save
          </button>
          <button
            ref={primary}
            className="btn primary"
            onClick={() => {
              setDialog(null);
              void saveProject().then((saved) => saved && then());
            }}
          >
            Save <kbd>Enter</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}

export function Dialogs() {
  const dialog = useSession((s) => s.dialog);
  const scratch = useSession((s) => s.session?.scratch ?? true);
  if (!dialog) return null;
  return scratch ? <DiscardDialog verb={dialog.verb} then={dialog.then} /> : <SaveDialog then={dialog.then} />;
}
