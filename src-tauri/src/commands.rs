//! Tauri command + streaming surface for M1 (devices + metering).
//!
//! - Discrete request/response actions are `#[tauri::command]`s (spec §4.3).
//! - Live meter updates stream over a `tauri::ipc::Channel` (spec §4.3 / FR-2.1) —
//!   never the event system.
//! - Device/rate/buffer selection persists via `tauri-plugin-store` (FR-1.2); the
//!   store is accessed only from Rust so no extra capability permission is needed.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;
use waver_core::engine::{DeviceInfo, HostInfo, MeterUpdate, StreamParams};
use waver_engine::{MeterHandle, NativeEngine};

/// App-wide audio state held in Tauri's managed state. `Send + Sync` so it can live
/// behind `State`.
#[derive(Default)]
pub struct AudioState {
    engine: NativeEngine,
    /// The active metering session, if any.
    meter: Mutex<Option<MeterHandle>>,
}

impl AudioState {
    fn stop_metering(&self) {
        // Take the handle out and release the lock BEFORE the blocking stop()/join,
        // so we never hold the mutex across a join.
        let handle = self.meter.lock().expect("meter mutex poisoned").take();
        if let Some(mut handle) = handle {
            handle.stop();
        }
    }
}

/// Persisted device/stream selection (spec FR-1.2).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioSettings {
    pub input_device_id: Option<String>,
    pub output_device_id: Option<String>,
    pub sample_rate: Option<u32>,
    pub buffer_frames: Option<u32>,
}

const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_KEY: &str = "audio";

/// FR-1.1 — enumerate all input & output devices across hosts.
#[tauri::command]
pub fn list_devices(state: State<'_, AudioState>) -> Result<Vec<DeviceInfo>, String> {
    state.engine.list_devices().map_err(|e| e.to_string())
}

/// FR-1.1 — list available hosts/backends.
#[tauri::command]
pub fn list_hosts(state: State<'_, AudioState>) -> Result<Vec<HostInfo>, String> {
    state.engine.list_hosts().map_err(|e| e.to_string())
}

/// FR-2.1 — start live input metering; updates stream over `channel` at ~50 Hz.
/// Any existing session is stopped first.
#[tauri::command]
pub fn start_metering(
    state: State<'_, AudioState>,
    device_id: String,
    params: StreamParams,
    channel: Channel<MeterUpdate>,
) -> Result<(), String> {
    state.stop_metering();
    let handle = state
        .engine
        .start_metering(&device_id, params, move |update| {
            // Channel::send is non-blocking and cheap; ignore transient send errors
            // (e.g. the frontend dropped the channel mid-teardown).
            let _ = channel.send(update);
        })
        .map_err(|e| e.to_string())?;
    *state.meter.lock().expect("meter mutex poisoned") = Some(handle);
    Ok(())
}

/// FR-2.1 — stop live input metering.
#[tauri::command]
pub fn stop_metering(state: State<'_, AudioState>) -> Result<(), String> {
    state.stop_metering();
    Ok(())
}

/// FR-1.2 — load persisted device/stream selection.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<AudioSettings, String> {
    let store = app.store(SETTINGS_FILE).map_err(|e| e.to_string())?;
    match store.get(SETTINGS_KEY) {
        Some(v) => serde_json::from_value(v).map_err(|e| e.to_string()),
        None => Ok(AudioSettings::default()),
    }
}

/// FR-1.2 — persist device/stream selection across restarts.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AudioSettings) -> Result<(), String> {
    let store = app.store(SETTINGS_FILE).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
    store.set(SETTINGS_KEY, value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
