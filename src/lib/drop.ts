import { useSession } from "@/stores/session-store";

/** Where a file dropped at window point (x, y) lands: the lane's track (or
 * null for the "new track" lane) and the timeline frame under it. */
export function dropTarget(x: number, y: number): { track: number | null; start: number; over: boolean } {
  const s = useSession.getState();
  const el = document.elementFromPoint(x, y);
  const lane = el?.closest<HTMLElement>(".lane");
  if (!lane || !s.session) return { track: null, start: 0, over: false };
  const r = lane.getBoundingClientRect();
  const start = Math.max(0, Math.round(s.view.start + (x - r.left) * s.view.fpp));
  const track = lane.dataset.track ? Number(lane.dataset.track) : null;
  return { track, start, over: true };
}
