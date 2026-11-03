import { useEffect, useRef, useState } from "react";
import { MASTER } from "@/lib/api";
import { PANELS, PRESETS, type PresetName } from "@/lib/layout";
import { useBrowser } from "@/stores/browser-store";
import { useLayout } from "@/stores/layout-store";
import { useSession } from "@/stores/session-store";

/** The title bar's Panels dropdown: a show/hide toggle for every panel of
 * the dock, and the layout presets. Toggles leave the menu open so several
 * can be flipped in one go; Esc or a click outside closes it. */
export function PanelsMenu() {
  const session = useSession((s) => s.session);
  const scratch = !!session?.scratch;
  const browserOpen = useBrowser((s) => (scratch ? s.openScratch : s.open));
  const mixerOpen = useSession((s) => s.mixerOpen && !!s.session);
  const chainOpen = useSession(
    (s) => s.chainOpen && s.channel !== null && (s.channel === MASTER || !!s.session?.tracks.some((t) => t.id === s.channel)),
  );
  const preset = useLayout((s) => s.preset);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const toggleChain = () => {
    const s = useSession.getState();
    if (chainOpen) return s.setChainOpen(false);
    // With no channel picked yet, the Chain shows the master's.
    const valid = s.channel !== null && (s.channel === MASTER || !!s.session?.tracks.some((t) => t.id === s.channel));
    if (valid) s.setChainOpen(true);
    else s.selectChannel(MASTER, true);
  };

  const toggles: { id: keyof typeof PANELS; on: boolean; run?: () => void; keys?: string; disabled?: boolean; note?: string }[] = [
    { id: "browser", on: browserOpen, run: () => useBrowser.getState().toggle(), keys: "Ctrl+Alt+B" },
    { id: "timeline", on: true, disabled: true, note: "always shown" },
    { id: "mixer", on: mixerOpen, run: () => useSession.getState().toggleMixer(), keys: "F9", disabled: !session },
    { id: "chain", on: chainOpen, run: toggleChain, disabled: !session },
  ];
  const shown = toggles.filter((t) => t.on && t.id !== "timeline").map((t) => PANELS[t.id].title);

  return (
    <div className="tg pnwrap" ref={ref}>
      <button
        className={`tb hb${open ? " on" : ""}`}
        aria-label="Panels"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={`Panels${shown.length ? ` · ${shown.join(", ")} shown` : ""}`}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="2.5" width="12" height="11" rx="1" />
          <path d="M6 2.5v11M6 9h8" />
        </svg>
        <span className="car">▾</span>
      </button>
      {open && (
        <div className="menu pnmenu" role="menu">
          <div className="menu-h">Show panels</div>
          {toggles.map((t) => (
            <button
              key={t.id}
              className={`menu-item check${t.on ? " on" : ""}`}
              role="menuitemcheckbox"
              aria-checked={t.on}
              disabled={t.disabled}
              onClick={t.run}
            >
              <span>
                <i className="tick">{t.on ? "✓" : ""}</i>
                {PANELS[t.id].title}
                {t.note && <span className="pnnote"> · {t.note}</span>}
              </span>
              {t.keys && <kbd>{t.keys}</kbd>}
            </button>
          ))}
          <div className="menu-sep" />
          <div className="menu-h">Layout</div>
          {(Object.keys(PRESETS) as PresetName[]).map((k) => (
            <button
              key={k}
              className={`menu-item check${preset === k ? " on" : ""}`}
              role="menuitemradio"
              aria-checked={preset === k}
              onClick={() => {
                useLayout.getState().applyPreset(k);
                setOpen(false);
              }}
            >
              <span>
                <i className="tick">{preset === k ? "✓" : ""}</i>
                {PRESETS[k].label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
