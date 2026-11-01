import { create } from "zustand";
import { snapStep, useSession } from "@/stores/session-store";
import { snapTo } from "@/lib/grid";

/** Where a file dropped at window point (x, y) lands: the lane's track (or
 * null for the "new track" lane) and the timeline frame under it, on the
 * snap grid unless `free` (Alt). `lane` is the lane element it's over. */
export function dropTarget(
  x: number,
  y: number,
  free = false,
): { track: number | null; start: number; over: boolean; lane: HTMLElement | null } {
  const s = useSession.getState();
  const el = document.elementFromPoint(x, y);
  // The ghost track's dashed box covers its header and lane; anywhere on
  // it means its lane, from the lane's left edge on.
  const lane =
    el?.closest<HTMLElement>(".lane") ?? el?.closest(".trow.add")?.querySelector<HTMLElement>(".addlane") ?? null;
  if (!lane || !s.session) return { track: null, start: 0, over: false, lane: null };
  const r = lane.getBoundingClientRect();
  const raw = s.view.start + Math.max(0, x - r.left) * s.view.fpp;
  const start = Math.max(0, Math.round(free ? raw : snapTo(raw, snapStep())));
  const track = lane.dataset.track ? Number(lane.dataset.track) : null;
  return { track, start, over: true, lane };
}

/** Files being dragged over the window, from the Browser or the OS, and
 * where the pointer is: the playlist shows them as ghost clips. */
export interface DropHover {
  paths: string[];
  x: number;
  y: number;
  /** Alt: off the snap grid. */
  free?: boolean;
}

export const useDropHover = create<{ hover: DropHover | null }>(() => ({ hover: null }));

export function setDropHover(hover: DropHover | null): void {
  useDropHover.setState({ hover });
}
