/**
 * The Browser's labels: built-in ones in four groups, plus the user's own in
 * "Custom". Each has a name, a group, a colour from the clip palette and an
 * icon, so a row can show them as small coloured icons.
 *
 * A label's `id` is stable: built-ins use fixed ids ("kick", "loop"), custom
 * ones a generated "c-…" id, so renaming never loses a file's labels. Track
 * categories build on the Type labels (design/track-categories.md): read
 * them with `labelById` and `TYPE_LABELS`.
 */

export const LABEL_GROUPS = ["Type", "Shape", "Character", "Status", "Custom"] as const;
export type LabelGroup = (typeof LABEL_GROUPS)[number];

export interface Label {
  id: string;
  name: string;
  group: LabelGroup;
  /** CSS colour, from `LABEL_COLORS` for custom labels. */
  color: string;
  /** A key of `LABEL_ICONS`. */
  icon: string;
}

/** The clip palette (`COLORS` in `lib/timeline.ts`, which can't be imported
 * here: this module loads before the stores). Custom labels pick from it. */
export const LABEL_COLORS = ["#ee9f98", "#f5c55c", "#c3dd76", "#7dd6c4", "#9ec8ea", "#f0a8cf", "#b9c2cf", "#dcc89f"];

/** 12×12 stroke icons (path data inside `<svg viewBox="0 0 12 12">`). */
export const LABEL_ICONS: Record<string, string> = {
  kick: '<circle cx="6" cy="6" r="4.6"/><circle cx="6" cy="6" r="1.5"/>',
  snare: '<ellipse cx="6" cy="4" rx="4.6" ry="1.6"/><path d="M1.4 4v4c0 .9 2.1 1.6 4.6 1.6s4.6-.7 4.6-1.6V4"/>',
  hat: '<path d="M1 6.2h10M6 6.2V11M2.8 6.2C3.3 4.7 4.5 4 6 4s2.7.7 3.2 2.2M6 1v3"/>',
  perc: '<path d="M2 10.4 8.4 4M10 10.4 3.6 4"/><circle cx="9.1" cy="3.2" r="1.1"/><circle cx="2.9" cy="3.2" r="1.1"/>',
  bass: '<path d="M1 6c1.2-3.8 3.8-3.8 5 0s3.8 3.8 5 0"/>',
  lead: '<path d="M1 9.4 4.3 2.6v6.8l3.4-6.8v6.8L11 2.6"/>',
  pad: '<path d="M1 4c2.5-2 7.5-2 10 0M1 7c2.5-2 7.5-2 10 0M1 10c2.5-2 7.5-2 10 0"/>',
  voice: '<rect x="4.2" y="1.2" width="3.6" height="6" rx="1.8"/><path d="M2.4 5.8a3.6 3.6 0 0 0 7.2 0M6 9.4V11"/>',
  fx: '<path d="M6 1.2 7.1 4.9 10.8 6 7.1 7.1 6 10.8 4.9 7.1 1.2 6 4.9 4.9z"/>',
  riser: '<path d="M1 10.5h3.2L10 2.5M7.4 2.5H10v2.6"/>',
  impact: '<path d="M6 1v2.3M6 8.7V11M1 6h2.3M8.7 6H11M2.6 2.6l1.6 1.6M7.8 7.8l1.6 1.6M9.4 2.6 7.8 4.2M4.2 7.8 2.6 9.4"/>',
  whoosh: '<path d="M1 4.2h6.3A1.6 1.6 0 1 0 5.8 2.6M1 7h8.2a1.6 1.6 0 1 1-1.6 1.6M1 9.8h3.6"/>',
  footstep: '<ellipse cx="4" cy="3.8" rx="1.7" ry="2.5"/><ellipse cx="8" cy="8" rx="1.7" ry="2.5"/>',
  foley: '<path d="M1.2 8.8 3 3.2l2.2 5.3L7 1.8l1.5 7.4 2.3-4.6"/>',
  ambience: '<path d="M6 11V7.5M6 1.4 2.4 7.5h7.2z"/>',
  music: '<path d="M4.6 9.4V2.6l5-1.2v6.6"/><circle cx="3.2" cy="9.4" r="1.4"/><circle cx="8.2" cy="8" r="1.4"/>',
  ui: '<path d="M2.6 1.4v8.2l2.2-2 1.5 3.3 1.5-.7-1.5-3.2h3z"/>',
  oneshot: '<path d="M1 9h2.4L5 2l1.6 7H11"/>',
  loop: '<path d="M9.6 5.2A3.6 3.6 0 1 0 9 8.4"/><path d="M9.8 2.6v2.8H7"/>',
  bright: '<circle cx="6" cy="6" r="2.2"/><path d="M6 1v1.3M6 9.7V11M1 6h1.3M9.7 6H11M2.5 2.5l.9.9M8.6 8.6l.9.9M9.5 2.5l-.9.9M3.4 8.6l-.9.9"/>',
  dark: '<path d="M9.8 7.8A4.3 4.3 0 0 1 4.2 2.2a4.3 4.3 0 1 0 5.6 5.6z"/>',
  punchy: '<path d="M7 1 2.6 6.8H6L5 11l4.4-5.8H6z"/>',
  soft: '<path d="M3.4 9.4a2.2 2.2 0 0 1-.3-4.4 3 3 0 0 1 5.7-.6 2.5 2.5 0 0 1 .3 5z"/>',
  metallic: '<path d="M6 1.2l4.2 2.4v4.8L6 10.8 1.8 8.4V3.6z"/><circle cx="6" cy="6" r="1.5"/>',
  final: '<circle cx="6" cy="6" r="4.6"/><path d="m3.9 6.2 1.5 1.5 2.8-3"/>',
  wip: '<circle cx="6" cy="6" r="4.6"/><path d="M6 1.4v9.2a4.6 4.6 0 0 0 0-9.2z" fill="currentColor"/>',
  fix: '<path d="M6 1.4 11 10.2H1z"/><path d="M6 4.8v2.6M6 8.9v.1"/>',
  plus: '<circle cx="6" cy="6" r="4.6"/><path d="M6 3.8v4.4M3.8 6h4.4"/>',
  minus: '<circle cx="6" cy="6" r="4.6"/><path d="M3.8 6h4.4"/>',
  skull:
    '<path d="M2.4 6.4a3.6 3.6 0 1 1 7.2 0V8H8.2v2.2H3.8V8H2.4z"/><circle cx="4.6" cy="6.1" r=".8" fill="currentColor"/><circle cx="7.4" cy="6.1" r=".8" fill="currentColor"/>',
  heart: '<path d="M6 10.2S1.4 7.4 1.4 4.4A2.4 2.4 0 0 1 6 3.2a2.4 2.4 0 0 1 4.6 1.2c0 3-4.6 5.8-4.6 5.8z"/>',
  flag: '<path d="M2.4 11V1.6M2.4 2h7l-1.6 2.6 1.6 2.6h-7"/>',
  coin: '<circle cx="6" cy="6" r="4.6"/><circle cx="6" cy="6" r="2.4"/>',
  door: '<path d="M2.6 11V1.4h6.8V11M1.4 11h9.2"/><circle cx="7.4" cy="6.4" r=".6" fill="currentColor"/>',
  water: '<path d="M6 1.4S2.6 5.4 2.6 7.6a3.4 3.4 0 0 0 6.8 0C9.4 5.4 6 1.4 6 1.4z"/>',
  fire: '<path d="M6 11c-2 0-3.4-1.4-3.4-3.3 0-1.8 1.3-2.7 2-4.2.3 1 .9 1.6 1.5 1.8C6.4 3.6 7 2.2 8 1.2c.4 2.3 1.4 3.5 1.4 6.5C9.4 9.6 8 11 6 11z"/>',
};

/** The icon a label shows when its own is unknown (a newer version's). */
export const FALLBACK_ICON = "flag";

const P = LABEL_COLORS;
const b = (id: string, name: string, group: LabelGroup, color: string, icon = id): Label => ({ id, name, group, color, icon });

/** The built-in labels, in the order the picker lists them. */
export const BUILTIN_LABELS: readonly Label[] = [
  b("kick", "Kick", "Type", P[0]),
  b("snare", "Snare", "Type", P[1]),
  b("hat", "Hat", "Type", P[2]),
  b("perc", "Perc", "Type", P[1]),
  b("bass", "Bass", "Type", P[3]),
  b("lead", "Lead", "Type", P[5]),
  b("pad", "Pad", "Type", P[4]),
  b("vox", "Vox", "Type", P[2], "voice"),
  b("fx", "FX", "Type", P[6]),
  b("riser", "Riser", "Type", P[5]),
  b("impact", "Impact", "Type", P[0]),
  b("whoosh", "Whoosh", "Type", P[4]),
  b("footstep", "Footstep", "Type", P[7]),
  b("foley", "Foley", "Type", P[6]),
  b("ambience", "Ambience", "Type", P[3]),
  b("music", "Music", "Type", P[5]),
  b("ui", "UI", "Type", P[4]),
  b("oneshot", "One-shot", "Shape", P[6]),
  b("loop", "Loop", "Shape", P[3]),
  b("bright", "Bright", "Character", P[1]),
  b("dark", "Dark", "Character", P[6]),
  b("punchy", "Punchy", "Character", P[1]),
  b("soft", "Soft", "Character", P[4]),
  b("metallic", "Metallic", "Character", P[7]),
  b("final", "Final", "Status", "#3fd46a"),
  b("wip", "WIP", "Status", "#ffd23f"),
  b("needsfix", "Needs fix", "Status", "#ff4d4d", "fix"),
];

export const TYPE_LABELS = BUILTIN_LABELS.filter((l) => l.group === "Type");

const BUILTIN_BY_ID = new Map(BUILTIN_LABELS.map((l) => [l.id, l]));

export function isBuiltin(id: string): boolean {
  return BUILTIN_BY_ID.has(id);
}

export function builtinLabel(id: string): Label | undefined {
  return BUILTIN_BY_ID.get(id);
}

/** What a search token like "#ui" or "#boss" names: an exact name first,
 * then the first name that starts with it. Spaces and case don't count. */
export function findLabel(labels: readonly Label[], token: string): Label | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const t = norm(token);
  if (!t) return undefined;
  return labels.find((l) => norm(l.name) === t || l.id === t) ?? labels.find((l) => norm(l.name).startsWith(t));
}

/** A search box query split into words and filters: `#label` tokens and ★. */
export interface ParsedQuery {
  /** The words to match names against, joined by spaces ("" for none). */
  words: string;
  /** Label tokens, without the "#". */
  labels: string[];
  fav: boolean;
}

export function parseQuery(q: string): ParsedQuery {
  const words: string[] = [];
  const labels: string[] = [];
  let fav = false;
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    if (tok === "★" || tok === "*" || /^#(fav|favou?rites?|★)$/i.test(tok)) fav = true;
    else if (tok.startsWith("#")) {
      if (tok.length > 1) labels.push(tok.slice(1));
    } else words.push(tok.replace(/★/g, ""));
    if (tok !== "★" && tok.includes("★")) fav = true;
  }
  return { words: words.filter(Boolean).join(" "), labels, fav };
}
