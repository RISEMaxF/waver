// Pure timeline-canvas rendering: geometry constants, theme resolution, and the
// draw helpers. No React, no component state — everything takes its inputs as args,
// so it's testable and reusable independent of the WaveformTimeline component.

import type { ClipView, ProjectView } from "../../audio/project";
import { pickLevel, type PeakLevel, type PeakPyramid } from "../../audio/peaks";

// Per-track identity colors (Ableton-style): headers show a strip, clips take a tint.
export const TRACK_COLORS = [
  "#4cc2ff",
  "#7ee787",
  "#ffa657",
  "#d2a8ff",
  "#f778ba",
  "#ffd966",
  "#79c0ff",
  "#56d364",
];
export function trackColor(index: number): string {
  return TRACK_COLORS[
    ((index % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length
  ];
}

// ---- geometry ----
export const TRACK_HEIGHT = 98;
export const RULER_HEIGHT = 22;
export const EDGE_PX = 6;
export const SNAP_PX = 8;
export const MIN_PPS = 2;
export const MAX_PPS = 6000;

// ---- theme (resolved from CSS design tokens) ----
export interface CanvasTheme {
  bg: string;
  ruler: string;
  grid: string;
  lane: string;
  laneAlt: string;
  clip: string;
  clipSel: string;
  clipEdge: string;
  clipEdgeSel: string;
  wave: string;
  waveSel: string;
  playhead: string;
  snap: string;
  fadeFill: string;
}

// The canvas can't read CSS variables directly, so resolve the --wave-* design
// tokens (src/styles/tokens.css) via getComputedStyle. Recompute on theme change so a
// rebrand or light/dark swap flows to the timeline automatically.
export function readCanvasTheme(): CanvasTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fallback: string) =>
    cs.getPropertyValue(n).trim() || fallback;
  return {
    bg: v("--color-surface", "#0e1116"),
    ruler: v("--wave-ruler", "#8b97a6"),
    grid: v("--wave-grid", "#1c232e"),
    lane: v("--wave-lane", "#12161c"),
    laneAlt: v("--wave-lane-alt", "#0f1319"),
    clip: v("--wave-clip", "#16324a"),
    clipSel: v("--wave-clip-sel", "#1d4a6b"),
    clipEdge: v("--wave-clip-edge", "#2b6a93"),
    clipEdgeSel: v("--wave-clip-edge-sel", "#4cc2ff"),
    wave: v("--wave", "#4cc2ff"),
    waveSel: v("--wave-sel", "#8fd6ff"),
    playhead: v("--wave-playhead", "#f85149"),
    snap: v("--wave-snap", "#d29922"),
    fadeFill: v("--wave-fade-fill", "rgba(14,17,22,0.55)"),
  };
}

// ---- helpers ----

/** fade-in gain shape — mirror of waver_core::FadeCurve::fade_in_gain. */
export function fadeGain(curve: string, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  if (curve === "equal_power") return Math.sin((c * Math.PI) / 2);
  if (curve === "log") return c * c;
  return c;
}

export function fmtTime(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const dp = step < 1 ? 2 : 0;
  return m > 0
    ? `${m}:${s.toFixed(dp).padStart(dp ? 5 : 2, "0")}`
    : `${s.toFixed(dp)}s`;
}

export function findClip(
  project: ProjectView,
  id: string,
): ClipView | undefined {
  for (const t of project.tracks) {
    const c = t.clips.find((c) => c.id === id);
    if (c) return c;
  }
  return undefined;
}

export function laneTopForY(
  y: number,
  project: ProjectView | null,
): number | null {
  if (!project) return null;
  const ti = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
  if (ti < 0 || ti >= project.tracks.length) return null;
  return RULER_HEIGHT + ti * TRACK_HEIGHT + 4;
}

export function drawFade(
  ctx: CanvasRenderingContext2D,
  side: "in" | "out",
  curve: string,
  fadeFrames: number,
  sr: number,
  pps: number,
  x0: number,
  top: number,
  w: number,
  laneH: number,
  th: CanvasTheme,
) {
  if (fadeFrames <= 0) return;
  const fadeW = Math.min(w, (fadeFrames / sr) * pps);
  if (fadeW < 1) return;
  const steps = Math.max(2, Math.min(200, Math.floor(fadeW)));
  const bottom = top + laneH;
  // Endpoint of the fade at the top edge (the grab handle sits here).
  const handleX = side === "in" ? x0 + fadeW : x0 + w - fadeW;

  // Shade the removed corner (above the rising / falling curve) so the fade reads at a
  // glance, Ableton/Audacity-style.
  ctx.beginPath();
  if (side === "in") {
    ctx.moveTo(x0, bottom);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(x0 + t * fadeW, bottom - fadeGain(curve, t) * laneH);
    }
    ctx.lineTo(x0 + fadeW, top);
    ctx.lineTo(x0, top);
  } else {
    const xr = x0 + w;
    ctx.moveTo(xr - fadeW, top);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(
        xr - fadeW + t * fadeW,
        bottom - fadeGain(curve, 1 - t) * laneH,
      );
    }
    ctx.lineTo(xr, top);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(8, 10, 14, 0.55)"; // darken the attenuated region
  ctx.fill();

  // The fade curve line itself — bright and crisp over any clip color.
  ctx.beginPath();
  if (side === "in") {
    ctx.moveTo(x0, bottom);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(x0 + t * fadeW, bottom - fadeGain(curve, t) * laneH);
    }
  } else {
    const xr = x0 + w;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(
        xr - fadeW + t * fadeW,
        bottom - fadeGain(curve, 1 - t) * laneH,
      );
    }
  }
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.lineWidth = 1.75;
  ctx.stroke();

  // Grab handle at the top corner.
  ctx.beginPath();
  ctx.arc(handleX, top + 1.5, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = th.clipEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Per-source display gain, cached: fit the loudest sample to ~90% of the lane so quiet
// recordings are visible, clamped so a near-silent take doesn't amplify the noise floor
// to full scale. Computed from the coarsest (cheapest) pyramid level.
const gainCache = new WeakMap<PeakPyramid, number>();
export function waveDisplayGain(pyramid: PeakPyramid): number {
  const cached = gainCache.get(pyramid);
  if (cached !== undefined) return cached;
  const lvl = pyramid.levels[0];
  let peak = 0;
  if (lvl) {
    for (let i = 0; i < lvl.mins.length; i++) {
      const a = Math.max(Math.abs(lvl.mins[i]), Math.abs(lvl.maxs[i]));
      if (a > peak) peak = a;
    }
  }
  const g = peak > 0.0001 ? Math.min(12, 0.9 / peak) : 1;
  gainCache.set(pyramid, g);
  return g;
}

export function drawClipWave(
  ctx: CanvasRenderingContext2D,
  pyramid: PeakPyramid,
  clip: ClipView,
  x0: number,
  top: number,
  w: number,
  laneH: number,
  pps: number,
  sr: number,
  selected: boolean,
  viewWidth: number,
  th: CanvasTheme,
  waveColor?: string,
) {
  const framesPerPixel = sr / pps;
  const level: PeakLevel | null = pickLevel(pyramid, framesPerPixel);
  if (!level) return;
  const srcCh = level.channels;
  // If a single channel was split out, draw only that channel full-height.
  const only = clip.source_channel;
  const drawChannels =
    only == null ? Array.from({ length: srcCh }, (_, i) => i) : [only];
  const perChanH = laneH / drawChannels.length;

  const gain = waveDisplayGain(pyramid);
  const pxStart = Math.max(0, Math.floor(x0));
  const pxEnd = Math.min(viewWidth, Math.ceil(x0 + w));

  // Multichannel: split into per-channel sub-lanes with a divider + L/R (or n) labels,
  // the way Audacity stacks stereo channels.
  if (drawChannels.length > 1) {
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    for (let k = 1; k < drawChannels.length; k++) {
      const y = Math.round(top + k * perChanH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(Math.min(viewWidth, x0 + w), y);
      ctx.stroke();
    }
    ctx.fillStyle = th.ruler;
    ctx.font = "9px system-ui, sans-serif";
    const labels = drawChannels.length === 2 ? ["L", "R"] : null;
    drawChannels.forEach((_c, laneIdx) => {
      const label = labels ? labels[laneIdx] : String(laneIdx + 1);
      ctx.fillText(label, x0 + 3, top + laneIdx * perChanH + 10);
    });
  }

  ctx.fillStyle = selected ? th.waveSel : (waveColor ?? th.wave);

  for (let px = pxStart; px < pxEnd; px++) {
    const clipFrame = (px - x0) * framesPerPixel;
    const srcFrame = clip.source_in + clipFrame;
    if (srcFrame < clip.source_in || srcFrame >= clip.source_out) continue;
    const b0 = Math.floor(srcFrame / level.framesPerBucket);
    const b1 = Math.max(
      b0,
      Math.floor((srcFrame + framesPerPixel) / level.framesPerBucket),
    );

    drawChannels.forEach((c, laneIdx) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let b = b0; b <= b1 && b < level.numBuckets; b++) {
        lo = Math.min(lo, level.mins[b * srcCh + c]);
        hi = Math.max(hi, level.maxs[b * srcCh + c]);
      }
      if (!isFinite(lo)) return;
      const h = Math.max(-1, Math.min(1, hi * gain));
      const l = Math.max(-1, Math.min(1, lo * gain));
      const mid = top + laneIdx * perChanH + perChanH / 2;
      const y1 = mid - h * (perChanH / 2) * 0.95;
      const y2 = mid - l * (perChanH / 2) * 0.95;
      ctx.fillRect(px, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
    });
  }
}
