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
use waver_core::edit::{ClipSpec, EditError, History};
use waver_core::engine::{DeviceInfo, HostInfo, MeterUpdate, StreamParams};
use waver_core::model::{FadeCurve, Project, Source};
use waver_engine::{
    BitDepth, ExportFormat, ExportOptions, InputSession, LoopRegion, NativeEngine, Playback,
};

/// The project model plus its undo/redo history, guarded together to keep them
/// consistent under one lock.
pub struct EditState {
    project: Project,
    history: History,
}

/// App-wide audio + project state (Tauri managed state; `Send + Sync`).
pub struct AudioState {
    engine: NativeEngine,
    /// The open input session (metering + capture), if any.
    session: Mutex<Option<InputSession>>,
    /// Path of the file currently being recorded, if any.
    recording_path: Mutex<Option<std::path::PathBuf>>,
    /// Where the next recording lands: (armed track, start frame). `None` track means
    /// "append to the first/new track" (the pre-arming behavior).
    record_target: Mutex<(Option<uuid::Uuid>, u64)>,
    /// The non-destructive project model + edit history.
    edit: Mutex<EditState>,
    /// The active playback session, if any.
    playback: Mutex<Option<Playback>>,
    /// Monotonic take counter for friendly names.
    takes: AtomicU64,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            engine: NativeEngine::new(),
            session: Mutex::new(None),
            recording_path: Mutex::new(None),
            record_target: Mutex::new((None, 0)),
            edit: Mutex::new(EditState {
                project: new_project_with_track(48_000),
                history: History::default(),
            }),
            playback: Mutex::new(None),
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

/// Apply an undoable edit: snapshot the current project, apply `f` to a clone, and
/// commit only if it succeeds. Returns the updated view.
fn apply_edit<F>(state: &AudioState, f: F) -> Result<ProjectView, String>
where
    F: FnOnce(&mut Project) -> Result<(), EditError>,
{
    let mut guard = state.edit.lock().expect("edit mutex poisoned");
    let st = &mut *guard;
    let mut next = st.project.clone();
    f(&mut next).map_err(|e| e.to_string())?;
    // Skip no-op edits so they don't pollute the undo history or wipe the redo stack.
    if next == st.project {
        return Ok(ProjectView::of(&st.project, &st.history));
    }
    // Enforce the §3 invariants (esp. non-overlap) at this single commit choke point,
    // so no edit can persist an invalid project or pollute the undo history.
    next.validate().map_err(|e| e.to_string())?;
    st.history.snapshot(&st.project);
    st.project = next;
    Ok(ProjectView::of(&st.project, &st.history))
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
    /// Placement on the timeline, in frames (spec FR-2.5).
    pub timeline_start: u64,
    /// True if the capture ring overran (dropped samples) during this take.
    pub xrun: bool,
}

/// A serialized view of the project for the frontend timeline.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectView {
    pub sample_rate: u32,
    pub can_undo: bool,
    pub can_redo: bool,
    pub tracks: Vec<TrackView>,
    pub sources: Vec<SourceView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackView {
    pub id: String,
    pub name: String,
    pub gain_db: f32,
    pub muted: bool,
    pub soloed: bool,
    pub color: Option<String>,
    pub clips: Vec<ClipView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClipView {
    pub id: String,
    pub name: String,
    pub source_id: String,
    pub source_channel: Option<u16>,
    pub source_in: u64,
    pub source_out: u64,
    pub timeline_start: u64,
    pub gain_db: f32,
    pub fade_in_len: u64,
    pub fade_out_len: u64,
    pub fade_in_curve: String,
    pub fade_out_curve: String,
}

fn curve_str(c: FadeCurve) -> String {
    match c {
        FadeCurve::Linear => "linear",
        FadeCurve::EqualPower => "equal_power",
        FadeCurve::Log => "log",
    }
    .to_string()
}

fn parse_curve(s: &str) -> FadeCurve {
    match s {
        "equal_power" => FadeCurve::EqualPower,
        "log" => FadeCurve::Log,
        _ => FadeCurve::Linear,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceView {
    pub id: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub frames: u64,
    /// Absolute source file path (for the media pool to show a name).
    pub path: String,
}

impl ProjectView {
    fn of(project: &Project, history: &History) -> Self {
        ProjectView {
            sample_rate: project.sample_rate,
            can_undo: history.can_undo(),
            can_redo: history.can_redo(),
            tracks: project
                .tracks
                .iter()
                .map(|t| TrackView {
                    id: t.id.to_string(),
                    name: t.name.clone(),
                    gain_db: t.gain_db,
                    muted: t.muted,
                    soloed: t.soloed,
                    color: t.color.clone(),
                    clips: t
                        .clips
                        .iter()
                        .map(|c| ClipView {
                            id: c.id.to_string(),
                            name: c.name.clone(),
                            source_id: c.source_id.to_string(),
                            source_channel: c.source_channel,
                            source_in: c.source_in,
                            source_out: c.source_out,
                            timeline_start: c.timeline_start,
                            gain_db: c.gain_db,
                            fade_in_len: c.fade_in.len_frames,
                            fade_out_len: c.fade_out.len_frames,
                            fade_in_curve: curve_str(c.fade_in.curve),
                            fade_out_curve: curve_str(c.fade_out.curve),
                        })
                        .collect(),
                })
                .collect(),
            sources: project
                .sources
                .iter()
                .map(|s| SourceView {
                    id: s.id.to_string(),
                    channels: s.channels,
                    sample_rate: s.sample_rate,
                    frames: s.frames,
                    path: s.path.to_string_lossy().to_string(),
                })
                .collect(),
        }
    }
}

/// Parse a Uuid string from the frontend.
fn parse_id(s: &str) -> Result<uuid::Uuid, String> {
    uuid::Uuid::parse_str(s).map_err(|e| format!("bad id {s}: {e}"))
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

/// The actual buffer size (frames per callback) the open input resolved to — including
/// what "Default" chose. `None` before the first callback or with no input open.
#[tauri::command]
pub fn input_buffer_frames(state: State<'_, AudioState>) -> Option<u32> {
    state
        .session
        .lock()
        .expect("session mutex poisoned")
        .as_ref()
        .and_then(|s| s.observed_buffer())
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

/// Rename a track (undoable).
#[tauri::command]
pub fn set_track_name(
    state: State<'_, AudioState>,
    track_id: String,
    name: String,
) -> Result<ProjectView, String> {
    let id = parse_id(&track_id)?;
    apply_edit(&state, |p| p.set_track_name(id, name.clone()))
}

/// Set a track's identity color (hex), or `null` to revert to the auto color.
#[tauri::command]
pub fn set_track_color(
    state: State<'_, AudioState>,
    track_id: String,
    color: Option<String>,
) -> Result<ProjectView, String> {
    let id = parse_id(&track_id)?;
    apply_edit(&state, |p| p.set_track_color(id, color.clone()))
}

/// Add an empty track (Audacity-style: create a track, then arm it for recording).
#[tauri::command]
pub fn add_track(state: State<'_, AudioState>) -> ProjectView {
    let mut guard = state.edit.lock().expect("edit mutex poisoned");
    let st = &mut *guard;
    st.history.snapshot(&st.project);
    let name = format!("Track {}", st.project.tracks.len() + 1);
    st.project.tracks.push(waver_core::model::Track::new(name));
    ProjectView::of(&st.project, &st.history)
}

/// Remove a track and its clips (undoable).
#[tauri::command]
pub fn remove_track(state: State<'_, AudioState>, track_id: String) -> Result<ProjectView, String> {
    let id = parse_id(&track_id)?;
    apply_edit(&state, |p| p.remove_track(id))
}

/// Rename a clip (undoable).
#[tauri::command]
pub fn set_clip_name(
    state: State<'_, AudioState>,
    clip_id: String,
    name: String,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| p.set_clip_name(id, name.clone()))
}

/// Duplicate a clip onto its track at `timeline_start` (undoable).
#[tauri::command]
pub fn duplicate_clip(
    state: State<'_, AudioState>,
    clip_id: String,
    timeline_start: u64,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| p.duplicate_clip(id, timeline_start).map(|_| ()))
}

/// Paste a clip from an explicit spec (clipboard) onto a track (undoable).
#[tauri::command]
pub fn paste_clip(
    state: State<'_, AudioState>,
    spec: ClipSpec,
    track_id: String,
) -> Result<ProjectView, String> {
    let tid = parse_id(&track_id)?;
    apply_edit(&state, |p| p.place_clip(spec, tid).map(|_| ()))
}

/// Arm where the next recording lands: a target track (or `None` to append) and the
/// start frame (the playhead). The frontend keeps this in sync with the armed track.
#[tauri::command]
pub fn set_record_target(
    state: State<'_, AudioState>,
    track_id: Option<String>,
    start_frame: u64,
) -> Result<(), String> {
    let id = match track_id {
        Some(s) => Some(parse_id(&s)?),
        None => None,
    };
    *state
        .record_target
        .lock()
        .expect("record target mutex poisoned") = (id, start_frame);
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

    // If nothing valid is armed, create a track now (undoable) so the take has a home
    // AND the live waveform has a lane to draw into — Audacity's "record makes a track".
    {
        let mut tgt = state
            .record_target
            .lock()
            .expect("record target mutex poisoned");
        let mut guard = state.edit.lock().expect("edit mutex poisoned");
        let st = &mut *guard;
        let armed_exists = tgt
            .0
            .is_some_and(|id| st.project.tracks.iter().any(|t| t.id == id));
        if !armed_exists {
            st.history.snapshot(&st.project);
            let name = format!("Track {}", st.project.tracks.len() + 1);
            tgt.0 = Some(st.project.add_track(name));
        }
    }

    Ok(path.to_string_lossy().to_string())
}

/// FR-2.2/2.5 — stop recording, finalize the WAV, and place it on the timeline.
#[tauri::command]
pub fn stop_recording(state: State<'_, AudioState>) -> Result<RecordingResult, String> {
    let (info, xrun) = {
        let guard = state.session.lock().expect("session mutex poisoned");
        let session = guard.as_ref().ok_or("no input device is open")?;
        let info = session.stop_recording().map_err(|e| e.to_string())?;
        (info, session.had_xrun())
    };
    *state
        .recording_path
        .lock()
        .expect("rec path mutex poisoned") = None;

    // A zero-length recording produces no useful clip — discard the empty file
    // rather than littering the timeline with an empty source.
    if info.frames == 0 {
        let _ = std::fs::remove_file(&info.path);
        return Err("recording captured no audio".into());
    }

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
    let (target_track, target_start) = *state
        .record_target
        .lock()
        .expect("record target mutex poisoned");
    let clip_len = info.frames;

    let (source_id, clip_id, start) = {
        let mut guard = state.edit.lock().expect("edit mutex poisoned");
        let st = &mut *guard;

        // Resolve where the take lands. Prefer the armed track at the playhead; if that
        // would overlap an existing clip (which would break the non-overlap invariant),
        // fall back to appending at the end of that track. With no armed track, append
        // to the first/new track (the pre-arming behavior).
        let armed = target_track.filter(|id| st.project.tracks.iter().any(|t| t.id == *id));
        let (track_id, start) = match armed {
            Some(tid) => {
                let track = st.project.tracks.iter().find(|t| t.id == tid).unwrap();
                let overlaps = track.clips.iter().any(|c| {
                    target_start < c.timeline_end() && c.timeline_start < target_start + clip_len
                });
                let start = if overlaps {
                    track
                        .clips
                        .iter()
                        .map(|c| c.timeline_end())
                        .max()
                        .unwrap_or(0)
                } else {
                    target_start
                };
                (Some(tid), start)
            }
            None => {
                let track_id = st.project.tracks.first().map(|t| t.id);
                let start = st
                    .project
                    .tracks
                    .first()
                    .and_then(|t| t.clips.iter().map(|c| c.timeline_end()).max())
                    .unwrap_or(0);
                (track_id, start)
            }
        };

        // Placing a take is an undoable edit.
        st.history.snapshot(&st.project);
        let (sid, cid) = st.project.add_recording(source, track_id, start);
        let _ = st.project.set_clip_name(cid, name.clone());
        (sid, cid, start)
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
        timeline_start: start,
        xrun,
    })
}

/// FR-3.1 — generate (or fetch) the waveform peak pyramid for a source, returned as
/// a compact binary blob (bypasses JSON, spec §4.3). See `peaks::encode_pyramid`.
#[tauri::command]
pub fn get_waveform_peaks(
    state: State<'_, AudioState>,
    source_id: String,
) -> Result<tauri::ipc::Response, String> {
    let path = {
        let guard = state.edit.lock().expect("edit mutex poisoned");
        guard
            .project
            .sources
            .iter()
            .find(|s| s.id.to_string() == source_id)
            .map(|s| s.path.clone())
            .ok_or("unknown source")?
    };
    let pyramid = waver_engine::generate_for_wav(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(waver_engine::encode_pyramid(
        &pyramid,
    )))
}

/// Return the current project view (spec FR-4.1).
#[tauri::command]
pub fn get_project(state: State<'_, AudioState>) -> ProjectView {
    let guard = state.edit.lock().expect("edit mutex poisoned");
    ProjectView::of(&guard.project, &guard.history)
}

/// FR-4.3 — split a clip at an absolute timeline frame.
#[tauri::command]
pub fn split_clip(
    state: State<'_, AudioState>,
    clip_id: String,
    frame: u64,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| p.split_clip(id, frame).map(|_| ()))
}

/// FR-4.4 — trim a clip's right edge to end at `frame`.
#[tauri::command]
pub fn trim_clip_end(
    state: State<'_, AudioState>,
    clip_id: String,
    frame: u64,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| p.trim_clip_end(id, frame))
}

/// FR-4.4 — trim a clip's left edge to start at `frame`.
#[tauri::command]
pub fn trim_clip_start(
    state: State<'_, AudioState>,
    clip_id: String,
    frame: u64,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| p.trim_clip_start(id, frame))
}

/// FR-4.2 — move a clip to a track + timeline position.
#[tauri::command]
pub fn move_clip(
    state: State<'_, AudioState>,
    clip_id: String,
    track_id: String,
    frame: u64,
) -> Result<ProjectView, String> {
    let cid = parse_id(&clip_id)?;
    let tid = parse_id(&track_id)?;
    apply_edit(&state, |p| p.move_clip(cid, tid, frame))
}

/// FR-4.5 — delete a clip (optionally ripple).
#[tauri::command]
pub fn delete_clip(
    state: State<'_, AudioState>,
    clip_id: String,
    ripple: bool,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| {
        if ripple {
            p.ripple_delete_clip(id)
        } else {
            p.delete_clip(id)
        }
    })
}

/// FR-4.6 — explode a multichannel clip into one mono clip per channel.
#[tauri::command]
pub fn split_clip_channels(
    state: State<'_, AudioState>,
    clip_id: String,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| p.split_clip_channels(id).map(|_| ()))
}

/// FR-5.2 — set a clip's gain in dB.
#[tauri::command]
pub fn set_clip_gain(
    state: State<'_, AudioState>,
    clip_id: String,
    gain_db: f32,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    apply_edit(&state, |p| p.set_clip_gain(id, gain_db))
}

/// FR-5.2 — set a track's gain in dB.
#[tauri::command]
pub fn set_track_gain(
    state: State<'_, AudioState>,
    track_id: String,
    gain_db: f32,
) -> Result<ProjectView, String> {
    let id = parse_id(&track_id)?;
    apply_edit(&state, |p| p.set_track_gain(id, gain_db))
}

/// FR-5.1 — set a clip's fade-in (length in frames + curve).
#[tauri::command]
pub fn set_clip_fade_in(
    state: State<'_, AudioState>,
    clip_id: String,
    len_frames: u64,
    curve: String,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    let c = parse_curve(&curve);
    apply_edit(&state, |p| p.set_clip_fade_in(id, len_frames, c))
}

/// FR-5.1 — set a clip's fade-out (length in frames + curve).
#[tauri::command]
pub fn set_clip_fade_out(
    state: State<'_, AudioState>,
    clip_id: String,
    len_frames: u64,
    curve: String,
) -> Result<ProjectView, String> {
    let id = parse_id(&clip_id)?;
    let c = parse_curve(&curve);
    apply_edit(&state, |p| p.set_clip_fade_out(id, len_frames, c))
}

/// Playback transport status (spec FR-6.1).
#[derive(Debug, Clone, Serialize)]
pub struct PlaybackStatus {
    pub playing: bool,
    pub paused: bool,
    pub position_frames: u64,
}

/// FR-6.1 — start playback from `from_frame` on the given output device. Any existing
/// playback is stopped first. Seeking during playback is a fresh `play` at the new
/// frame. An optional loop region repeats `[loop_start, loop_end)`.
#[tauri::command]
pub fn play(
    state: State<'_, AudioState>,
    device_id: String,
    from_frame: u64,
    loop_start: Option<u64>,
    loop_end: Option<u64>,
) -> Result<(), String> {
    // Stop any current playback (drop outside the guard hold below).
    let _ = state
        .playback
        .lock()
        .expect("playback mutex poisoned")
        .take();

    let loop_region = match (loop_start, loop_end) {
        (Some(s), Some(e)) if e > s => Some(LoopRegion { start: s, end: e }),
        _ => None,
    };
    let playback = {
        let guard = state.edit.lock().expect("edit mutex poisoned");
        waver_engine::start_playback(&guard.project, &device_id, from_frame, loop_region)
            .map_err(|e| e.to_string())?
    };
    *state.playback.lock().expect("playback mutex poisoned") = Some(playback);
    Ok(())
}

/// Preview a media-pool source through the output (Finder-style audition). Reuses the
/// playback slot, so stop_playback stops it.
#[tauri::command]
pub fn preview_source(
    state: State<'_, AudioState>,
    device_id: String,
    source_id: String,
) -> Result<(), String> {
    let sid = parse_id(&source_id)?;
    let source = {
        let g = state.edit.lock().expect("edit mutex poisoned");
        g.project.sources.iter().find(|s| s.id == sid).cloned()
    }
    .ok_or("no such source")?;
    let _ = state
        .playback
        .lock()
        .expect("playback mutex poisoned")
        .take();
    // A throwaway one-clip project at the source's own rate.
    let mut proj = Project::new(source.sample_rate);
    let tid = proj.add_track("preview");
    proj.add_recording(source, Some(tid), 0);
    let playback =
        waver_engine::start_playback(&proj, &device_id, 0, None).map_err(|e| e.to_string())?;
    *state.playback.lock().expect("playback mutex poisoned") = Some(playback);
    Ok(())
}

/// FR-6.1 — pause or resume playback.
#[tauri::command]
pub fn pause_playback(state: State<'_, AudioState>, paused: bool) {
    if let Some(pb) = state
        .playback
        .lock()
        .expect("playback mutex poisoned")
        .as_ref()
    {
        pb.set_paused(paused);
    }
}

/// FR-6.1 — stop playback.
#[tauri::command]
pub fn stop_playback(state: State<'_, AudioState>) {
    let _ = state
        .playback
        .lock()
        .expect("playback mutex poisoned")
        .take();
}

/// FR-6.1/6.2 — poll the transport status (playhead position tracks audible output).
#[tauri::command]
pub fn playback_status(state: State<'_, AudioState>) -> PlaybackStatus {
    let guard = state.playback.lock().expect("playback mutex poisoned");
    match guard.as_ref() {
        Some(pb) => PlaybackStatus {
            playing: pb.is_playing(),
            paused: pb.is_paused(),
            position_frames: pb.position(),
        },
        None => PlaybackStatus {
            playing: false,
            paused: false,
            position_frames: 0,
        },
    }
}

/// FR-7.1 — import an audio file: decode+transcode to a scratch WAV, then place it
/// on the timeline as a non-destructive clip (like a recording).
#[tauri::command]
pub fn import_audio(
    app: AppHandle,
    state: State<'_, AudioState>,
    path: String,
) -> Result<RecordingResult, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("imported");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let project_rate = {
        let guard = state.edit.lock().expect("edit mutex poisoned");
        guard.project.sample_rate
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("import");
    let scratch = dir.join(format!("{stem}-{stamp}.wav"));

    let info =
        waver_engine::import_file(&path, project_rate, &scratch).map_err(|e| e.to_string())?;
    if info.frames == 0 {
        return Err("imported file has no audio".into());
    }

    let _ = state.takes.fetch_add(1, Ordering::SeqCst);
    let import_name = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Import")
        .to_string();
    let source = Source::new(
        info.path.clone(),
        info.channels,
        info.sample_rate,
        info.frames,
    );
    let (source_id, clip_id, start) = {
        let mut guard = state.edit.lock().expect("edit mutex poisoned");
        let st = &mut *guard;
        let track_id = st.project.tracks.first().map(|t| t.id);
        let start = st
            .project
            .tracks
            .first()
            .and_then(|t| t.clips.iter().map(|c| c.timeline_end()).max())
            .unwrap_or(0);
        st.history.snapshot(&st.project);
        let (sid, cid) = st.project.add_recording(source, track_id, start);
        let _ = st.project.set_clip_name(cid, import_name.clone());
        (sid, cid, start)
    };

    Ok(RecordingResult {
        source_id: source_id.to_string(),
        clip_id: clip_id.to_string(),
        name: import_name,
        path: info.path.to_string_lossy().to_string(),
        channels: info.channels,
        sample_rate: info.sample_rate,
        frames: info.frames,
        duration_secs: info.frames as f64 / info.sample_rate.max(1) as f64,
        timeline_start: start,
        xrun: false,
    })
}

/// Import an audio file into the media pool (scratchpad) WITHOUT placing it on the
/// timeline. The source can then be dragged onto a track. Returns the updated project.
#[tauri::command]
pub fn import_to_pool(
    app: AppHandle,
    state: State<'_, AudioState>,
    path: String,
) -> Result<ProjectView, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("imported");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let project_rate = {
        let guard = state.edit.lock().expect("edit mutex poisoned");
        guard.project.sample_rate
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("import");
    let scratch = dir.join(format!("{stem}-{stamp}.wav"));

    let info =
        waver_engine::import_file(&path, project_rate, &scratch).map_err(|e| e.to_string())?;
    if info.frames == 0 {
        return Err("imported file has no audio".into());
    }

    let source = Source::new(info.path, info.channels, info.sample_rate, info.frames);
    let mut guard = state.edit.lock().expect("edit mutex poisoned");
    let st = &mut *guard;
    st.history.snapshot(&st.project);
    st.project.sources.push(source);
    Ok(ProjectView::of(&st.project, &st.history))
}

/// FR-7.2/7.3 — export/mixdown the project to a file.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportRequest {
    pub path: String,
    pub format: String,    // "wav" | "flac" | "ogg"
    pub bit_depth: String, // "int16" | "int24" | "float32"
    pub sample_rate: u32,
    pub channels: u16,
}

#[tauri::command]
pub fn export_project(state: State<'_, AudioState>, req: ExportRequest) -> Result<(), String> {
    let format = match req.format.as_str() {
        "flac" => ExportFormat::Flac,
        "ogg" => ExportFormat::Ogg,
        _ => ExportFormat::Wav,
    };
    let bit_depth = match req.bit_depth.as_str() {
        "int16" => BitDepth::Int16,
        "int24" => BitDepth::Int24,
        _ => BitDepth::Float32,
    };
    let opts = ExportOptions {
        format,
        sample_rate: req.sample_rate,
        bit_depth,
        channels: req.channels.max(1),
    };
    let project = {
        let guard = state.edit.lock().expect("edit mutex poisoned");
        guard.project.clone()
    };
    waver_engine::export_project(&project, opts, &req.path).map_err(|e| e.to_string())
}

/// A fresh project that always has one starter track (so New / first launch is never a
/// zero-track dead end).
fn new_project_with_track(sample_rate: u32) -> Project {
    let mut p = Project::new(sample_rate);
    p.add_track("Track 1");
    p
}

/// Reset to a fresh project (keeping the current sample rate) with one starter track.
/// Also stops any transport and clears the record target so no stale playback/recording
/// state points at clips that no longer exist.
#[tauri::command]
pub fn new_project(state: State<'_, AudioState>) -> ProjectView {
    let _ = state
        .playback
        .lock()
        .expect("playback mutex poisoned")
        .take();
    *state
        .record_target
        .lock()
        .expect("record target mutex poisoned") = (None, 0);
    *state
        .recording_path
        .lock()
        .expect("rec path mutex poisoned") = None;

    let mut guard = state.edit.lock().expect("edit mutex poisoned");
    let sr = guard.project.sample_rate;
    guard.project = new_project_with_track(sr);
    guard.history = History::default();
    ProjectView::of(&guard.project, &guard.history)
}

/// FR-8.1 — save the project (JSON referencing source paths) to `path`.
#[tauri::command]
pub fn save_project(state: State<'_, AudioState>, path: String) -> Result<(), String> {
    let project = {
        let guard = state.edit.lock().expect("edit mutex poisoned");
        guard.project.clone()
    };
    let json = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    // Write atomically: write to a temp file next to the target, then rename, so an
    // interrupted/partial write can't destroy an existing project file.
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Result of loading a project: the view + any source files that are now missing.
#[derive(Debug, Clone, Serialize)]
pub struct LoadResult {
    pub project: ProjectView,
    pub missing_sources: Vec<String>,
}

/// FR-8.1 — load a project from `path`, replacing the current one. Missing source
/// files are reported per-source rather than failing the load.
#[tauri::command]
pub fn load_project(state: State<'_, AudioState>, path: String) -> Result<LoadResult, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let project: Project = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    // Reject a structurally-invalid project (overlapping clips, out-of-bounds ranges,
    // dangling source ids) so it can't bypass the §3 invariants every edit enforces.
    // Missing source *files* are a separate, soft condition reported below.
    project
        .validate()
        .map_err(|e| format!("invalid project: {e}"))?;
    let missing_sources: Vec<String> = project
        .sources
        .iter()
        .filter(|s| !s.path.exists())
        .map(|s| s.path.to_string_lossy().to_string())
        .collect();

    let view = {
        let mut guard = state.edit.lock().expect("edit mutex poisoned");
        guard.project = project;
        guard.history = History::default();
        ProjectView::of(&guard.project, &guard.history)
    };
    Ok(LoadResult {
        project: view,
        missing_sources,
    })
}

/// FR-6.1 — mute/unmute a track.
#[tauri::command]
pub fn set_track_muted(
    state: State<'_, AudioState>,
    track_id: String,
    muted: bool,
) -> Result<ProjectView, String> {
    let id = parse_id(&track_id)?;
    apply_edit(&state, |p| p.set_track_muted(id, muted))
}

/// FR-6.1 — solo/unsolo a track.
#[tauri::command]
pub fn set_track_soloed(
    state: State<'_, AudioState>,
    track_id: String,
    soloed: bool,
) -> Result<ProjectView, String> {
    let id = parse_id(&track_id)?;
    apply_edit(&state, |p| p.set_track_soloed(id, soloed))
}

/// FR-4.7 — undo the last edit.
#[tauri::command]
pub fn undo(state: State<'_, AudioState>) -> ProjectView {
    let mut guard = state.edit.lock().expect("edit mutex poisoned");
    let st = &mut *guard;
    st.history.undo(&mut st.project);
    ProjectView::of(&st.project, &st.history)
}

/// FR-4.7 — redo the last undone edit.
#[tauri::command]
pub fn redo(state: State<'_, AudioState>) -> ProjectView {
    let mut guard = state.edit.lock().expect("edit mutex poisoned");
    let st = &mut *guard;
    st.history.redo(&mut st.project);
    ProjectView::of(&st.project, &st.history)
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
