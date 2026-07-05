//! Waver Tauri backend entry point.
//!
//! Commands and streaming channels that bridge the `waver-engine` audio engine and
//! `waver-core` model to the React frontend are registered here.

mod commands;

use serde::Serialize;

use commands::AudioState;

/// Minimal app metadata returned to the frontend to confirm the IPC bridge works.
#[derive(Serialize)]
struct AppInfo {
    name: String,
    version: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "Waver".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            commands::list_devices,
            commands::list_hosts,
            commands::start_metering,
            commands::stop_metering,
            commands::load_settings,
            commands::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
