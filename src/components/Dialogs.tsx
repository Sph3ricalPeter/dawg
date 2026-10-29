import { useEffect, useRef } from "react";
import { exportDialog } from "@/lib/actions";
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

export function Dialogs() {
  const dialog = useSession((s) => s.dialog);
  if (!dialog) return null;
  return <DiscardDialog verb={dialog.verb} then={dialog.then} />;
}
