import { create } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { useSession } from "@/stores/session-store";

/** What the app last heard from an agent (`dawg-cli mcp`). */
interface AgentStore {
  /** The last tool call; null until an agent connects. */
  last: { tool: string; at: number; error: string | null } | null;
  /** An agent called within the last couple of seconds. */
  busy: boolean;
}

export const useAgent = create<AgentStore>(() => ({ last: null, busy: false }));

interface Call {
  tool: string;
  changed: boolean;
  opened: boolean;
  error: string | null;
}

let idle = 0;

/** Follows agent calls: fetches the session they changed, flags the AI
 * chip busy, and mirrors the selection back so `get_selection` sees it.
 * Returns the cleanup. */
export function followAgent(): () => void {
  if (!isTauri()) return () => {};
  const unlisten = listen<Call>("agent-call", (e) => {
    const c = e.payload;
    useAgent.setState({ last: { tool: c.tool, at: Date.now(), error: c.error }, busy: true });
    window.clearTimeout(idle);
    idle = window.setTimeout(() => useAgent.setState({ busy: false }), 2000);
    if (!c.changed) return;
    void api.sessionState().then((s) => {
      if (!s) return;
      const store = useSession.getState();
      const before = store.session?.history.length ?? 0;
      if (c.opened) store.opened(s);
      else store.adopt(s);
      const last = s.history.at(-1);
      if (!c.opened && last && s.history.length > before) store.showToast(`${last.label}`);
    });
  });
  let sent = "";
  const send = () => {
    const { selected, range } = useSession.getState();
    const r: [number, number] | null = range ? [Math.round(Math.min(range.a, range.b)), Math.round(Math.max(range.a, range.b))] : null;
    const key = JSON.stringify([selected, r]);
    if (key === sent) return;
    sent = key;
    void api.setSelection(selected, r).catch(() => {});
  };
  send();
  const unsub = useSession.subscribe((s, prev) => {
    if (s.selected !== prev.selected || s.range !== prev.range) send();
  });
  return () => {
    unsub();
    void unlisten.then((f) => f());
  };
}
