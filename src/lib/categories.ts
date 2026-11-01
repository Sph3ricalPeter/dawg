import { TYPE_LABELS, type Label } from "@/lib/labels";

/**
 * Track categories: what a row holds (Drums, Bass, FX…). A category gives a
 * track its colour (unless one was picked) and an icon, and names a track
 * still called "Track N" after it. A track takes one once, from the first
 * dropped file with a Browser Type label, while it has none
 * (`design/track-categories.md`).
 *
 * Mirrors `dawg_core::category::CATEGORIES`: same ids, names and palette
 * indexes, in the same order. The icons and which labels suggest each one
 * live only here.
 */
export interface Category {
  id: string;
  name: string;
  /** Index into the clip palette (`COLORS` in `lib/timeline.ts`). */
  color: number;
  /** A key of `LABEL_ICONS`. */
  icon: string;
  /** The Type label ids that suggest it. */
  labels: string[];
}

const c = (id: string, name: string, color: number, icon: string, labels: string[]): Category => ({ id, name, color, icon, labels });

export const CATEGORIES: readonly Category[] = [
  c("drums", "Drums", 0, "kick", ["kick", "snare", "hat"]),
  c("perc", "Perc", 1, "perc", ["perc"]),
  c("bass", "Bass", 3, "bass", ["bass"]),
  c("leads", "Leads", 5, "lead", ["lead"]),
  c("pads", "Pads", 4, "pad", ["pad"]),
  c("vox", "Vox", 2, "voice", ["vox"]),
  c("fx", "FX", 6, "fx", ["fx", "riser", "impact", "whoosh"]),
  c("foley", "Foley", 7, "footstep", ["footstep", "foley"]),
  c("ambience", "Ambience", 3, "ambience", ["ambience"]),
  c("music", "Music", 5, "music", ["music"]),
  c("ui", "UI", 4, "ui", ["ui"]),
];

export function categoryById(id: string | null | undefined): Category | undefined {
  return id ? CATEGORIES.find((k) => k.id === id) : undefined;
}

/** The category a file's labels suggest: its first Type label in the
 * picker's order that maps to one, else null. */
export function categoryOfLabels(labels: readonly Label[]): string | null {
  const has = new Set(labels.map((l) => l.id));
  for (const t of TYPE_LABELS) {
    if (!has.has(t.id)) continue;
    const k = CATEGORIES.find((k) => k.labels.includes(t.id));
    if (k) return k.id;
  }
  return null;
}
