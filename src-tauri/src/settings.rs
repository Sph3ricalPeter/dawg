//! The UI's settings (panel sizes, toggles, the Browser's folders and pins,
//! export choices...), one JSON object in the app's data folder. A file the
//! app owns survives restarts and updates however the window closes, which
//! the webview's localStorage doesn't promise.

use std::fs;
use std::path::Path;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

const FILE: &str = "settings.json";

/// The saved settings, or None when there are none yet (first run, or a
/// file that no longer parses).
pub fn read(dir: &Path) -> Option<Map<String, Value>> {
    let bytes = fs::read(dir.join(FILE)).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Writes through a temp file and a rename, so a crash mid-write keeps the
/// previous settings.
pub fn write(dir: &Path, settings: &Map<String, Value>) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(settings)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    fs::write(&tmp, json)?;
    fs::rename(&tmp, dir.join(FILE))
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
        let _ = fs::remove_dir_all(&dir);
    }
}
