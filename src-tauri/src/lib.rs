mod audio;
mod commands;

use serde::Serialize;
use tauri::Manager;

/// Bundle identifier of the released app. Local test builds use
/// `tauri.dev.conf.json`, which sets a different one so they never self-update.
const RELEASE_IDENTIFIER: &str = "com.sph3ricalpeter.dawg";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    core_version: &'static str,
    /// "release" for the installed app, "dev" for `tauri dev` and local test builds.
    channel: &'static str,
    updates_enabled: bool,
}

fn is_release(app: &tauri::AppHandle) -> bool {
    !cfg!(debug_assertions) && app.config().identifier == RELEASE_IDENTIFIER
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let release = is_release(&app);
    AppInfo {
        version: app.package_info().version.to_string(),
        core_version: dawg_core::VERSION,
        channel: if release { "release" } else { "dev" },
        updates_enabled: release,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::new(commands::file_from_args(
            std::env::args_os().skip(1),
        )))
        .setup(|app| {
            if is_release(app.handle()) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            commands::prune_backups(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                if !is_release(app.handle()) {
                    window.set_title("dawg dev")?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            commands::startup_file,
            commands::open_file,
            commands::session_state,
            commands::apply,
            commands::end_gesture,
            commands::undo,
            commands::redo,
            commands::peaks,
            commands::play,
            commands::stop,
            commands::transport,
            commands::save_preview,
            commands::replace_original,
            commands::save_as,
            commands::last_replace,
            commands::restore_last_replace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running dawg");
}
