//! Tauri command + streaming surface.
//!
//! - Discrete actions are `#[tauri::command]`s (spec §4.3).
//! - Live meter updates stream over a `tauri::ipc::Channel` (FR-2.1).
//! - Device/rate/buffer selection persists via `tauri-plugin-store` (FR-1.2).
//! - Recording streams to 32-bit float WAV and lands on the timeline as a
//!   non-destructive overdub (FR-2.2/2.3/2.4/2.5).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;
use waver_core::engine::{DeviceInfo, HostInfo, MeterUpdate, StreamParams};
use waver_core::model::{Project, Source};
use waver_engine::{InputSession, NativeEngine};

/// App-wide audio + project state (Tauri managed state; `Send + Sync`).
pub struct AudioState {
    engine: NativeEngine,
    /// The open input session (metering + capture), if any.
    session: Mutex<Option<InputSession>>,
    /// Path of the file currently being recorded, if any.
    recording_path: Mutex<Option<std::path::PathBuf>>,
    /// The non-destructive project model.
    project: Mutex<Project>,
    /// Monotonic take counter for friendly names.
    takes: AtomicU64,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            engine: NativeEngine::new(),
            session: Mutex::new(None),
            recording_path: Mutex::new(None),
            project: Mutex::new(Project::new(48_000)),
            takes: AtomicU64::new(0),
        }
    }
}

impl AudioState {
    fn close_session(&self) {
        // Drop outside the lock hold across the blocking join.
        let session = self.session.lock().expect("session mutex poisoned").take();
        drop(session);
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

/// A finished recording placed on the timeline (returned to the frontend).
#[derive(Debug, Clone, Serialize)]
pub struct RecordingResult {
    pub source_id: String,
    pub clip_id: String,
    pub name: String,
    pub path: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub frames: u64,
    pub duration_secs: f64,
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

/// FR-2.1 — open a live input session; meter updates stream over `channel`.
/// Any existing session is closed first.
#[tauri::command]
pub fn open_input(
    state: State<'_, AudioState>,
    device_id: String,
    params: StreamParams,
    channel: Channel<MeterUpdate>,
) -> Result<(), String> {
    state.close_session();
    let session = state
        .engine
        .open_input(&device_id, params, move |update| {
            let _ = channel.send(update);
        })
        .map_err(|e| e.to_string())?;
    *state.session.lock().expect("session mutex poisoned") = Some(session);
    Ok(())
}

/// Close the live input session (stops metering + any recording).
#[tauri::command]
pub fn close_input(state: State<'_, AudioState>) -> Result<(), String> {
    state.close_session();
    *state
        .recording_path
        .lock()
        .expect("rec path mutex poisoned") = None;
    Ok(())
}

/// FR-2.2/2.3 — start recording the open input to a fresh WAV in the app data dir.
#[tauri::command]
pub fn start_recording(app: AppHandle, state: State<'_, AudioState>) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let n = state.takes.load(Ordering::SeqCst) + 1;
    // Unique filename (monotonic counter + wall clock for collision safety).
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("take-{n:03}-{stamp}.wav"));

    let guard = state.session.lock().expect("session mutex poisoned");
    let session = guard.as_ref().ok_or("no input device is open")?;
    session
        .start_recording(path.clone())
        .map_err(|e| e.to_string())?;
    drop(guard);

    *state
        .recording_path
        .lock()
        .expect("rec path mutex poisoned") = Some(path.clone());
    Ok(path.to_string_lossy().to_string())
}

/// FR-2.2/2.5 — stop recording, finalize the WAV, and place it on the timeline.
#[tauri::command]
pub fn stop_recording(state: State<'_, AudioState>) -> Result<RecordingResult, String> {
    let info = {
        let guard = state.session.lock().expect("session mutex poisoned");
        let session = guard.as_ref().ok_or("no input device is open")?;
        session.stop_recording().map_err(|e| e.to_string())?
    };
    *state
        .recording_path
        .lock()
        .expect("rec path mutex poisoned") = None;

    let n = state.takes.fetch_add(1, Ordering::SeqCst) + 1;
    let name = format!("Take {n}");
    let duration_secs = info.frames as f64 / info.sample_rate.max(1) as f64;

    // Place the recording on the timeline non-destructively (FR-2.5).
    let source = Source::new(
        info.path.clone(),
        info.channels,
        info.sample_rate,
        info.frames,
    );
    let (source_id, clip_id) = {
        let mut project = state.project.lock().expect("project mutex poisoned");
        // Append at the end of the (single) recording track, or a new track.
        let track_id = project.tracks.first().map(|t| t.id);
        let start = project
            .tracks
            .first()
            .and_then(|t| t.clips.iter().map(|c| c.timeline_end()).max())
            .unwrap_or(0);
        project.add_recording(source, track_id, start)
    };

    Ok(RecordingResult {
        source_id: source_id.to_string(),
        clip_id: clip_id.to_string(),
        name,
        path: info.path.to_string_lossy().to_string(),
        channels: info.channels,
        sample_rate: info.sample_rate,
        frames: info.frames,
        duration_secs,
    })
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
