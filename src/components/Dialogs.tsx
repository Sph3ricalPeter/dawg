import { useEffect, useRef } from "react";
import { discardAllAndClose, exportDialog, reviewUnsaved, saveProject } from "@/lib/actions";
import type { TabInfo } from "@/lib/api";
import { frontName, useSession } from "@/stores/session-store";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";

function DiscardDialog({ verb, then }: { verb: string; then: () => void }) {
  const name = useSession(frontName);
  const setDialog = useSession((s) => s.setDialog);
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = () => setDialog(null);
  useEffect(() => primary.current?.focus(), []);
  return (
    <Dialog
      label="Unsaved changes"
      title={`Discard your edits to ${name}?`}
      onCancel={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <span className="spacer" />
          <Button
            onClick={() => {
              setDialog(null);
              void exportDialog();
            }}
          >
            Export…
          </Button>
          <Button
            ref={primary}
            variant="primary"
            onClick={() => {
              setDialog(null);
              then();
            }}
          >
            Discard
          </Button>
        </>
      }
    >
      <span className="dim">You haven't exported them. To {verb} anyway, discard them, or export first.</span>
    </Dialog>
  );
}

/** A project asks to save, like any document app. */
function SaveDialog({ then }: { then: () => void }) {
  const name = useSession(frontName);
  const setDialog = useSession((s) => s.setDialog);
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = () => setDialog(null);
  useEffect(() => primary.current?.focus(), []);
  return (
    <Dialog
      label="Unsaved changes"
      title={`Save changes to ${name}?`}
      onCancel={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <span className="spacer" />
          <Button
            onClick={() => {
              setDialog(null);
              then();
            }}
          >
            Don't save
          </Button>
          <Button
            ref={primary}
            variant="primary"
            onClick={() => {
              setDialog(null);
              void saveProject().then((saved) => saved && then());
            }}
          >
            Save <kbd>Enter</kbd>
          </Button>
        </>
      }
    >
      <span className="dim">Your changes will be lost if you don't save them.</span>
    </Dialog>
  );
}

/** Closing the window with several tabs unsaved: once, with the list. */
function QuitDialog({ tabs }: { tabs: TabInfo[] }) {
  const setDialog = useSession((s) => s.setDialog);
  const primary = useRef<HTMLButtonElement>(null);
  const cancel = () => setDialog(null);
  useEffect(() => primary.current?.focus(), []);
  return (
    <Dialog
      label="Unsaved tabs"
      title={`${tabs.length} tabs have unsaved changes`}
      onCancel={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <span className="spacer" />
          <Button
            ref={primary}
            onClick={() => {
              setDialog(null);
              void reviewUnsaved();
            }}
          >
            Review each…
          </Button>
          <Button
            onClick={() => {
              setDialog(null);
              discardAllAndClose();
            }}
          >
            Discard all and close
          </Button>
        </>
      }
    >
      <div className="ulist">
        {tabs.map((t) => (
          <div key={t.id}>
            <b>{t.name}</b>
            <span className="dim">{t.scratch ? "edit not exported" : t.path ? "edited since saving" : "never saved"}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useSession((s) => s.dialog);
  const scratch = useSession((s) => s.session?.scratch ?? true);
  if (!dialog) return null;
  if (dialog.type === "quit") return <QuitDialog tabs={dialog.tabs} />;
  return scratch ? <DiscardDialog verb={dialog.verb} then={dialog.then} /> : <SaveDialog then={dialog.then} />;
}
