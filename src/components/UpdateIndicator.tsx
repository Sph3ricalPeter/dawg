import { useEffect, useState } from "react";
import { updateLine, useUpdaterStore } from "@/stores/updater-store";

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
        <span className="upd faint" title={`Downloading dawg ${version}`}>
          Updating {progress}%
        </span>
      );
    case "ready":
      return (
        <button
          className="upd upd-ready"
          title={`dawg ${version} is downloaded. Restart to use it.${notes ? `\n\n${notes}` : ""}`}
          onClick={() => void restart()}
        >
          <span className="dot" />
          Restart to update
        </button>
      );
    case "restarting":
      return <span className="upd faint">Restarting…</span>;
    case "error":
      return (
        <button
          className="tb upd-btn upd-error"
          title={`Update check failed: ${error}\nClick to try again.`}
          aria-label="Update check failed, click to try again"
          onClick={() => void check()}
        >
          <WarnIcon />
        </button>
      );
    case "checking":
      return (
        <button className="tb upd-btn" disabled title="Checking for updates…" aria-label="Checking for updates">
          <SpinnerIcon />
        </button>
      );
    default: {
      const line = updateLine(status, lastChecked);
      return (
        <button
          className="tb upd-btn"
          disabled={status === "disabled"}
          title={status === "disabled" ? line : `${line}. Click to check for updates.`}
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
