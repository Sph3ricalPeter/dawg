import { useEffect, useState } from "react";
import { shortVersion, updateLine, useUpdaterStore } from "@/stores/updater-store";
import { registerRichTip } from "@/lib/rich-tips";

const DownloadIcon = () => (
  <svg viewBox="0 0 16 16">
    <path d="M8 2.5V10M5 7.2 8 10.1l3-2.9M2.5 10.5v3h11v-3" />
  </svg>
);

const SpinnerIcon = () => (
  <svg viewBox="0 0 16 16" className="spin">
    <path d="M8 2a6 6 0 1 0 6 6" />
  </svg>
);

const WarnIcon = () => (
  <svg viewBox="0 0 16 16">
    <path d="M8 2 1.5 13.5h13zM8 6.5v3.5M8 11.5v.5" />
  </svg>
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

/** The tooltip on "Restart to update": current → new, the commit or release
 * notes, and when it was published. */
function UpdateTip() {
  const version = useUpdaterStore((s) => s.pendingVersion);
  const current = useUpdaterStore((s) => s.currentVersion);
  const notes = useUpdaterStore((s) => s.releaseNotes);
  const commit = useUpdaterStore((s) => s.pendingCommit);
  const date = useUpdaterStore((s) => s.pendingDate);
  if (!version) return null;
  const published = when(date);
  const { lines, more } = noteLines(notes ?? "");
  return (
    <div className="updtip">
      <div className="updtip-head">
        Update ready{published && <span className="faint"> · {published}</span>}
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
      <div className="updtip-foot faint">Click to restart and install.</div>
    </div>
  );
}

registerRichTip("update", <UpdateTip />);

/**
 * Title-bar updater button, always visible so a check is one click away.
 * Idle: click checks now. Checking: spinner. Downloading: progress.
 * Ready: "Restart to update". Error: warning, click retries.
 */
export function UpdateIndicator() {
  const status = useUpdaterStore((s) => s.status);
  const version = useUpdaterStore((s) => s.pendingVersion);
  const notes = useUpdaterStore((s) => s.releaseNotes);
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

  const check = async () => {
    setConfirmed(false);
    await checkNow();
    setConfirmed(useUpdaterStore.getState().status === "idle");
  };

  switch (status) {
    case "downloading":
      return (
        <span className="upd faint" data-tip={`Downloading dawg ${version}`}>
          Updating{version && ` to ${shortVersion(version)}`} {progress}%
        </span>
      );
    case "ready":
      return (
        <button
          className="upd upd-ready"
          data-tip={`dawg ${version} is downloaded. Restart to use it.${notes ? `\n\n${notes}` : ""}`}
          data-tip-rich="update"
          aria-label={`Restart to update to dawg ${version}`}
          onClick={() => void restart()}
        >
          <span className="dot" />
          Restart to update
          {version && <span className="upd-ver">{shortVersion(version)}</span>}
        </button>
      );
    case "restarting":
      return <span className="upd faint">Restarting…</span>;
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
        <button className="tb upd-btn" disabled data-tip="Checking for updates…" aria-label="Checking for updates">
          <SpinnerIcon />
        </button>
      );
    default: {
      const line = updateLine(status, lastChecked);
      return (
        <button
          className="tb upd-btn"
          disabled={status === "disabled"}
          data-tip={status === "disabled" ? line : `${line}. Click to check for updates.`}
          aria-label="Check for updates"
          onClick={() => void check()}
        >
          <DownloadIcon />
          {confirmed && <span className="faint">Up to date</span>}
        </button>
      );
    }
  }
}
