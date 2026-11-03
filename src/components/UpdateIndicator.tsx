import { useEffect, useRef, useState } from "react";
import { shortVersion, updateLine, useUpdaterStore } from "@/stores/updater-store";
import { registerRichTip } from "@/lib/rich-tips";
import { Menu } from "@/ui/Menu";
import { Button } from "@/ui/Button";

/** The updater's line icons. They say how to paint themselves, like the
 * icons in ui/Icon, because `.tb svg:not([fill])` fills any that don't. */
const Svg = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <svg
    viewBox="0 0 16 16"
    className={className}
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

const DownloadIcon = () => (
  <Svg>
    <path d="M8 2.5V10M5 7.2 8 10.1l3-2.9M2.5 10.5v3h11v-3" />
  </Svg>
);

const SpinnerIcon = () => (
  <Svg className="spin">
    <path d="M8 2a6 6 0 1 0 6 6" />
  </Svg>
);

const CheckIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.3 8.2 7.2 10l3.5-3.8" />
  </Svg>
);

/** A green arrow into a tray: an update is downloaded and waits for a restart. */
const ReadyIcon = () => (
  <Svg>
    <path d="M8 2v7.5M5 6.7 8 9.6l3-2.9M2.5 10v3.5h11V10" />
    <circle className="upd-pip" cx="13" cy="3" r="2" />
  </Svg>
);

/** Download progress as a ring filling round an arrow. */
const ProgressIcon = ({ progress }: { progress: number }) => {
  const C = 2 * Math.PI * 6.5;
  return (
    <Svg>
      <circle className="upd-track" cx="8" cy="8" r="6.5" />
      <circle
        className="upd-ring"
        cx="8"
        cy="8"
        r="6.5"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - Math.max(0.04, progress / 100))}
      />
      <path d="M8 5v5.5M6 8.6 8 10.6l2-2" />
    </Svg>
  );
};

const WarnIcon = () => (
  <Svg>
    <path d="M8 2 1.5 13.5h13zM8 6.5v3.5M8 11.5v.5" />
  </Svg>
);

/** Release notes as short lines: drops the "What's new" heading, the install
 * footer after "---", and list markers. At most a handful of lines. */
function noteLines(notes: string): { lines: string[]; more: number } {
  const all: string[] = [];
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (line === "---") break;
    if (!line || line.startsWith("#")) continue;
    all.push(line.replace(/^[-*]\s+/, ""));
  }
  const MAX = 6;
  return { lines: all.slice(0, MAX), more: Math.max(0, all.length - MAX) };
}

function when(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** What the update is: current → new, the commit or release notes, and when
 * it was published. Shared by the hover tooltip and the click dropdown. */
function UpdateDetails({ foot }: { foot?: React.ReactNode }) {
  const status = useUpdaterStore((s) => s.status);
  const version = useUpdaterStore((s) => s.pendingVersion);
  const current = useUpdaterStore((s) => s.currentVersion);
  const notes = useUpdaterStore((s) => s.releaseNotes);
  const commit = useUpdaterStore((s) => s.pendingCommit);
  const date = useUpdaterStore((s) => s.pendingDate);
  const progress = useUpdaterStore((s) => s.downloadProgress);
  if (!version) return null;
  const published = when(date);
  const { lines, more } = noteLines(notes ?? "");
  const head = status === "downloading" ? `Downloading update · ${progress}%` : "Update ready";
  return (
    <div className="updtip">
      <div className="updtip-head">
        {head}
        {published && <span className="faint"> · {published}</span>}
      </div>
      <div className="updtip-vers">
        {current && (
          <>
            <span className="faint">{current}</span>
            <span className="updtip-arrow">→</span>
          </>
        )}
        <span className="updtip-new">{version}</span>
      </div>
      {(lines.length > 0 || commit) && (
        <ul className="updtip-notes">
          {lines.map((l, i) => (
            <li key={i}>
              {i === 0 && commit && <code>{commit}</code>}
              {l}
            </li>
          ))}
          {lines.length === 0 && commit && (
            <li>
              <code>{commit}</code>
            </li>
          )}
          {more > 0 && <li className="faint">and {more} more</li>}
        </ul>
      )}
      {foot}
    </div>
  );
}

function UpdateTip() {
  const status = useUpdaterStore((s) => s.status);
  return (
    <UpdateDetails
      foot={
        <div className="updtip-foot faint">
          {status === "ready" ? "Click to restart and install." : "Installs when you restart."}
        </div>
      }
    />
  );
}

registerRichTip("update", <UpdateTip />);

/**
 * Title-bar updater: one icon button whose icon says where the updater stands.
 * Not checked: download arrow, click checks. Up to date: check mark (green for
 * a moment after a check that found nothing). Checking: spinner. Downloading:
 * a ring filling with progress. Ready: green arrow with a dot; hover shows
 * what's new, click opens the same with Restart now. Error: warning, click retries.
 */
export function UpdateIndicator() {
  const status = useUpdaterStore((s) => s.status);
  const version = useUpdaterStore((s) => s.pendingVersion);
  const progress = useUpdaterStore((s) => s.downloadProgress);
  const error = useUpdaterStore((s) => s.error);
  const lastChecked = useUpdaterStore((s) => s.lastChecked);
  const checkNow = useUpdaterStore((s) => s.checkNow);
  const restart = useUpdaterStore((s) => s.restart);

  // After a click that finds nothing, say so for a moment.
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!confirmed) return;
    const t = window.setTimeout(() => setConfirmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmed]);

  const [menu, setOpen] = useState(false);
  const open = menu && status === "ready";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const check = async () => {
    setConfirmed(false);
    await checkNow();
    setConfirmed(useUpdaterStore.getState().status === "idle");
  };

  const short = version ? shortVersion(version) : "";
  const line = updateLine(status, lastChecked);

  switch (status) {
    case "downloading":
      return (
        <button
          className="tb upd-btn upd-dl"
          data-tip={`Downloading dawg ${version} · ${progress}%`}
          data-tip-rich="update"
          aria-label={`Downloading update to ${short}, ${progress}%`}
        >
          <ProgressIcon progress={progress} />
        </button>
      );
    case "ready":
      return (
        <div className="menu-wrap upd-wrap" ref={ref}>
          <button
            className={`tb upd-btn upd-ready${open ? " open" : ""}`}
            data-tip={open ? undefined : `dawg ${version} is downloaded. Click to restart and install.`}
            data-tip-rich={open ? undefined : "update"}
            aria-label={`Update to ${short} ready`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ReadyIcon />
          </button>
          {open && (
            <Menu className="upd-menu">
              <UpdateDetails
                foot={
                  <div className="upd-actions">
                    <Button variant="ghost" small onClick={() => setOpen(false)}>
                      Later
                    </Button>
                    <Button
                      variant="primary"
                      small
                      role="menuitem"
                      autoFocus
                      onClick={() => {
                        setOpen(false);
                        void restart();
                      }}
                    >
                      Restart now
                    </Button>
                  </div>
                }
              />
            </Menu>
          )}
        </div>
      );
    case "restarting":
      return (
        <button className="tb upd-btn upd-ready" disabled data-tip="Restarting…" aria-label="Restarting">
          <SpinnerIcon />
        </button>
      );
    case "error":
      return (
        <button
          className="tb upd-btn upd-error"
          data-tip={`Update check failed: ${error}\nClick to try again.`}
          aria-label="Update check failed, click to try again"
          onClick={() => void check()}
        >
          <WarnIcon />
        </button>
      );
    case "checking":
      return (
        <button className="tb upd-btn upd-busy" disabled data-tip="Checking for updates…" aria-label="Checking for updates">
          <SpinnerIcon />
        </button>
      );
    default: {
      const upToDate = status === "idle" && lastChecked !== null;
      return (
        <button
          className={`tb upd-btn${confirmed ? " upd-ok" : ""}`}
          disabled={status === "disabled"}
          data-tip={status === "disabled" ? line : `${line}. Click to check for updates.`}
          aria-label="Check for updates"
          onClick={() => void check()}
        >
          {upToDate ? <CheckIcon /> : <DownloadIcon />}
        </button>
      );
    }
  }
}
