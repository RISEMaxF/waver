// TypeScript mirrors of the Rust IPC wire types (waver-core::engine).
// Field names are snake_case to match serde's default serialization.

export type DeviceDirection = "input" | "output";

export interface DeviceInfo {
  id: string;
  name: string;
  host: string;
  direction: DeviceDirection;
  is_default: boolean;
  channels: number[];
  sample_rates: number[];
}

export interface HostInfo {
  name: string;
  is_default: boolean;
}

export interface StreamParams {
  sample_rate: number;
  channels: number;
  buffer_frames: number | null;
}

export interface ChannelLevel {
  peak_dbfs: number;
  rms_dbfs: number;
}

export interface MeterUpdate {
  channels: ChannelLevel[];
}

export interface AudioSettings {
  input_device_id: string | null;
  output_device_id: string | null;
  sample_rate: number | null;
  buffer_frames: number | null;
}

export interface RecordingResult {
  source_id: string;
  clip_id: string;
  name: string;
  path: string;
  channels: number;
  sample_rate: number;
  frames: number;
  duration_secs: number;
  timeline_start: number;
  xrun: boolean;
}
