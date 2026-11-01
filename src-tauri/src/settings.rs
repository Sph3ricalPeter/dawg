//! The UI's settings (panel sizes, toggles, the Browser's folders and pins,
//! export choices...), one JSON object in the app's data folder. A file the
//! app owns survives restarts and updates however the window closes, which
//! the webview's localStorage doesn't promise.
//!
//! `views.json` beside it remembers how each file was last shown (zoom,
//! scroll, playhead, track heights), keyed by the file's path; the UI keeps
//! it (`src/lib/view-memory.ts`).
//!
//! `library.json` is the Browser's library: custom labels, and each file's
//! labels and favourite, keyed by path (`src/stores/library-store.ts`). It
//! lives here rather than beside the audio, so nothing is ever written into
//! the folders a user browses (a Unity project would import it).

use std::fs;
use std::path::Path;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

const FILE: &str = "settings.json";
const VIEWS: &str = "views.json";
const LIBRARY: &str = "library.json";

/// The saved settings, or None when there are none yet (first run, or a
/// file that no longer parses).
pub fn read(dir: &Path) -> Option<Map<String, Value>> {
    read_file(dir, FILE)
}

fn read_file(dir: &Path, file: &str) -> Option<Map<String, Value>> {
    let bytes = fs::read(dir.join(file)).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Writes through a temp file and a rename, so a crash mid-write keeps the
/// previous settings.
pub fn write(dir: &Path, settings: &Map<String, Value>) -> std::io::Result<()> {
    write_file(dir, FILE, settings)
}

fn write_file(dir: &Path, file: &str, map: &Map<String, Value>) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(map)?;
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, json)?;
    fs::rename(&tmp, dir.join(file))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Option<Map<String, Value>> {
    read(&app.path().app_local_data_dir().ok()?)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Map<String, Value>) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    write(&dir, &settings).map_err(|e| e.to_string())
}

/// Each file's last view, by path.
#[tauri::command]
pub fn load_views(app: AppHandle) -> Option<Map<String, Value>> {
    read_file(&app.path().app_local_data_dir().ok()?, VIEWS)
}

#[tauri::command]
pub fn save_views(app: AppHandle, views: Map<String, Value>) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    write_file(&dir, VIEWS, &views).map_err(|e| e.to_string())
}

/// The Browser's labels and favourites.
#[tauri::command]
pub fn load_library(app: AppHandle) -> Option<Map<String, Value>> {
    read_file(&app.path().app_local_data_dir().ok()?, LIBRARY)
}

#[tauri::command]
pub fn save_library(app: AppHandle, library: Map<String, Value>) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    write_file(&dir, LIBRARY, &library).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_replaces() {
        let dir = std::env::temp_dir().join(format!("dawg-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(read(&dir), None);

        let mut a = Map::new();
        a.insert("browser".into(), serde_json::json!({ "width": 240 }));
        write(&dir, &a).unwrap();
        assert_eq!(read(&dir), Some(a.clone()));

        a.insert("loop".into(), Value::Bool(false));
        write(&dir, &a).unwrap();
        assert_eq!(read(&dir), Some(a));
        assert!(!dir.join("settings.json.tmp").exists());

        fs::write(dir.join(FILE), b"not json").unwrap();
        assert_eq!(read(&dir), None);

        // Views sit beside the settings and leave them alone.
        let mut v = Map::new();
        v.insert("song.dawg".into(), serde_json::json!({ "fpp": 100.0 }));
        write_file(&dir, VIEWS, &v).unwrap();
        assert_eq!(read_file(&dir, VIEWS), Some(v.clone()));
        assert_eq!(read(&dir), None);

        // So does the library.
        let mut l = Map::new();
        l.insert("version".into(), serde_json::json!(1));
        write_file(&dir, LIBRARY, &l).unwrap();
        assert_eq!(read_file(&dir, LIBRARY), Some(l));
        assert_eq!(read_file(&dir, VIEWS), Some(v));
        let _ = fs::remove_dir_all(&dir);
    }
}
