import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AppInfo {
  version: string;
  coreVersion: string;
  /** "release" for the installed app, "dev" for "dawg dev" and `tauri dev`. */
  channel: "release" | "dev";
  updatesEnabled: boolean;
}

/** Fallback when the UI runs in a plain browser (`npm run dev` without Tauri). */
const BROWSER_INFO: AppInfo = {
  version: "0.0.0",
  coreVersion: "0.0.0",
  channel: "dev",
  updatesEnabled: false,
};

export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauri()) return BROWSER_INFO;
  return invoke<AppInfo>("app_info");
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
