// Project view types (mirror of src-tauri ProjectView) + edit command wrappers.

import { invoke } from "@tauri-apps/api/core";

export interface ClipView {
  id: string;
  name: string;
  source_id: string;
  source_channel: number | null;
  source_in: number;
  source_out: number;
  timeline_start: number;
  gain_db: number;
  fade_in_len: number;
  fade_out_len: number;
  fade_in_curve: string;
  fade_out_curve: string;
  group: string | null;
  locked: boolean;
}

export type FadeCurve = "linear" | "equal_power" | "log" | "s_curve";

export interface TrackView {
  id: string;
  name: string;
  gain_db: number;
  muted: boolean;
  soloed: boolean;
  color: string | null;
  clips: ClipView[];
}

export interface SourceView {
  id: string;
  channels: number;
  sample_rate: number;
  frames: number;
  path: string;
}

export interface MarkerView {
  id: string;
  name: string;
  frame: number;
}

export interface ProjectView {
  sample_rate: number;
  can_undo: boolean;
  can_redo: boolean;
  tracks: TrackView[];
  sources: SourceView[];
  markers: MarkerView[];
}

export const getProject = () => invoke<ProjectView>("get_project");
export const splitClip = (clipId: string, frame: number) =>
  invoke<ProjectView>("split_clip", { clipId, frame });
export const trimClipEnd = (clipId: string, frame: number) =>
  invoke<ProjectView>("trim_clip_end", { clipId, frame });
export const trimClipStart = (clipId: string, frame: number) =>
  invoke<ProjectView>("trim_clip_start", { clipId, frame });
export const moveClip = (clipId: string, trackId: string, frame: number) =>
  invoke<ProjectView>("move_clip", { clipId, trackId, frame });
export const addMarker = (frame: number, name: string) =>
  invoke<ProjectView>("add_marker", { frame, name });
export const moveMarker = (markerId: string, frame: number) =>
  invoke<ProjectView>("move_marker", { markerId, frame });
export const renameMarker = (markerId: string, name: string) =>
  invoke<ProjectView>("rename_marker", { markerId, name });
export const deleteMarker = (markerId: string) =>
  invoke<ProjectView>("delete_marker", { markerId });
export const groupClips = (clipIds: string[]) =>
  invoke<ProjectView>("group_clips", { clipIds });
export const ungroupClips = (clipIds: string[]) =>
  invoke<ProjectView>("ungroup_clips", { clipIds });
export const setClipsLocked = (clipIds: string[], locked: boolean) =>
  invoke<ProjectView>("set_clips_locked", { clipIds, locked });
export const moveClips = (clipIds: string[], delta: number) =>
  invoke<ProjectView>("move_clips", { clipIds, delta });
export const deleteClips = (clipIds: string[]) =>
  invoke<ProjectView>("delete_clips", { clipIds });
export const mergeClips = (clipIds: string[]) =>
  invoke<ProjectView>("merge_clips", { clipIds });
export const deleteRange = (start: number, end: number, ripple: boolean) =>
  invoke<ProjectView>("delete_range", { start, end, ripple });
export const deleteClip = (clipId: string, ripple: boolean) =>
  invoke<ProjectView>("delete_clip", { clipId, ripple });
export const splitClipChannels = (clipId: string) =>
  invoke<ProjectView>("split_clip_channels", { clipId });
export const setClipGain = (clipId: string, gainDb: number) =>
  invoke<ProjectView>("set_clip_gain", { clipId, gainDb });
export const setTrackGain = (trackId: string, gainDb: number) =>
  invoke<ProjectView>("set_track_gain", { trackId, gainDb });
export const setTrackMuted = (trackId: string, muted: boolean) =>
  invoke<ProjectView>("set_track_muted", { trackId, muted });
export const setTrackSoloed = (trackId: string, soloed: boolean) =>
  invoke<ProjectView>("set_track_soloed", { trackId, soloed });
export const setTrackName = (trackId: string, name: string) =>
  invoke<ProjectView>("set_track_name", { trackId, name });
export const setTrackColor = (trackId: string, color: string | null) =>
  invoke<ProjectView>("set_track_color", { trackId, color });
export const addTrack = () => invoke<ProjectView>("add_track");
export const removeTrack = (trackId: string) =>
  invoke<ProjectView>("remove_track", { trackId });
export const duplicateClip = (clipId: string, timelineStart: number) =>
  invoke<ProjectView>("duplicate_clip", { clipId, timelineStart });
export const setClipName = (clipId: string, name: string) =>
  invoke<ProjectView>("set_clip_name", { clipId, name });
/** A clip's paste spec — every ClipView field except its id. */
export type ClipSpec = Omit<ClipView, "id" | "group" | "locked">;
export const pasteClip = (spec: ClipSpec, trackId: string) =>
  invoke<ProjectView>("paste_clip", { spec, trackId });
export const setRecordTarget = (trackId: string | null, startFrame: number) =>
  invoke<void>("set_record_target", { trackId, startFrame });
export const setClipFadeIn = (
  clipId: string,
  lenFrames: number,
  curve: FadeCurve,
) => invoke<ProjectView>("set_clip_fade_in", { clipId, lenFrames, curve });
export const setClipFadeOut = (
  clipId: string,
  lenFrames: number,
  curve: FadeCurve,
) => invoke<ProjectView>("set_clip_fade_out", { clipId, lenFrames, curve });
export interface PlaybackStatus {
  playing: boolean;
  paused: boolean;
  position_frames: number;
}

export const play = (
  deviceId: string,
  fromFrame: number,
  loopStart?: number,
  loopEnd?: number,
  speed?: number,
  preservePitch?: boolean,
) =>
  invoke("play", {
    deviceId,
    fromFrame,
    loopStart: loopStart ?? null,
    loopEnd: loopEnd ?? null,
    speed: speed ?? null,
    preservePitch: preservePitch ?? null,
  });
export const pausePlayback = (paused: boolean) =>
  invoke("pause_playback", { paused });
export const stopPlayback = () => invoke("stop_playback");
export const previewSource = (deviceId: string, sourceId: string) =>
  invoke<void>("preview_source", { deviceId, sourceId });
export const playbackStatus = () => invoke<PlaybackStatus>("playback_status");
export const autosaveProject = () => invoke("autosave_project");
export const syncPlayback = () => invoke("sync_playback");
export const checkRecovery = () => invoke<string | null>("check_recovery");
export const discardRecovery = () => invoke("discard_recovery");
/** Nearest zero crossing to `frame` (source frames) — click-free edit points. */
export const zeroCrossing = (sourceId: string, frame: number) =>
  invoke<number>("zero_crossing", { sourceId, frame });
/** Master output peaks (linear, per channel) since the last poll; [] when idle. */
export const playbackLevels = () => invoke<number[]>("playback_levels");

export const undo = () => invoke<ProjectView>("undo");
export const redo = () => invoke<ProjectView>("redo");
