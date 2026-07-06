// File dialogs for import / export / save / load, backed by the Tauri dialog plugin.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { ProjectView } from "./project";
import type { RecordingResult } from "./types";

const AUDIO_EXTS = ["wav", "flac", "mp3", "ogg", "aac", "m4a", "aiff", "aif"];

/** FR-7.1 — pick an audio file and import it onto the timeline. */
export async function importAudioDialog(): Promise<RecordingResult | null> {
  const path = await open({
    multiple: false,
    filters: [{ name: "Audio", extensions: AUDIO_EXTS }],
  });
  if (typeof path !== "string") return null;
  return invoke<RecordingResult>("import_audio", { path });
}

export type ExportFormat = "wav" | "flac" | "ogg";
export type ExportBitDepth = "int16" | "int24" | "float32";

/** FR-7.2/7.3 — pick a destination and export/mixdown. Returns the path, or null. */
export async function exportProjectDialog(
  format: ExportFormat,
  bitDepth: ExportBitDepth,
  sampleRate: number,
  channels: number,
): Promise<string | null> {
  const ext = format;
  const path = await save({
    defaultPath: `mixdown.${ext}`,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
  });
  if (typeof path !== "string") return null;
  await invoke("export_project", {
    req: {
      path,
      format,
      bit_depth: bitDepth,
      sample_rate: sampleRate,
      channels,
    },
  });
  return path;
}

/** FR-8.1 — save the project. */
export async function saveProjectDialog(): Promise<string | null> {
  const path = await save({
    defaultPath: "project.wvproj",
    filters: [{ name: "Waver project", extensions: ["wvproj", "json"] }],
  });
  if (typeof path !== "string") return null;
  await invoke("save_project", { path });
  return path;
}

export interface LoadResult {
  project: ProjectView;
  missing_sources: string[];
}

/** FR-8.1 — open a saved project. */
export async function loadProjectDialog(): Promise<LoadResult | null> {
  const path = await open({
    multiple: false,
    filters: [{ name: "Waver project", extensions: ["wvproj", "json"] }],
  });
  if (typeof path !== "string") return null;
  return invoke<LoadResult>("load_project", { path });
}
