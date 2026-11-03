import { useLayoutEffect, useRef, useState } from "react";
import { BUILTIN_LABELS, FALLBACK_ICON, LABEL_COLORS, LABEL_GROUPS, LABEL_ICONS, type Label } from "@/lib/labels";
import { useBrowser, type PopupAt } from "@/stores/browser-store";
import { below } from "@/lib/popup";
import { labelCounts, useFileLibrary, useLibrary } from "@/stores/library-store";
import { useDismiss } from "@/ui/dismiss";
import { MenuItem, MenuLabel, MenuNote, MenuSep } from "@/ui/Menu";
import { CloseButton } from "@/ui/Button";

/** A label's icon: 12×12 strokes in the label's colour (or the text colour). */
export function LabelIcon({ icon, color }: { icon: string; color?: string }) {
  return (
    <span className="li" style={color ? { color } : undefined}>
      <svg viewBox="0 0 12 12" aria-hidden="true" dangerouslySetInnerHTML={{ __html: LABEL_ICONS[icon] ?? LABEL_ICONS[FALLBACK_ICON] }} />
    </span>
  );
}

function LabelChip({ label, children }: { label: Label; children?: React.ReactNode }) {
  return (
    <span className="chip">
      <LabelIcon icon={label.icon} color={label.color} />
      {label.name}
      {children}
    </span>
  );
}

/** Keeps a fixed popup inside the window: placed at `at`, moved left or up
 * when it would run off an edge. A submenu that doesn't fit on the right
 * opens to the left of `flip` (its parent menu's left edge) instead. */
function usePlace(ref: React.RefObject<HTMLElement | null>, at: PopupAt, flip?: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = flip !== undefined && at.x + r.width > window.innerWidth - 4 ? flip - r.width : at.x;
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4))}px`;
  });
}

/** The favourite star at the end of a file row: filled when starred, an
 * empty one on hover (or on the current row) otherwise. */
export function FavStar({ path, fav }: { path: string; fav: boolean }) {
  return (
    <button
      className={`fav${fav ? "" : " off"}`}
      aria-label={fav ? "Remove from favourites" : "Add to favourites"}
      data-tip={fav ? "Favourite · click to remove (F)" : "Add to favourites (F)"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        useLibrary.getState().toggleFav(path);
      }}
    >
      {fav ? "★" : "☆"}
    </button>
  );
}

/** The current file's favourite and labels, under the preview. */
export function FileMeta({ path }: { path: string }) {
  const { labels, fav } = useFileLibrary(path);
  const lib = useLibrary.getState;
  return (
    <div className="bmeta">
      <div className="r1">
        <button className={`favbig${fav ? " on" : ""}`} onClick={() => lib().toggleFav(path)} data-tip="Favourite (F)">
          {fav ? "★ Favourite" : "☆ Add to favourites"}
        </button>
        <span className="k">F</span>
      </div>
      <div className="chips">
        {labels.map((l) => (
          <LabelChip key={l.id} label={l}>
            <CloseButton size="sm" aria-label={`Remove ${l.name}`} onClick={() => lib().toggleLabel(path, l.id)} />
          </LabelChip>
        ))}
        <button
          className="chip add"
          data-addlabel=""
          onClick={(e) => useBrowser.getState().openPicker(path, below(e.currentTarget))}
          data-tip="Add or remove labels (L)"
        >
          + Label
        </button>
      </div>
    </div>
  );
}

const norm = (s: string) => s.trim().toLowerCase();

/** The label picker: every label by group, ticked when the file has it,
 * with a search box that also makes a new custom label. */
export function LabelPicker() {
  const picker = useBrowser((s) => s.picker);
  if (!picker) return null;
  return <Picker key={`${picker.path}|${picker.x}|${picker.y}`} path={picker.path} at={picker} />;
}

/** The label picker as a submenu of a file's right-click menu, opening to
 * the right of its "Labels" item. It lives inside that menu, which closes it. */
export function LabelSubmenu({ path, at, flip, close }: { path: string; at: PopupAt; flip: number; close: () => void }) {
  return <Picker path={path} at={at} sub={{ flip, close }} />;
}

function Picker({ path, at, sub }: { path: string; at: PopupAt; sub?: { flip: number; close: () => void } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const custom = useLibrary((s) => s.custom);
  const { labels: has } = useFileLibrary(path);
  const br = useBrowser.getState;
  const lib = useLibrary.getState;
  usePlace(ref, at, sub?.flip);
  useDismiss(!sub, ref, () => br().closePopups(), true);
  const all = lib().all();
  const shown = all.filter((l) => norm(l.name).includes(norm(q)));
  const exact = all.find((l) => norm(l.name) === norm(q));
  const close = () => (sub ? sub.close() : br().closePopups());
  const create = () => {
    close();
    br().openLabelDialog({ path, name: q.trim(), x: at.x, y: at.y });
  };
  return (
    <div className={`menu lpick${sub ? " sub" : ""}`} role="menu" ref={ref} aria-label="Labels">
      <div className="lpq">
        <input
          autoFocus
          value={q}
          placeholder="Find or create a label"
          aria-label="Find or create a label"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
            if (e.key !== "Enter") return;
            const pickIt = exact ?? (shown.length === 1 ? shown[0] : null);
            if (pickIt) {
              lib().toggleLabel(path, pickIt.id);
              setQ("");
            } else if (q.trim()) create();
          }}
        />
      </div>
      {LABEL_GROUPS.map((g) => {
        const ls = shown.filter((l) => l.group === g);
        if (!ls.length) return null;
        return (
          <div key={g}>
            <MenuLabel>{g}</MenuLabel>
            {ls.map((l) => {
              const on = has.some((h) => h.id === l.id);
              return (
                <MenuItem
                  key={l.id}
                  checked={on}
                  keep
                  label={
                    <>
                      <LabelIcon icon={l.icon} color={l.color} />
                      {l.name}
                    </>
                  }
                  run={() => lib().toggleLabel(path, l.id)}
                  onContextMenu={(e) => {
                    if (l.group !== "Custom") return;
                    e.preventDefault();
                    close();
                    br().openLabelDialog({ edit: l.id, x: e.clientX, y: e.clientY });
                  }}
                />
              );
            })}
          </div>
        );
      })}
      {!shown.length && <MenuNote>No label by that name</MenuNote>}
      <MenuSep />
      {!exact && (
        <button className="menu-item new" onClick={create}>
          {q.trim() ? `+ Create "${q.trim()}"` : "+ New custom label…"}
        </button>
      )}
      {custom.length > 0 && !q && <MenuNote>Right-click a custom label to edit it</MenuNote>}
    </div>
  );
}

/** Making a custom label (name, icon, colour), or editing one. */
export function LabelDialogView() {
  const d = useBrowser((s) => s.labelDialog);
  if (!d) return null;
  return <LabelEditor key={`${d.edit}|${d.path}|${d.x}|${d.y}`} />;
}

function LabelEditor() {
  const d = useBrowser((s) => s.labelDialog)!;
  const custom = useLibrary((s) => s.custom);
  const files = useLibrary((s) => s.files);
  const editing = d.edit ? custom.find((l) => l.id === d.edit) : undefined;
  const [name, setName] = useState(editing?.name ?? d.name);
  const [icon, setIcon] = useState(editing?.icon ?? "flag");
  const [color, setColor] = useState(editing?.color ?? LABEL_COLORS[(custom.length + 5) % LABEL_COLORS.length]);
  const [sure, setSure] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const br = useBrowser.getState;
  const lib = useLibrary.getState;
  usePlace(ref, d);
  useDismiss(true, ref, () => br().closePopups(), true);
  const clash = lib()
    .all()
    .find((l) => l.id !== editing?.id && norm(l.name) === norm(name));
  const ok = !!name.trim() && !clash;
  const used = editing ? (labelCounts(files).get(editing.id) ?? 0) : 0;
  const done = () => {
    if (!ok) return;
    if (editing) lib().editLabel(editing.id, { name, icon, color });
    else {
      const id = lib().createLabel({ name, icon, color });
      if (d.path && !lib().entry(d.path)?.labels.includes(id)) lib().toggleLabel(d.path, id);
    }
    br().closePopups();
  };
  return (
    <div className="menu newl" ref={ref} role="dialog" aria-label={editing ? "Edit label" : "New label"}>
      <div className="menu-head">
        <b>{editing ? "Edit label" : "New label"}</b>
      </div>
      <div className="row">
        <input
          className="nname"
          autoFocus
          value={name}
          placeholder="Label name"
          aria-label="Label name"
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") done();
            if (e.key === "Escape") br().closePopups();
          }}
        />
        {clash && <span className="warnx">There's already a label called {clash.name}</span>}
      </div>
      <div className="row">
        <span className="lab">Icon</span>
        <div className="icons">
          {Object.keys(LABEL_ICONS).map((k) => (
            <button key={k} className={icon === k ? "on" : ""} aria-label={k} onClick={() => setIcon(k)}>
              <LabelIcon icon={k} color={icon === k ? color : undefined} />
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span className="lab">Colour</span>
        <div className="cols">
          {LABEL_COLORS.map((c) => (
            <button key={c} className={color === c ? "on" : ""} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <div className="row prev">
        Looks like <LabelChip label={{ id: "", group: "Custom", name: name.trim() || "Label", icon, color }} />
      </div>
      <div className="acts">
        {editing && (
          <button
            className={`del${sure ? " sure" : ""}`}
            onClick={() => {
              if (!sure && used > 0) {
                setSure(true);
                return;
              }
              lib().deleteLabel(editing.id);
              if (br().filters.includes(editing.id)) br().toggleFilter(editing.id);
              br().closePopups();
            }}
            data-tip={used ? `Takes it off ${used} file${used === 1 ? "" : "s"}` : undefined}
          >
            {sure ? `Delete from ${used} file${used === 1 ? "" : "s"}?` : "Delete"}
          </button>
        )}
        <span className="sp" />
        <button onClick={() => br().closePopups()}>Cancel</button>
        <button className="pri" disabled={!ok} onClick={done}>
          {editing ? "Save" : "Create"}
        </button>
      </div>
    </div>
  );
}

/** The Labels section's header button: edit or delete custom labels. */
export function ManageLabels() {
  const [at, setAt] = useState<PopupAt | null>(null);
  return (
    <>
      <button
        className="bsx tb"
        data-tip="Manage labels"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setAt(at ? null : below(e.currentTarget));
        }}
      >
        Edit
      </button>
      {at && <ManageMenu at={at} close={() => setAt(null)} />}
    </>
  );
}

function ManageMenu({ at, close }: { at: PopupAt; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const custom = useLibrary((s) => s.custom);
  const files = useLibrary((s) => s.files);
  const counts = labelCounts(files);
  usePlace(ref, at);
  useDismiss(true, ref, close, true);
  const br = useBrowser.getState;
  return (
    <div className="menu lpick" role="menu" ref={ref} aria-label="Manage labels" onPointerDown={(e) => e.stopPropagation()}>
      <MenuLabel>Custom labels</MenuLabel>
      {custom.map((l) => (
        <MenuItem
          key={l.id}
          label={
            <>
              <LabelIcon icon={l.icon} color={l.color} />
              {l.name}
            </>
          }
          keys={String(counts.get(l.id) ?? 0)}
          run={() => br().openLabelDialog({ edit: l.id, x: at.x, y: at.y })}
          close={close}
        />
      ))}
      {!custom.length && <MenuNote>None yet. Built-in labels can't be changed.</MenuNote>}
      <MenuSep />
      <button
        className="menu-item new"
        onClick={() => {
          close();
          br().openLabelDialog({ x: at.x, y: at.y });
        }}
      >
        + New custom label…
      </button>
    </div>
  );
}

/** How many labels the Labels section shows before "+N more". */
const TOP = 8;

/** The Labels section: the labels in use, most used first; click one to
 * show only its files. Filters stack with each other, ★ and search. */
export function LabelCloud() {
  const files = useLibrary((s) => s.files);
  const custom = useLibrary((s) => s.custom);
  const filters = useBrowser((s) => s.filters);
  const current = useBrowser((s) => s.current);
  const [all, setAll] = useState(false);
  const br = useBrowser.getState;
  const counts = labelCounts(files);
  const used = [...BUILTIN_LABELS, ...custom].filter((l) => counts.get(l.id));
  const top = [...used].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)).slice(0, TOP);
  const shown = all ? used : used.filter((l) => top.includes(l) || filters.includes(l.id));
  return (
    <div className="lcloud">
      {shown.map((l) => (
        <button
          key={l.id}
          className={`chip lc${filters.includes(l.id) ? " flt" : ""}`}
          onClick={() => br().toggleFilter(l.id)}
          onContextMenu={(e) => {
            if (l.group !== "Custom") return;
            e.preventDefault();
            br().openLabelDialog({ edit: l.id, x: e.clientX, y: e.clientY });
          }}
          data-tip={`${l.group} · click to show only ${l.name}${l.group === "Custom" ? " · right-click to edit" : ""}`}
        >
          <LabelIcon icon={l.icon} color={l.color} />
          {l.name}
          <span className="n">{counts.get(l.id)}</span>
        </button>
      ))}
      {used.length > shown.length ? (
        <button className="chip add" onClick={() => setAll(true)}>
          +{used.length - shown.length} more
        </button>
      ) : (
        all &&
        used.length > TOP && (
          <button className="chip add" onClick={() => setAll(false)}>
            Fewer
          </button>
        )
      )}
      {!used.length && <span className="lnote">Label files to find them here: right-click a file, or press L</span>}
      <button
        className="chip add"
        onClick={(e) => br().openLabelDialog({ path: current, ...below(e.currentTarget) })}
        data-tip={current ? "Make a custom label, for the file in the preview" : "Make a custom label"}
      >
        + New
      </button>
    </div>
  );
}
