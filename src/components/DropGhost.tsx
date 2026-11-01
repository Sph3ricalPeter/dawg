import { useEffect, useState } from "react";
import { api, type PreviewInfo } from "@/lib/api";
import { dropTarget, useDropHover } from "@/lib/drop";
import { fmtTime } from "@/lib/format";
import { fmtBars } from "@/lib/grid";
import { gridOf, useSession } from "@/stores/session-store";
import { baseName } from "@/stores/browser-store";

/** Most ghosts a multi-file drop shows; the rest still land. */
const MAX_GHOSTS = 8;
const BUCKETS = 400;

/** Each file's length and peaks, decoded once per path. */
const infos = new Map<string, Promise<PreviewInfo | null>>();
function infoOf(path: string): Promise<PreviewInfo | null> {
  let p = infos.get(path);
  if (!p) {
    p = api.previewInfo(path, BUCKETS).catch(() => null);
    infos.set(path, p);
  }
  return p;
}

/** The (max) peaks as a mirrored outline in a 0..n by -1..1 box. */
function wavePath(peaks: number[]): string {
  if (!peaks.length) return "";
  const top = Math.max(...peaks, 1e-6);
  const up = peaks.map((v, i) => `${i},${(-Math.min(1, v / top) * 0.9).toFixed(3)}`);
  const down = peaks.map((v, i) => `${i},${(Math.min(1, v / top) * 0.9).toFixed(3)}`).reverse();
  return `M${up.join("L")}L${down.join("L")}Z`;
}

/** While files are dragged over the playlist, ghost clips show where each
 * would land: on the snapped time, on the track under the pointer, or on
 * new tracks in the bottom row; as long as the file. */
export function DropGhost() {
  const hover = useDropHover((s) => s.hover);
  const session = useSession((s) => s.session);
  useSession((s) => s.view);
  const [loaded, setLoaded] = useState<Record<string, PreviewInfo | null>>({});

  const paths = hover?.paths.slice(0, MAX_GHOSTS) ?? [];
  const key = paths.join("\n");
  useEffect(() => {
    let live = true;
    for (const p of key ? key.split("\n") : []) {
      void infoOf(p).then((info) => {
        if (live) setLoaded((l) => (p in l ? l : { ...l, [p]: info }));
      });
    }
    return () => {
      live = false;
    };
  }, [key]);

  const t = hover ? dropTarget(hover.x, hover.y, hover.free) : null;
  // The lane under the pointer lights up, as in the mockup.
  const lane = t?.over ? t.lane : null;
  useEffect(() => {
    lane?.classList.add("dropping");
    return () => lane?.classList.remove("dropping");
  }, [lane]);

  if (!hover || !session || !t?.over || !t.lane) return null;
  const tracks = t.lane.closest<HTMLElement>(".tracks");
  if (!tracks) return null;
  const s = useSession.getState();
  // One file goes where it's dropped; several get a new track each, from
  // the bottom row down.
  const onTrack = hover.paths.length === 1 && t.track !== null;
  const row = onTrack ? t.lane : tracks.querySelector<HTMLElement>(".addlane");
  if (!row) return null;
  const box = tracks.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const clip = { left: r.left, top: box.top, width: box.right - r.left, height: box.height };
  const x = (t.start - s.view.start) / s.view.fpp;
  const rowH = onTrack ? r.height : Math.max(r.height, 44);
  const units = gridOf(s).units;
  const at = units === "bars" ? fmtBars(t.start, session.rate, session.bpm) : fmtTime(t.start / session.rate);
  return (
    <div className="dropghosts" style={clip}>
      {paths.map((p, i) => {
        const info = loaded[p];
        const frames = info ? info.seconds * session.rate : session.rate;
        const w = Math.max(2, frames / s.view.fpp);
        return (
          <div
            key={p}
            className={`dropghost${info ? "" : " loading"}`}
            style={{ left: x, top: r.top - box.top + i * rowH + 2, width: w, height: rowH - 5 }}
          >
            <div className="dg-t">
              {baseName(p)}
              {"  ·  "}
              {at}
              {info ? `  ·  ${info.seconds.toFixed(2)} s` : ""}
            </div>
            {info && info.peaks.length > 0 && (
              <svg viewBox={`0 -1 ${info.peaks.length} 2`} preserveAspectRatio="none">
                <path d={wavePath(info.peaks)} />
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}
