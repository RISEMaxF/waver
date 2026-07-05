// Project view types (mirror of src-tauri ProjectView) + edit command wrappers.

import { invoke } from "@tauri-apps/api/core";

export interface ClipView {
  id: string;
  source_id: string;
  source_channel: number | null;
  source_in: number;
  source_out: number;
  timeline_start: number;
  gain_db: number;
  fade_in_len: number;
  fade_out_len: number;
}

export interface TrackView {
  id: string;
  name: string;
  gain_db: number;
  muted: boolean;
  soloed: boolean;
  clips: ClipView[];
}

export interface SourceView {
  id: string;
  channels: number;
  sample_rate: number;
  frames: number;
}

export interface ProjectView {
  sample_rate: number;
  can_undo: boolean;
  can_redo: boolean;
  tracks: TrackView[];
  sources: SourceView[];
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
export const deleteClip = (clipId: string, ripple: boolean) =>
  invoke<ProjectView>("delete_clip", { clipId, ripple });
export const splitClipChannels = (clipId: string) =>
  invoke<ProjectView>("split_clip_channels", { clipId });
export const setClipGain = (clipId: string, gainDb: number) =>
  invoke<ProjectView>("set_clip_gain", { clipId, gainDb });
export const setTrackGain = (trackId: string, gainDb: number) =>
  invoke<ProjectView>("set_track_gain", { trackId, gainDb });
export const undo = () => invoke<ProjectView>("undo");
export const redo = () => invoke<ProjectView>("redo");
