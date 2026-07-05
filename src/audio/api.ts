// Thin typed wrappers over the Tauri command + Channel surface.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AudioSettings,
  DeviceInfo,
  HostInfo,
  MeterUpdate,
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
 * Start live input metering. `onUpdate` fires ~50x/second until {@link stopMetering}
 * is called. Returns once the backend confirms the stream started (or rejects).
 */
export async function startMetering(
  deviceId: string,
  params: StreamParams,
  onUpdate: (u: MeterUpdate) => void,
): Promise<void> {
  const channel = new Channel<MeterUpdate>();
  channel.onmessage = onUpdate;
  await invoke("start_metering", { deviceId, params, channel });
}

export function stopMetering(): Promise<void> {
  return invoke("stop_metering");
}
