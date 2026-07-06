// Thin typed wrappers over the Tauri command + Channel surface.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AudioSettings,
  DeviceInfo,
  HostInfo,
  MeterUpdate,
  RecordingResult,
  StreamParams,
} from "./types";

export function listDevices(): Promise<DeviceInfo[]> {
  return invoke<DeviceInfo[]>("list_devices");
}

export function listHosts(): Promise<HostInfo[]> {
  return invoke<HostInfo[]>("list_hosts");
}

export function loadSettings(): Promise<AudioSettings> {
  return invoke<AudioSettings>("load_settings");
}

export function saveSettings(settings: AudioSettings): Promise<void> {
  return invoke("save_settings", { settings });
}

/**
 * Open a live input session. Metering `onUpdate` fires ~80x/second until
 * {@link closeInput}. Recording can then be toggled on the open session.
 * Returns once the backend confirms the stream started (or rejects).
 */
export async function openInput(
  deviceId: string,
  params: StreamParams,
  onUpdate: (u: MeterUpdate) => void,
): Promise<void> {
  const channel = new Channel<MeterUpdate>();
  channel.onmessage = onUpdate;
  await invoke("open_input", { deviceId, params, channel });
}

export function closeInput(): Promise<void> {
  return invoke("close_input");
}

/** The buffer size (frames/callback) the open input actually resolved to, or null. */
export function inputBufferFrames(): Promise<number | null> {
  return invoke<number | null>("input_buffer_frames");
}

/** Start recording the open input to a fresh WAV. Resolves with its path. */
export function startRecording(): Promise<string> {
  return invoke<string>("start_recording");
}

/** Stop recording; resolves with the take placed on the timeline. */
export function stopRecording(): Promise<RecordingResult> {
  return invoke<RecordingResult>("stop_recording");
}
