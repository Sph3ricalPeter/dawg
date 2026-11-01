//! Track categories: what a row holds (Drums, Bass, FX…), as in an FL
//! Studio playlist. A category gives a track its colour and icon, and its
//! name while the track still has the "Track N" it was made with.
//!
//! A track takes its category once: from the first clip dropped on it whose
//! file has a Browser Type label, while it has none (see
//! `design/track-categories.md`). Later clips never change it. The mapping
//! from labels to categories and each category's icon live in the UI
//! (`src/lib/categories.ts`), which must list the same ids and colours.

use crate::model::Track;

/// Every category as (id, name, clip palette index), in the order the
/// picker lists them.
pub const CATEGORIES: &[(&str, &str, u8)] = &[
    ("drums", "Drums", 0),
    ("perc", "Perc", 1),
    ("bass", "Bass", 3),
    ("leads", "Leads", 5),
    ("pads", "Pads", 4),
    ("vox", "Vox", 2),
    ("fx", "FX", 6),
    ("foley", "Foley", 7),
    ("ambience", "Ambience", 3),
    ("music", "Music", 5),
    ("ui", "UI", 4),
];

/// A category's name, or `None` for an unknown id.
pub fn name(id: &str) -> Option<&'static str> {
    CATEGORIES.iter().find(|c| c.0 == id).map(|c| c.1)
}

/// A track's palette index: the one picked for it, else its category's,
/// else `None` (by position).
pub fn color(picked: Option<u8>, category: Option<&str>) -> Option<u8> {
    picked.or_else(|| {
        let id = category?;
        CATEGORIES.iter().find(|c| c.0 == id).map(|c| c.2)
    })
}

/// True for a name dawg gave the track ("Track 3"), not one typed for it.
pub fn is_default_name(name: &str) -> bool {
    name.strip_prefix("Track ")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Sets track `t`'s category to `id`. A track still called "Track N" is
/// renamed after it: "Drums", or "Drums 2" when another track has that name.
pub fn set(tracks: &mut [Track], t: usize, id: Option<&str>) {
    tracks[t].category = id.map(str::to_string);
    let Some(base) = id.and_then(name) else {
        return;
    };
    if !is_default_name(&tracks[t].name) {
        return;
    }
    let taken = |n: &str| {
        tracks
            .iter()
            .enumerate()
            .any(|(i, o)| i != t && o.name == n)
    };
    let mut n = base.to_string();
    let mut k = 2;
    while taken(&n) {
        n = format!("{base} {k}");
        k += 1;
    }
    tracks[t].name = n;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(name: &str) -> Track {
        Track {
            name: name.into(),
            ..Track::default()
        }
    }

    #[test]
    fn default_names() {
        assert!(is_default_name("Track 1"));
        assert!(is_default_name("Track 12"));
        assert!(!is_default_name("Track"));
        assert!(!is_default_name("Track 2b"));
        assert!(!is_default_name("Kick"));
    }

    #[test]
    fn a_numbered_track_takes_the_category_name() {
        let mut t = vec![track("Drums"), track("Track 2"), track("Mine")];
        set(&mut t, 1, Some("drums"));
        assert_eq!(
            (t[1].name.as_str(), t[1].category.as_deref()),
            ("Drums 2", Some("drums"))
        );
        // A name someone typed stays.
        set(&mut t, 2, Some("bass"));
        assert_eq!(
            (t[2].name.as_str(), t[2].category.as_deref()),
            ("Mine", Some("bass"))
        );
        // Clearing keeps the name.
        set(&mut t, 1, None);
        assert_eq!(color(None, Some("bass")), Some(3));
        assert_eq!(color(Some(1), Some("bass")), Some(1));
        assert_eq!(
            (t[1].name.as_str(), t[1].category.as_deref()),
            ("Drums 2", None)
        );
    }
}
