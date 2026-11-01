import type { HistoryEntry } from "./api";

/** One line for a step, as the Undo and Redo tooltips name it:
 * "Vocals › EQ › Band 2 Bell · Q 9.49 → 3.14". */
export function stepText(e: HistoryEntry | undefined): string | undefined {
  if (!e) return undefined;
  const where = e.place.join(" › ");
  const text = e.change ? `${where} · ${e.change}` : where;
  return e.kind === "ai" ? `AI: ${text}` : text;
}
