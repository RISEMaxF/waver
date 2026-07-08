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
        .plugin(tauri_plugin_dialog::init())
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            commands::list_devices,
            commands::list_hosts,
            commands::open_input,
            commands::close_input,
            commands::input_buffer_frames,
            commands::start_recording,
            commands::stop_recording,
            commands::get_waveform_peaks,
            commands::get_project,
            commands::split_clip,
            commands::trim_clip_end,
            commands::trim_clip_start,
            commands::move_clip,
            commands::delete_clip,
            commands::split_clip_channels,
            commands::set_clip_gain,
            commands::set_track_gain,
            commands::set_track_muted,
            commands::set_track_soloed,
            commands::set_track_name,
            commands::set_track_color,
            commands::add_track,
            commands::remove_track,
            commands::duplicate_clip,
            commands::paste_clip,
            commands::set_clip_name,
            commands::set_record_target,
            commands::set_clip_fade_in,
            commands::set_clip_fade_out,
            commands::play,
            commands::preview_source,
            commands::pause_playback,
            commands::stop_playback,
            commands::playback_status,
            commands::playback_levels,
            commands::sync_playback,
            commands::delete_range,
            commands::delete_clips,
            commands::move_clips,
            commands::group_clips,
            commands::ungroup_clips,
            commands::set_clips_locked,
            commands::add_marker,
            commands::import_dropped,
            commands::move_marker,
            commands::rename_marker,
            commands::delete_marker,
            commands::merge_clips,
            commands::autosave_project,
            commands::check_recovery,
            commands::discard_recovery,
            commands::zero_crossing,
            commands::import_audio,
            commands::export_project,
            commands::new_project,
            commands::import_to_pool,
            commands::save_project,
            commands::load_project,
            commands::undo,
            commands::redo,
            commands::load_settings,
            commands::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
