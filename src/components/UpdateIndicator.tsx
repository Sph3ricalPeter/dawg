import { useUpdaterStore } from "@/stores/updater-store";

/** Title-bar slot: quiet while checking or downloading, a button once ready. */
export function UpdateIndicator() {
  const status = useUpdaterStore((s) => s.status);
  const version = useUpdaterStore((s) => s.pendingVersion);
  const progress = useUpdaterStore((s) => s.downloadProgress);
  const error = useUpdaterStore((s) => s.error);
  const restart = useUpdaterStore((s) => s.restart);
  const dismissError = useUpdaterStore((s) => s.dismissError);

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
          title={`dawg ${version} is downloaded. Restart to use it.`}
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
          className="upd upd-error"
          title={`Update failed: ${error}\nClick to dismiss.`}
          onClick={dismissError}
        >
          Update failed
        </button>
      );
    default:
      return null;
  }
}
