// Fetch + parse the waveform peak pyramid delivered as raw bytes (see
// waver_engine::peaks::encode_pyramid). Binary layout, little-endian:
//   u32 num_levels
//   per level: u32 frames_per_bucket, u16 channels, u32 num_buckets,
//              f32[num_buckets*channels] mins, f32[num_buckets*channels] maxs

import { invoke } from "@tauri-apps/api/core";

export interface PeakLevel {
  framesPerBucket: number;
  channels: number;
  numBuckets: number;
  mins: Float32Array;
  maxs: Float32Array;
}

export interface PeakPyramid {
  levels: PeakLevel[]; // coarsest first
}

export function parsePyramid(buffer: ArrayBuffer): PeakPyramid {
  const view = new DataView(buffer);
  let off = 0;
  const numLevels = view.getUint32(off, true);
  off += 4;
  const levels: PeakLevel[] = [];
  for (let l = 0; l < numLevels; l++) {
    const framesPerBucket = view.getUint32(off, true);
    off += 4;
    const channels = view.getUint16(off, true);
    off += 2;
    const numBuckets = view.getUint32(off, true);
    off += 4;
    const count = numBuckets * channels;
    // Copy (the underlying buffer offset may be unaligned for Float32Array views).
    const mins = new Float32Array(count);
    const maxs = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      mins[i] = view.getFloat32(off + i * 4, true);
    }
    off += count * 4;
    for (let i = 0; i < count; i++) {
      maxs[i] = view.getFloat32(off + i * 4, true);
    }
    off += count * 4;
    levels.push({ framesPerBucket, channels, numBuckets, mins, maxs });
  }
  return { levels };
}

/**
 * Pick the pyramid level whose bucket size best matches the current zoom
 * (`framesPerPixel`). Choose the finest level that is still >= framesPerPixel so we
 * never upsample below one bucket per pixel, falling back to the finest available.
 */
export function pickLevel(
  pyramid: PeakPyramid,
  framesPerPixel: number,
): PeakLevel | null {
  if (pyramid.levels.length === 0) return null;
  // levels are coarsest-first; the finest is last.
  let chosen = pyramid.levels[pyramid.levels.length - 1];
  for (const level of pyramid.levels) {
    if (level.framesPerBucket <= framesPerPixel) {
      chosen = level;
      break;
    }
  }
  return chosen;
}

const cache = new Map<string, PeakPyramid>();

export async function fetchPeaks(sourceId: string): Promise<PeakPyramid> {
  const cached = cache.get(sourceId);
  if (cached) return cached;
  const buffer = await invoke<ArrayBuffer>("get_waveform_peaks", { sourceId });
  const pyramid = parsePyramid(buffer);
  cache.set(sourceId, pyramid);
  return pyramid;
}
