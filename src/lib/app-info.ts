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

/** What the dev badge says: the CI build number of a "dawg dev" build
 * ("0.0.1-dev.22" → "22"), or "local" for a build that never updates. */
export function devBuild(info: AppInfo): string {
  const run = /-dev\.(\d+)$/.exec(info.version)?.[1];
  return run && info.updatesEnabled ? run : "local";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
