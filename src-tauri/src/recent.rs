//! Recently opened and saved projects, newest first, kept in the app's data
//! folder.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const FILE: &str = "recent-projects.json";
const KEEP: usize = 10;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: PathBuf,
    pub name: String,
    /// The file is still there.
    pub exists: bool,
}

fn read(dir: &Path) -> Vec<PathBuf> {
    fs::read(dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write(dir: &Path, list: &[PathBuf]) {
    // Best effort: losing the list only loses a shortcut.
    if fs::create_dir_all(dir).is_ok() {
        if let Ok(json) = serde_json::to_vec_pretty(list) {
            let _ = fs::write(dir.join(FILE), json);
        }
    }
}

fn same(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

pub fn list(dir: &Path) -> Vec<Recent> {
    read(dir)
        .into_iter()
        .map(|path| Recent {
            name: path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            exists: path.is_file(),
            path,
        })
        .collect()
}

/// Puts `path` at the top.
pub fn add(dir: &Path, path: &Path) {
    let mut list = read(dir);
    list.retain(|p| !same(p, path));
    list.insert(0, path.to_path_buf());
    list.truncate(KEEP);
    write(dir, &list);
}

pub fn remove(dir: &Path, path: &Path) {
    let mut list = read(dir);
    list.retain(|p| !same(p, path));
    write(dir, &list);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_first_without_repeats() {
        let dir = std::env::temp_dir().join(format!("dawg-recent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(list(&dir).is_empty());
        for i in 0..12 {
            add(&dir, &dir.join(format!("p{i}.dawg")));
        }
        add(&dir, &dir.join("p5.dawg"));
        let l = list(&dir);
        assert_eq!(l.len(), KEEP);
        assert_eq!(l[0].name, "p5");
        assert_eq!(l[1].name, "p11");
        assert!(!l[0].exists);
        remove(&dir, &dir.join("p5.dawg"));
        assert_eq!(list(&dir)[0].name, "p11");
        let _ = fs::remove_dir_all(&dir);
    }
}
