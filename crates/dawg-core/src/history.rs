//! What a history step changed, worked out by comparing the project before
//! and after it: where ("Vocals › EQ › Band 2 Bell") and how ("Q 9.49 →
//! 3.14"). Comparing states instead of reading the command means a drag, a
//! run of nudges and an agent's take are all described the same way, from
//! where they started to where they ended.

use std::collections::{BTreeMap, BTreeSet};

use crate::command::gain_to_db;
use crate::eq::{BandKind, EqBand};
use crate::model::{Clip, FadeCurve, Project, Track};

/// A history step as the History panel shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Detail {
    /// The icon: "eq", "volume", "pan", "mute", "solo", "fade", "move",
    /// "trim", "split", "add", "delete", "reverse", "stretch", "pitch",
    /// "envelope", "colour", "tempo", "rename", "ai" or "edit".
    pub kind: &'static str,
    /// Where the edit happened, outermost first: track, part, thing.
    pub place: Vec<String>,
    /// The values before and after, or what was added or removed.
    pub change: String,
    /// How many separate changes `change` sums up, when it is a summary.
    pub changes: usize,
}

/// One value that changed.
#[derive(Debug, Clone)]
struct Change {
    kind: &'static str,
    place: Vec<String>,
    /// Which value, for telling a nudge of the same value from another edit.
    field: &'static str,
    text: String,
    /// A continuous value (a level, a frequency, a position) that the wheel,
    /// arrow keys or repeated drags nudge, so a quick run of such edits can
    /// be one step. Toggles and structural edits are not.
    nudge: bool,
    /// `place[0]` is a track's name.
    on_track: bool,
}

/// Prefix of the steps an agent made.
const AI: &str = "AI: ";

/// Describes the step named `label` that turned `before` into `after`.
/// `name` gives a source's display name by id.
pub fn describe(
    before: &Project,
    after: &Project,
    label: &str,
    name: &dyn Fn(u64) -> String,
) -> Detail {
    let changes = diff(before, after, name);
    if let Some(title) = label.strip_prefix(AI) {
        let mut place = Vec::new();
        if let Some(t) = common_track(&changes) {
            place.push(t);
        }
        place.push(title.to_string());
        return Detail {
            kind: "ai",
            place,
            change: summary(&changes, common_track(&changes).is_some()),
            changes: changes.len(),
        };
    }
    let Some(first) = changes.first() else {
        return Detail {
            kind: "edit",
            place: vec![label.to_string()],
            change: String::new(),
            changes: 0,
        };
    };
    if changes.iter().all(|c| c.place == first.place) {
        return Detail {
            kind: first.kind,
            place: first.place.clone(),
            change: changes
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            changes: 1,
        };
    }
    // Several places at once: a multi-clip edit, an import, a batch.
    let track = common_track(&changes);
    let mut place = Vec::new();
    if let Some(t) = &track {
        place.push(t.clone());
    }
    place.push(label.to_string());
    let kind = if changes.iter().all(|c| c.kind == first.kind) {
        first.kind
    } else {
        "edit"
    };
    Detail {
        kind,
        place,
        change: summary(&changes, track.is_some()),
        changes: changes.len(),
    }
}

/// What makes edits "the same value on the same thing", or `None` when the
/// step can't join a run of nudges.
pub fn merge_key(before: &Project, after: &Project, label: &str) -> Option<String> {
    if label.starts_with(AI) {
        return None;
    }
    let changes = diff(before, after, &|_| String::new());
    let first = changes.first()?;
    if !changes.iter().all(|c| c.nudge && c.place == first.place) {
        return None;
    }
    let fields: BTreeSet<&str> = changes.iter().map(|c| c.field).collect();
    let fields: Vec<&str> = fields.into_iter().collect();
    Some(format!(
        "{}|{}",
        first.place.join("\u{1f}"),
        fields.join(",")
    ))
}

fn common_track(changes: &[Change]) -> Option<String> {
    let first = changes.first()?;
    (first.on_track
        && changes
            .iter()
            .all(|c| c.on_track && c.place[0] == first.place[0]))
    .then(|| first.place[0].clone())
}

/// "EQ band 2, volume, pan": the parts a many-place step touched.
fn summary(changes: &[Change], one_track: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in changes {
        let p = if one_track {
            &c.place[1..]
        } else {
            &c.place[..]
        };
        let s = p.iter().map(|w| part_word(w)).collect::<Vec<_>>().join(" ");
        if !parts.contains(&s) {
            parts.push(s);
        }
    }
    const SHOWN: usize = 3;
    let more = parts.len().saturating_sub(SHOWN);
    parts.truncate(SHOWN);
    let mut s = parts.join(", ");
    if more > 0 {
        s.push_str(&format!(" and {more} more"));
    }
    let mut c = s.chars();
    c.next()
        .map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

/// A place's word as it reads mid-sentence: "volume", "band 2"; names stay.
fn part_word(w: &str) -> String {
    const WORDS: [&str; 22] = [
        "Volume",
        "Pan",
        "Mute",
        "Solo",
        "Colour",
        "Bypass",
        "Fades",
        "Gain",
        "Move",
        "Trim",
        "Trim start",
        "Trim end",
        "Split",
        "Duplicate",
        "Reverse",
        "Stretch",
        "Pitch",
        "Envelope",
        "Add clip",
        "Delete clip",
        "Tempo",
        "Add track",
    ];
    if let Some(rest) = w.strip_prefix("Band ") {
        return format!("band {}", rest.split(' ').next().unwrap_or_default());
    }
    if WORDS.contains(&w) || w.starts_with("Add band") || w.starts_with("Delete band") {
        let mut c = w.chars();
        return c
            .next()
            .map_or_else(String::new, |f| f.to_lowercase().chain(c).collect());
    }
    w.to_string()
}

fn diff(b: &Project, a: &Project, name: &dyn Fn(u64) -> String) -> Vec<Change> {
    let mut out = Vec::new();
    let rate = a.sample_rate.max(1);
    if b.bpm != a.bpm {
        out.push(Change {
            kind: "tempo",
            place: vec!["Tempo".into()],
            field: "bpm",
            text: arrow(fmt_bpm(b.bpm), fmt_bpm(a.bpm)),
            nudge: true,
            on_track: false,
        });
    }
    if b.master_gain != a.master_gain {
        out.push(Change {
            kind: "volume",
            place: vec!["Master".into(), "Volume".into()],
            field: "gain",
            text: arrow(
                fmt_db(gain_to_db(b.master_gain)),
                fmt_db(gain_to_db(a.master_gain)),
            ),
            nudge: true,
            on_track: false,
        });
    }

    let bt: BTreeMap<u64, &Track> = b.tracks.iter().map(|t| (t.id, t)).collect();
    let at: BTreeMap<u64, &Track> = a.tracks.iter().map(|t| (t.id, t)).collect();
    for t in &b.tracks {
        if !at.contains_key(&t.id) {
            let n = t.clips.len();
            out.push(Change {
                kind: "delete",
                place: vec!["Delete track".into()],
                field: "track",
                text: match n {
                    0 => t.name.clone(),
                    1 => format!("{}, 1 clip", t.name),
                    n => format!("{}, {n} clips", t.name),
                },
                nudge: false,
                on_track: false,
            });
        }
    }
    for t in &a.tracks {
        if !bt.contains_key(&t.id) {
            out.push(Change {
                kind: "add",
                place: vec!["Add track".into()],
                field: "track",
                text: t.name.clone(),
                nudge: false,
                on_track: false,
            });
        }
    }
    // Order of the tracks both sides have.
    let bo: Vec<u64> = b
        .tracks
        .iter()
        .map(|t| t.id)
        .filter(|id| at.contains_key(id))
        .collect();
    let ao: Vec<u64> = a
        .tracks
        .iter()
        .map(|t| t.id)
        .filter(|id| bt.contains_key(id))
        .collect();
    if bo != ao {
        let without =
            |v: &[u64], id: u64| v.iter().copied().filter(|x| *x != id).collect::<Vec<_>>();
        let moved = ao
            .iter()
            .zip(&bo)
            .filter(|(x, y)| x != y)
            .flat_map(|(x, y)| [*x, *y])
            .find(|id| without(&bo, *id) == without(&ao, *id));
        if let Some(id) = moved {
            let pos = |v: &[u64]| v.iter().position(|x| *x == id).unwrap_or(0) + 1;
            out.push(Change {
                kind: "move",
                place: vec!["Move track".into()],
                field: "order",
                text: format!(
                    "{}, {}",
                    at[&id].name,
                    arrow(ordinal(pos(&bo)), ordinal(pos(&ao)))
                ),
                nudge: true,
                on_track: false,
            });
        }
    }
    for t in &a.tracks {
        if let Some(old) = bt.get(&t.id) {
            track_diff(old, t, &mut out);
        }
    }

    // Clips, by id across every track (a move can change tracks).
    let (bc, ac) = (clips(b), clips(a));
    let mut split_from = BTreeSet::new();
    for (id, (t, c)) in &ac {
        if bc.contains_key(id) || !bt.contains_key(&t.id) {
            continue;
        }
        let cname = name(c.source.id());
        // A split leaves the left part under the old id and adds the right.
        let left = ac.iter().find(|(lid, (lt, l))| {
            lt.id == t.id
                && l.source.id() == c.source.id()
                && l.end() == c.start
                && bc
                    .get(lid)
                    .is_some_and(|(_, old)| old.start == l.start && old.end() == c.end())
        });
        if let Some((lid, _)) = left {
            split_from.insert(*lid);
            out.push(Change {
                kind: "split",
                place: clip_place(t, cname, "Split"),
                field: "split",
                text: format!("at {}", fmt_time(c.start, rate)),
                nudge: false,
                on_track: true,
            });
            continue;
        }
        let twin = ac.iter().any(|(oid, (_, o))| {
            *oid != *id
                && bc.contains_key(oid)
                && o.source.id() == c.source.id()
                && o.offset == c.offset
                && o.len == c.len
        });
        out.push(Change {
            kind: "add",
            place: if twin {
                clip_place(t, cname.clone(), "Duplicate")
            } else {
                vec![t.name.clone(), "Add clip".into()]
            },
            field: "clip",
            text: if twin {
                format!("at {}", fmt_time(c.start, rate))
            } else {
                format!("{cname} at {}", fmt_time(c.start, rate))
            },
            nudge: false,
            on_track: true,
        });
    }
    for (id, (t, c)) in &bc {
        if ac.contains_key(id) || !at.contains_key(&t.id) {
            continue;
        }
        out.push(Change {
            kind: "delete",
            place: vec![t.name.clone(), "Delete clip".into()],
            field: "clip",
            text: format!(
                "{}, {}–{}",
                name(c.source.id()),
                fmt_time(c.start, rate),
                fmt_time(c.end(), rate)
            ),
            nudge: false,
            on_track: true,
        });
    }
    for (id, (t, c)) in &ac {
        if let Some((ot, oc)) = bc.get(id) {
            if !split_from.contains(id) {
                clip_diff(ot, oc, t, c, rate, name, &mut out);
            }
        }
    }
    out
}

/// "Drums › kick › Fades": a clip's place under its track. The clip's name
/// is left out when it's the track's too ("kick › Fades", not "kick › kick").
fn clip_place(t: &Track, clip: String, part: &str) -> Vec<String> {
    let mut place = vec![t.name.clone()];
    if clip != t.name {
        place.push(clip);
    }
    place.push(part.to_string());
    place
}

/// Every clip by id, with its track.
fn clips(p: &Project) -> BTreeMap<u64, (&Track, &Clip)> {
    p.tracks
        .iter()
        .flat_map(|t| t.clips.iter().map(move |c| (c.id, (t, c))))
        .collect()
}

fn track_diff(b: &Track, a: &Track, out: &mut Vec<Change>) {
    let n = &a.name;
    let mut push = |kind, part: &[&str], field, text: String, nudge| {
        let mut place = vec![n.clone()];
        place.extend(part.iter().map(|s| s.to_string()));
        out.push(Change {
            kind,
            place,
            field,
            text,
            nudge,
            on_track: true,
        });
    };
    if b.gain != a.gain {
        push(
            "volume",
            &["Volume"],
            "gain",
            arrow(fmt_db(gain_to_db(b.gain)), fmt_db(gain_to_db(a.gain))),
            true,
        );
    }
    if b.pan != a.pan {
        push(
            "pan",
            &["Pan"],
            "pan",
            arrow(fmt_pan(b.pan), fmt_pan(a.pan)),
            true,
        );
    }
    if b.muted != a.muted {
        push(
            "mute",
            &["Mute"],
            "mute",
            arrow(on_off(b.muted), on_off(a.muted)),
            false,
        );
    }
    if b.solo != a.solo {
        push(
            "solo",
            &["Solo"],
            "solo",
            arrow(on_off(b.solo), on_off(a.solo)),
            false,
        );
    }
    if b.color != a.color {
        let col = |c: Option<u8>| c.map_or("Auto".to_string(), |i| format!("Colour {}", i + 1));
        push(
            "colour",
            &["Colour"],
            "colour",
            arrow(col(b.color), col(a.color)),
            false,
        );
    }
    if b.eq.bypass() != a.eq.bypass() {
        push(
            "eq",
            &["EQ", "Bypass"],
            "bypass",
            arrow(on_off(b.eq.bypass()), on_off(a.eq.bypass())),
            false,
        );
    }
    let (bb, ab) = (b.eq.bands(), a.eq.bands());
    if bb != ab {
        let removed = |long: &[EqBand], short: &[EqBand]| {
            (0..long.len()).find(|&i| long[..i] == short[..i] && long[i + 1..] == short[i..])
        };
        if ab.len() == bb.len() + 1 && removed(ab, bb).is_some() {
            let i = removed(ab, bb).unwrap_or(0);
            push(
                "eq",
                &["EQ", &format!("Add band {}", i + 1)],
                "bands",
                fmt_band(&ab[i]),
                false,
            );
        } else if bb.len() == ab.len() + 1 && removed(bb, ab).is_some() {
            let i = removed(bb, ab).unwrap_or(0);
            push(
                "eq",
                &["EQ", &format!("Delete band {}", i + 1)],
                "bands",
                fmt_band(&bb[i]),
                false,
            );
        } else if bb.len() == ab.len() {
            for (i, (x, y)) in bb.iter().zip(ab).enumerate() {
                if x == y {
                    continue;
                }
                let band = format!("Band {} {}", i + 1, kind_name(y.kind));
                let part = ["EQ", band.as_str()];
                if x.kind != y.kind {
                    push(
                        "eq",
                        &part,
                        "kind",
                        arrow(kind_name(x.kind).into(), kind_name(y.kind).into()),
                        false,
                    );
                }
                if x.freq != y.freq {
                    push(
                        "eq",
                        &part,
                        "freq",
                        arrow(fmt_hz(x.freq), fmt_hz(y.freq)),
                        true,
                    );
                }
                if x.gain_db != y.gain_db && has_gain(y.kind) {
                    push(
                        "eq",
                        &part,
                        "gain",
                        arrow(fmt_db(x.gain_db), fmt_db(y.gain_db)),
                        true,
                    );
                }
                if x.q != y.q {
                    push(
                        "eq",
                        &part,
                        "q",
                        format!("Q {}", arrow(format!("{:.2}", x.q), format!("{:.2}", y.q))),
                        true,
                    );
                }
                if x.slope != y.slope && is_cut(y.kind) {
                    push(
                        "eq",
                        &part,
                        "slope",
                        format!(
                            "Slope {}",
                            arrow(x.slope.to_string(), format!("{} dB/oct", y.slope))
                        ),
                        true,
                    );
                }
                if x.on != y.on {
                    push("eq", &part, "on", arrow(on_off(x.on), on_off(y.on)), false);
                }
            }
        } else {
            push(
                "eq",
                &["EQ"],
                "bands",
                arrow(format!("{} bands", bb.len()), format!("{} bands", ab.len())),
                false,
            );
        }
    }
}

fn clip_diff(
    bt: &Track,
    b: &Clip,
    at: &Track,
    a: &Clip,
    rate: u32,
    name: &dyn Fn(u64) -> String,
    out: &mut Vec<Change>,
) {
    let cname = name(a.source.id());
    let mut push = |kind, part: &str, field, text: String, nudge| {
        let p = clip_place(at, cname.clone(), part);
        out.push(Change {
            kind,
            place: p,
            field,
            text,
            nudge,
            on_track: true,
        });
    };
    let t = |f: u64| fmt_time(f, rate);
    if b.stretch != a.stretch {
        // A stretch also scales the length and fades; it's one edit.
        push(
            "stretch",
            "Stretch",
            "stretch",
            arrow(fmt_stretch(b.stretch), fmt_stretch(a.stretch)),
            true,
        );
    } else if b.offset != a.offset || b.len != a.len {
        let (bs, be, as_, ae) = (b.start, b.end(), a.start, a.end());
        if bs != as_ && be == ae {
            push(
                "trim",
                "Trim start",
                "trim_start",
                arrow(t(bs), t(as_)),
                true,
            );
        } else if bs == as_ && be != ae {
            push("trim", "Trim end", "trim_end", arrow(t(be), t(ae)), true);
        } else {
            push(
                "trim",
                "Trim",
                "trim",
                arrow(
                    format!("{}–{}", t(bs), t(be)),
                    format!("{}–{}", t(as_), t(ae)),
                ),
                true,
            );
        }
    } else {
        if bt.id != at.id {
            push(
                "move",
                "Move",
                "move",
                format!(
                    "{}, {}",
                    arrow(bt.name.clone(), at.name.clone()),
                    arrow(t(b.start), t(a.start))
                ),
                true,
            );
        } else if b.start != a.start {
            push("move", "Move", "move", arrow(t(b.start), t(a.start)), true);
        }
        // Fades are clamped by a trim or stretch; only report them alone.
        let ms = |f: u64| format!("{} ms", (f as f64 / rate as f64 * 1000.0).round());
        if b.fade_in != a.fade_in {
            push(
                "fade",
                "Fades",
                "fade_in",
                format!("In {}", arrow(ms(b.fade_in), ms(a.fade_in))),
                true,
            );
        }
        if b.fade_out != a.fade_out {
            push(
                "fade",
                "Fades",
                "fade_out",
                format!("Out {}", arrow(ms(b.fade_out), ms(a.fade_out))),
                true,
            );
        }
        if b.fade_in_curve != a.fade_in_curve {
            push(
                "fade",
                "Fades",
                "curve_in",
                format!(
                    "In curve {}",
                    arrow(curve(b.fade_in_curve), curve(a.fade_in_curve))
                ),
                false,
            );
        }
        if b.fade_out_curve != a.fade_out_curve {
            push(
                "fade",
                "Fades",
                "curve_out",
                format!(
                    "Out curve {}",
                    arrow(curve(b.fade_out_curve), curve(a.fade_out_curve))
                ),
                false,
            );
        }
    }
    if b.pitch != a.pitch {
        push(
            "pitch",
            "Pitch",
            "pitch",
            arrow(fmt_pitch(b.pitch), fmt_pitch(a.pitch)),
            true,
        );
    }
    if b.gain != a.gain {
        push(
            "volume",
            "Gain",
            "gain",
            arrow(fmt_db(gain_to_db(b.gain)), fmt_db(gain_to_db(a.gain))),
            true,
        );
    }
    if b.reversed != a.reversed {
        push(
            "reverse",
            "Reverse",
            "reverse",
            arrow(on_off(b.reversed), on_off(a.reversed)),
            false,
        );
    }
    if b.envelope != a.envelope {
        let (n, m) = (b.envelope.len(), a.envelope.len());
        let text = if n == m {
            format!("{m} points, moved")
        } else {
            arrow(n.to_string(), format!("{m} points"))
        };
        push("envelope", "Envelope", "envelope", text, true);
    }
}

/// "−3.0 → −1.5 dB": the unit once, at the end, when both sides share it.
fn arrow(from: String, to: String) -> String {
    const UNITS: [&str; 8] = ["dB", "Hz", "kHz", "ms", "BPM", "st", "points", "bands"];
    let unit = |s: &str| s.rsplit_once(' ').map(|(_, u)| u.to_string());
    match (unit(&from), unit(&to)) {
        (Some(u), Some(v)) if u == v && UNITS.contains(&u.as_str()) => {
            format!("{} → {to}", &from[..from.len() - u.len() - 1])
        }
        _ => format!("{from} → {to}"),
    }
}

fn on_off(v: bool) -> String {
    if v { "On" } else { "Off" }.into()
}

/// "+4.2 dB", "0.0 dB", "−∞ dB", as the app shows levels.
fn fmt_db(db: f32) -> String {
    if !db.is_finite() || db <= crate::command::MIN_GAIN_DB {
        return "−∞ dB".into();
    }
    let v = if db.abs() < 0.05 { 0.0 } else { db };
    let sign = if v > 0.0 {
        "+"
    } else if v < 0.0 {
        "−"
    } else {
        ""
    };
    format!("{sign}{:.1} dB", v.abs())
}

fn fmt_hz(hz: f32) -> String {
    if hz >= 10_000.0 {
        format!("{:.1} kHz", hz / 1000.0)
    } else if hz >= 1000.0 {
        format!("{:.2} kHz", hz / 1000.0)
    } else if hz >= 100.0 {
        format!("{} Hz", hz.round())
    } else {
        format!("{hz:.1} Hz")
    }
}

/// "C", "L20", "R35", as the track header shows pan.
fn fmt_pan(p: f32) -> String {
    let v = (p * 100.0).round() as i32;
    match v {
        0 => "C".into(),
        v if v < 0 => format!("L{}", -v),
        v => format!("R{v}"),
    }
}

/// "+3 st", "−0.25 st"
fn fmt_pitch(st: f32) -> String {
    let v = (st * 100.0).round() / 100.0;
    let sign = if v > 0.0 {
        "+"
    } else if v < 0.0 {
        "−"
    } else {
        ""
    };
    let body = if v.fract() == 0.0 {
        format!("{}", v.abs() as i32)
    } else {
        format!("{:.2}", v.abs())
    };
    format!("{sign}{body} st")
}

fn fmt_stretch(s: f64) -> String {
    format!("×{s:.2}")
}

fn fmt_bpm(bpm: f64) -> String {
    let v = (bpm * 100.0).round() / 100.0;
    format!("{v} BPM")
}

/// "0:04.20"
fn fmt_time(frames: u64, rate: u32) -> String {
    let cs = (frames as f64 / rate as f64 * 100.0).round() as u64;
    format!("{}:{:02}.{:02}", cs / 6000, cs / 100 % 60, cs % 100)
}

fn ordinal(n: usize) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn curve(c: FadeCurve) -> String {
    match c {
        FadeCurve::Linear => "Linear",
        FadeCurve::Exp => "Exponential",
        FadeCurve::S => "S-curve",
    }
    .into()
}

fn kind_name(k: BandKind) -> &'static str {
    match k {
        BandKind::Bell => "Bell",
        BandKind::LowShelf => "Low shelf",
        BandKind::HighShelf => "High shelf",
        BandKind::LowCut => "Low cut",
        BandKind::HighCut => "High cut",
        BandKind::Notch => "Notch",
        BandKind::BandPass => "Band pass",
    }
}

fn has_gain(k: BandKind) -> bool {
    matches!(k, BandKind::Bell | BandKind::LowShelf | BandKind::HighShelf)
}

fn is_cut(k: BandKind) -> bool {
    matches!(k, BandKind::LowCut | BandKind::HighCut)
}

/// "High shelf 8.00 kHz +1.5 dB"
fn fmt_band(b: &EqBand) -> String {
    let mut s = format!("{} {}", kind_name(b.kind), fmt_hz(b.freq));
    if has_gain(b.kind) {
        s.push(' ');
        s.push_str(&fmt_db(b.gain_db));
    }
    if is_cut(b.kind) {
        s.push_str(&format!(" {} dB/oct", b.slope));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrows_name_the_unit_once() {
        assert_eq!(arrow(fmt_db(-3.0), fmt_db(-1.5)), "−3.0 → −1.5 dB");
        assert_eq!(arrow(fmt_hz(1200.0), fmt_hz(2450.0)), "1.20 → 2.45 kHz");
        assert_eq!(arrow(fmt_hz(850.0), fmt_hz(1200.0)), "850 Hz → 1.20 kHz");
        assert_eq!(arrow(fmt_pan(0.0), fmt_pan(-0.2)), "C → L20");
        assert_eq!(arrow("Audio 3".into(), "Guitar".into()), "Audio 3 → Guitar");
        assert_eq!(
            arrow("Low shelf".into(), "High shelf".into()),
            "Low shelf → High shelf"
        );
        assert_eq!(arrow(fmt_bpm(120.0), fmt_bpm(124.5)), "120 → 124.5 BPM");
    }

    #[test]
    fn a_clip_named_like_its_track_is_named_once() {
        let t = |name: &str| Track {
            name: name.into(),
            ..Track::default()
        };
        assert_eq!(
            clip_place(&t("kick"), "kick".into(), "Fades"),
            ["kick", "Fades"]
        );
        assert_eq!(
            clip_place(&t("Drums"), "kick".into(), "Fades"),
            ["Drums", "kick", "Fades"]
        );
    }

    #[test]
    fn formats() {
        assert_eq!(fmt_time(48_000 * 64 + 9_600, 48_000), "1:04.20");
        assert_eq!(fmt_pitch(2.0), "+2 st");
        assert_eq!(fmt_pitch(-0.25), "−0.25 st");
        assert_eq!(fmt_db(f32::NEG_INFINITY), "−∞ dB");
        assert_eq!(ordinal(1), "1st");
        assert_eq!(ordinal(12), "12th");
        assert_eq!(ordinal(23), "23rd");
    }
}
