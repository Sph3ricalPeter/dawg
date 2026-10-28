import { useEffect, useState } from "react";
import { TitleBar } from "@/components/TitleBar";
import { getAppInfo, type AppInfo } from "@/lib/app-info";
import { CHECK_INTERVAL_MS, useUpdaterStore } from "@/stores/updater-store";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    void getAppInfo().then((info) => {
      setInfo(info);
      const updater = useUpdaterStore.getState();
      updater.init(info.updatesEnabled);
      if (!info.updatesEnabled) return;
      void updater.checkNow();
      timer = window.setInterval(() => void useUpdaterStore.getState().checkNow(), CHECK_INTERVAL_MS);
    });
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="app">
      <TitleBar info={info} />
      <main className="arrangement">
        <p className="empty faint">Empty project</p>
      </main>
    </div>
  );
}
