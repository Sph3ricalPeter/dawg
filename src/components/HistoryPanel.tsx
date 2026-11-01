import { useEffect, useRef } from "react";
import { stepText } from "@/lib/history";
import { useSession } from "@/stores/session-store";

/** 16 px line icons for each kind of edit. */
const ICONS: Record<string, string> = {
  eq: "M1 12h3c2 0 2.5-8.5 4-8.5s2 8.5 4 8.5h3",
  volume: "M8 1.5v13M5 6.5h6v3H5z",
  pan: "M13.5 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM8 8.5 5.2 4.2",
  mute: "M2 6h2.5L8 3v10L4.5 10H2zm9 0 4 4m0-4-4 4",
  solo: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 5.5C9.6 5 9 4.8 8 4.8c-1.3 0-2 .7-2 1.5 0 2 4 1.2 4 3.4 0 .9-.8 1.5-2.1 1.5-1 0-1.7-.3-2.1-.8",
  fade: "M1.5 13.5 7 3h7.5",
  move: "M1.5 8h13M4 5.5 1.5 8 4 10.5M12 5.5l2.5 2.5-2.5 2.5",
  trim: "M10 2.5h3v11h-3M1.5 8H9M6.5 5.5 9 8l-2.5 2.5",
  split: "M8 1.5v13M1.5 5h4.5v6H1.5zM10 5h4.5v6H10z",
  add: "M8 3v10M3 8h10",
  delete: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  reverse: "M13.5 5.5h-11M5 3 2.5 5.5 5 8M2.5 10.5h11M11 8l2.5 2.5L11 13",
  stretch: "M1.5 3v10M14.5 3v10M4 8h8M6 6 4 8l2 2M10 6l2 2-2 2",
  pitch:
    "M5.5 13.5V3l7-1.5V12M5.5 13.5a2 2 0 1 1-2-2 2 2 0 0 1 2 2zm7-1.5a2 2 0 1 1-2-2 2 2 0 0 1 2 2z",
  envelope: "M1.5 12 5 5l4 4 5.5-6M5 5h.01M9 9h.01",
  colour: "M8 1.5c3 3.6 4.5 6 4.5 8a4.5 4.5 0 0 1-9 0c0-2 1.5-4.4 4.5-8z",
  tempo: "M5.5 2h5l3 12h-11zM8 11l3-6.5",
  rename: "M3 3.5h7M6.5 3.5v9M12.5 2.5v11M11 2.5h3M11 13.5h3",
};

function StepIcon({ kind }: { kind: string }) {
  if (kind === "ai") return <span className="aib">AI</span>;
  const d = ICONS[kind];
  if (!d) return <i />;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** "Q 9.49 → 3.14" with the arrow dimmed and the value after it brighter. */
function Change({ text }: { text: string }) {
  const parts = text.split(" → ");
  return (
    <>
      {parts[0]}
      {parts.slice(1).map((p, i) => {
        const cut = p.indexOf(", ");
        const to = cut < 0 ? p : p.slice(0, cut);
        return (
          <span key={i}>
            <span className="arr">→</span>
            <span className="to">{to}</span>
            {cut < 0 ? "" : p.slice(cut)}
          </span>
        );
      })}
    </>
  );
}

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
          <div className="hempty">
            Every edit lands here as one step, yours and an agent's (with an AI
            badge). Click a step to go back to it; Ctrl+Z and Ctrl+Y walk one
            step at a time.
          </div>
        )}
        {all
          .map((e, i) => ({ e, i }))
          .reverse()
          .map(({ e, i }) => (
            <button
              key={i}
              className={`he${i === done - 1 ? " cur" : ""}${i >= done ? " undone" : ""}`}
              onClick={() => jump(i + 1)}
              data-hint={
                i >= done
                  ? "Undone · click to redo up to here"
                  : "Click to go back to just after this edit"
              }
            >
              <span className="ic">
                <StepIcon kind={e.kind} />
              </span>
              <span className="lb" data-tip={stepText(e)}>
                <span className="pl">
                  {e.place.map((p, k) =>
                    k === e.place.length - 1 ? (
                      <b key={k}>{p}</b>
                    ) : (
                      <span key={k}>
                        {p}
                        <span className="sep">›</span>
                      </span>
                    ),
                  )}
                </span>
                {(e.change || e.edits > 1) && (
                  <span className="chg">
                    <Change text={e.change} />
                    {e.changes > 1 ? (
                      <span className="n">{e.changes} changes</span>
                    ) : (
                      e.edits > 1 && <span className="n">×{e.edits}</span>
                    )}
                  </span>
                )}
              </span>
              <span className="tm">{clock(e.at)}</span>
            </button>
          ))}
        {all.length > 0 && (
          <button
            className={`he${done === 0 ? " cur" : ""}`}
            onClick={() => jump(0)}
            data-hint="Click to undo everything"
          >
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
