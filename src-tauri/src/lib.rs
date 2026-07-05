//! Waver Tauri backend entry point.
//!
//! Commands and streaming channels that bridge the `waver-core` engine/model to the
//! React frontend are registered here. For M0 this is just an `app_info` smoke-test
//! command proving the Rust↔JS IPC bridge is live; device/capture/timeline commands
//! arrive in later milestones.

use serde::Serialize;

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
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
