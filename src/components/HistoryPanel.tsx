import { useEffect, useRef } from "react";
import { useSession } from "@/stores/session-store";

function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The History popover: every edit, newest first. Clicking a row goes back
 * (or forward) to just after that edit; undone rows stay until a new edit. */
export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const history = useSession((s) => s.session?.history ?? []);
  const future = useSession((s) => s.session?.future ?? []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest("#tHist")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const all = [...history, ...future];
  const done = history.length;
  const jump = (n: number) => void useSession.getState().jumpHistory(n);
  return (
    <div className="histpop" ref={ref} role="dialog" aria-label="History">
      <div className="phead">
        History<span className="faint">newest first · click to jump</span>
      </div>
      <div className="hist">
        {all.length === 0 && (
          <div className="hempty">Every edit lands here as one step, yours and an agent's (with an AI badge). Click a step to go back to it; Ctrl+Z and Ctrl+Y walk one step at a time.</div>
        )}
        {all
          .map((e, i) => ({ e, i }))
          .reverse()
          .map(({ e, i }) => (
            <button
              key={i}
              className={`he${i === done - 1 ? " cur" : ""}${i >= done ? " undone" : ""}`}
              onClick={() => jump(i + 1)}
              data-hint={i >= done ? "Undone · click to redo up to here" : "Click to go back to just after this edit"}
            >
              <span className="ic">{e.label.startsWith("AI: ") ? <span className="aib">AI</span> : <i />}</span>
              <span className="lb">{e.label.startsWith("AI: ") ? e.label.slice(4) : e.label}</span>
              <span className="tm">{clock(e.at)}</span>
            </button>
          ))}
        {all.length > 0 && (
          <button className={`he${done === 0 ? " cur" : ""}`} onClick={() => jump(0)} data-hint="Click to undo everything">
            <span className="ic">
              <i />
            </span>
            <span className="lb faint">Opened</span>
            <span className="tm" />
          </button>
        )}
      </div>
    </div>
  );
}
