import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ClipSpec,
  ClipView,
  FadeCurve,
  ProjectView,
} from "../audio/project";
import type { ChannelLevel } from "../audio/types";
import { setRecordTarget } from "../audio/project";
import type { ProjectApi } from "../audio/useProject";
import { useTransport } from "../audio/useTransport";
import { fetchPeaks, type PeakPyramid } from "../audio/peaks";
import { Inspector } from "./timeline/Inspector";
import { TrackHeaders } from "./timeline/TrackHeaders";
import {
  IconChannels,
  IconClose,
  IconCopy,
  IconCut,
  IconDuplicate,
  IconFit,
  IconFoldAll,
  IconFollow,
  IconGrid,
  IconHelp,
  IconMagnet,
  IconPaste,
  IconPause,
  IconPlay,
  IconPlus,
  IconRedo,
  IconSplit,
  IconStop,
  IconTrash,
  IconUndo,
  IconZoomIn,
  IconZoomOut,
  IconZoomSel,
} from "./icons";
import {
  drawClipWave,
  drawFade,
  findClip,
  fmtTime,
  readCanvasTheme,
  type CanvasTheme,
  EDGE_PX,
  MAX_PPS,
  MIN_PPS,
  RULER_HEIGHT,
  SNAP_PX,
  TRACK_HEIGHT,
  COLLAPSED_H,
  fmtTimecode,
  labelColorFor,
  trackColor,
} from "./timeline/renderer";

// hex "#rrggbb" -> "rgba(r,g,b,a)" for translucent canvas fills.
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Live recording waveform buffer, timestamped from record start (see useAudio). */
export type RecWaveRef = React.MutableRefObject<{
  start: number;
  buckets: { t: number; min: number; max: number }[];
}>;

interface Props {
  project: ProjectView | null;
  api: ProjectApi;
  outputId: string | null;
  recording: boolean;
  canRecord: boolean;
  onToggleRecord: () => void;
  recElapsed: number;
  recWave: RecWaveRef;
  recordTargetRef: React.MutableRefObject<{
    trackId: string | null;
    startFrame: number;
  }>;
  /** Most recent committed take (select + reveal it; W-06). */
  lastTake: { clipId: string; seq: number } | null;
  /** Transient, non-blocking feedback (relocations, dead clipboard; W-08). */
  onNotice: (msg: string) => void;
  /** Live input levels for the armed track's mini meter (W-12). */
  inputLevels: ChannelLevel[];
}

type Drag =
  | { kind: "move"; clipId: string; grabSec: number }
  | { kind: "trim-start"; clipId: string }
  | { kind: "trim-end"; clipId: string }
  | { kind: "fade-in"; clipId: string }
  | { kind: "fade-out"; clipId: string }
  | { kind: "scrub" }
  | null;

type Zone = "trim-start" | "trim-end" | "fade-in" | "fade-out" | "body";

const FADE_ZONE_PX = 22;

// Cumulative lane tops (0-based — the ruler is a separate sticky canvas). Collapsed
// tracks are short. Returns the top y of each track and the total lanes height.
function laneLayout(tracks: ProjectView["tracks"], collapsed: Set<string>) {
  const tops: number[] = [];
  let acc = 0;
  for (const t of tracks) {
    tops.push(acc);
    acc += collapsed.has(t.id) ? COLLAPSED_H : TRACK_HEIGHT;
  }
  return { tops, total: acc || TRACK_HEIGHT };
}

// bar.beat.step position at `sec` for a 4/4 grid at `bpm` (F12).
function barsBeats(sec: number, bpm: number, stepSec: number): string {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const bar = Math.floor(sec / barSec) + 1;
  const beat = Math.floor((sec % barSec) / beatSec) + 1;
  const step = Math.floor((sec % beatSec) / stepSec) + 1;
  return `${bar}.${beat}.${step}`;
}

function nextCurve(c: FadeCurve): FadeCurve {
  return c === "linear"
    ? "equal_power"
    : c === "equal_power"
      ? "log"
      : "linear";
}

export function WaveformTimeline({
  project,
  api,
  outputId,
  recording,
  canRecord,
  onToggleRecord,
  recElapsed,
  recWave,
  recordTargetRef,
  lastTake,
  onNotice,
  inputLevels,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const peaks = useRef<Map<string, PeakPyramid>>(new Map());
  const drag = useRef<Drag>(null);
  const mouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const snapLine = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const theme = useRef<CanvasTheme>(readCanvasTheme());
  const [width, setWidth] = useState(800);
  const [pps, setPps] = useState(120);
  const [scrollSec, setScrollSec] = useState(0);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [ripple, setRipple] = useState(false);
  const [cursor, setCursor] = useState("default");
  // null = unset (auto-arm picks a track); "none" = the user disarmed on purpose (W-07).
  const [armedTrackId, setArmedTrackId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rulerRef = useRef<HTMLCanvasElement>(null);
  // Beat grid (Ableton-style): a toggleable background grid the playhead + edits snap to.
  const [beatGrid, setBeatGrid] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [gridDiv, setGridDiv] = useState(4); // steps per beat (4 = sixteenth notes)
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const altBypass = useRef(false); // Alt held during a drag momentarily disables snap
  const [, tick] = useState(0);
  // Snapshot of where/when the current recording began (for the live overlay).
  const recStartSec = useRef(0);
  const recTrackId = useRef<string | null>(null);
  const prevRecording = useRef(false);

  const sr = project?.sample_rate ?? 48000;
  const clipLen = (c: ClipView) => c.source_out - c.source_in;

  // Beat grid: seconds per step (subdivision). 4/4 assumed. `snapToGrid` rounds a time
  // to the nearest step when the grid is on (used for the playhead + edit snapping).
  const stepSec = 60 / bpm / gridDiv;
  const snapToGrid = useCallback(
    (sec: number) =>
      snapEnabled && beatGrid ? Math.round(sec / stepSec) * stepSec : sec,
    [snapEnabled, beatGrid, stepSec],
  );

  const { playing, paused, startPlay, togglePause, stopPlay, seek } =
    useTransport({
      outputId,
      hasContent: !!project && project.tracks.length > 0,
      startFrame: Math.round(playheadSec * sr),
      sr,
      onPosition: setPlayheadSec,
    });

  // Default-arm the first track (and re-arm when the armed one is deleted) so recording
  // lands on an existing track instead of spawning a new one every take. Arming another
  // track's R button overrides this.
  useEffect(() => {
    if (armedTrackId === "none") return; // explicit disarm sticks (W-07)
    const ids = project?.tracks.map((t) => t.id) ?? [];
    if (armedTrackId && ids.includes(armedTrackId)) return;
    setArmedTrackId(ids[0] ?? null);
  }, [project, armedTrackId]);
  const effArmedId = armedTrackId === "none" ? null : armedTrackId;

  // Keep the shared record target fresh (App commits it synchronously at record time),
  // and mirror it to the backend continuously except while playing/recording.
  useEffect(() => {
    recordTargetRef.current = {
      trackId: effArmedId,
      startFrame: Math.round(playheadSec * sr),
    };
    if (playing || recording) return;
    setRecordTarget(effArmedId, Math.round(playheadSec * sr)).catch(() => {});
  }, [effArmedId, playheadSec, playing, recording, sr, recordTargetRef]);

  // On the record rising edge, anchor the live overlay where the backend will actually
  // commit the take (W-06): armed track at the playhead unless that sits inside an
  // existing clip (→ end of track); with nothing armed, the take appends to track 1.
  useEffect(() => {
    if (recording && !prevRecording.current) {
      const endOf = (t: ProjectView["tracks"][number]) =>
        t.clips.reduce(
          (m, c) =>
            Math.max(m, c.timeline_start + (c.source_out - c.source_in)),
          0,
        );
      const armed = project?.tracks.find((t) => t.id === effArmedId);
      const wanted = Math.round(playheadSec * sr);
      if (armed) {
        const inside = armed.clips.some(
          (c) =>
            c.timeline_start <= wanted &&
            wanted < c.timeline_start + (c.source_out - c.source_in),
        );
        recStartSec.current = (inside ? endOf(armed) : wanted) / sr;
        recTrackId.current = armed.id;
      } else {
        const t0 = project?.tracks[0];
        recStartSec.current = (t0 ? endOf(t0) : 0) / sr;
        recTrackId.current = t0?.id ?? null;
      }
    }
    prevRecording.current = recording;
  }, [recording, playheadSec, effArmedId, project, sr]);

  // Redraw every frame while recording so the incoming waveform grows live.
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      drawRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [recording]);

  const toggleArm = useCallback((id: string) => {
    setArmedTrackId((cur) => (cur === id ? "none" : id));
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Recompute the canvas palette when the theme (data-theme on <html> / OS scheme)
  // changes, then redraw so the timeline follows the theme.
  useEffect(() => {
    const update = () => {
      theme.current = readCanvasTheme();
      drawRef.current();
    };
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    mql.addEventListener("change", update);
    return () => {
      obs.disconnect();
      mql.removeEventListener("change", update);
    };
  }, []);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Fetch peaks for any source we don't have yet.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const missing = project.sources.filter((s) => !peaks.current.has(s.id));
    if (missing.length === 0) return;
    Promise.all(
      missing.map((s) =>
        fetchPeaks(s.id)
          .then((p) => peaks.current.set(s.id, p))
          .catch(() => {}),
      ),
    ).then(() => {
      if (cancelled) return;
      tick((n) => n + 1);
      // Peaks arrive async and the draw effect keys on `draw` (not the peaks ref), so
      // repaint explicitly — otherwise the clip stays flat until the next interaction.
      drawRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Clear a stale selection after split / channel-split / undo removes the clip.
  useEffect(() => {
    if (selected && project && !findClip(project, selected)) setSelected(null);
  }, [project, selected]);

  // Track index at lane-canvas y (0-based, variable heights); -1 if outside.
  const trackIndexAtY = useCallback(
    (y: number): number => {
      const tracks = project?.tracks ?? [];
      const { tops, total } = laneLayout(tracks, collapsed);
      if (y < 0 || y >= total) return -1;
      for (let i = tracks.length - 1; i >= 0; i--) if (y >= tops[i]) return i;
      return -1;
    },
    [project, collapsed],
  );
  // Top y (with the 4px lane pad) of a track index on the lane canvas.
  const laneTopAt = useCallback(
    (y: number): number | null => {
      const ti = trackIndexAtY(y);
      if (ti < 0) return null;
      return laneLayout(project?.tracks ?? [], collapsed).tops[ti] + 4;
    },
    [project, collapsed, trackIndexAtY],
  );

  const gridStep = useCallback(() => {
    const raw = 80 / pps;
    const steps = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
    return steps.find((s) => s >= raw) ?? 600;
  }, [pps]);

  const xToSec = useCallback(
    (x: number) => scrollSec + x / pps,
    [scrollSec, pps],
  );

  // ---- Snapping ----
  const snapSec = useCallback(
    (sec: number, step: number): number => {
      // Snap off (toggle) or momentarily bypassed (Alt held) → free placement.
      if (!snapEnabled || altBypass.current) {
        snapLine.current = null;
        return Math.max(0, sec);
      }
      // With the beat grid on, snap to the nearest beat step; otherwise the time grid.
      const gridCandidate = beatGrid
        ? Math.round(sec / stepSec) * stepSec
        : Math.round(sec / step) * step;
      const candidates: number[] = [playheadSec, gridCandidate];
      const dragged =
        drag.current && "clipId" in drag.current ? drag.current.clipId : null;
      for (const t of project?.tracks ?? []) {
        for (const c of t.clips) {
          if (c.id === dragged) continue;
          candidates.push(c.timeline_start / sr);
          candidates.push((c.timeline_start + clipLen(c)) / sr);
        }
      }
      let best = sec;
      let bestDist = SNAP_PX / pps;
      snapLine.current = null;
      for (const cand of candidates) {
        const d = Math.abs(cand - sec);
        if (d < bestDist) {
          bestDist = d;
          best = cand;
          snapLine.current = cand;
        }
      }
      return Math.max(0, best);
    },
    [project, sr, pps, playheadSec, beatGrid, stepSec],
  );

  // ---- Draw ----
  const draw = useCallback(() => {
    const th = theme.current;
    const dpr = window.devicePixelRatio || 1;
    const step = gridStep();
    const tracks = project?.tracks ?? [];
    const { tops, total } = laneLayout(tracks, collapsed);
    const laneHeightOf = (ti: number) => (tops[ti + 1] ?? total) - tops[ti];

    // ---- Sticky ruler (its own fixed-height canvas above the scrolling lanes) ----
    const rc = rulerRef.current;
    if (rc) {
      rc.width = width * dpr;
      rc.height = RULER_HEIGHT * dpr;
      rc.style.height = `${RULER_HEIGHT}px`;
      const rx = rc.getContext("2d");
      if (rx) {
        rx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rx.fillStyle = th.lane;
        rx.fillRect(0, 0, width, RULER_HEIGHT);
        rx.fillStyle = th.ruler;
        rx.font = th.labelFont;
        const tick = (x: number) => {
          rx.strokeStyle = th.grid;
          rx.lineWidth = 1;
          rx.beginPath();
          rx.moveTo(x + 0.5, RULER_HEIGHT - 6);
          rx.lineTo(x + 0.5, RULER_HEIGHT);
          rx.stroke();
        };
        if (!beatGrid) {
          // Minor stubs at 1/5 steps under the labeled majors (W-38).
          const minor = step / 5;
          const firstMinor = Math.ceil(scrollSec / minor) * minor;
          for (let t = firstMinor; (t - scrollSec) * pps <= width; t += minor) {
            const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
            if (isMajor) continue;
            const x = Math.round((t - scrollSec) * pps);
            rx.strokeStyle = th.grid;
            rx.beginPath();
            rx.moveTo(x + 0.5, RULER_HEIGHT - 3);
            rx.lineTo(x + 0.5, RULER_HEIGHT);
            rx.stroke();
          }
          const first = Math.ceil(scrollSec / step) * step;
          for (let t = first; (t - scrollSec) * pps <= width; t += step) {
            const x = Math.round((t - scrollSec) * pps);
            tick(x);
            rx.fillText(fmtTime(t, step), x + 3, 12);
          }
        } else {
          const stepsPerBar = gridDiv * 4;
          for (let idx = Math.max(0, Math.ceil(scrollSec / stepSec)); ; idx++) {
            const x = (idx * stepSec - scrollSec) * pps;
            if (x > width) break;
            if (idx % stepsPerBar === 0) {
              tick(Math.round(x));
              rx.fillText(String(idx / stepsPerBar + 1), Math.round(x) + 3, 12);
            }
          }
        }
        // bottom divider + playhead handle
        rx.strokeStyle = th.grid;
        rx.beginPath();
        rx.moveTo(0, RULER_HEIGHT - 0.5);
        rx.lineTo(width, RULER_HEIGHT - 0.5);
        rx.stroke();
        const rpx = (playheadSec - scrollSec) * pps;
        if (rpx >= 0 && rpx <= width) {
          rx.fillStyle = th.playhead;
          rx.beginPath();
          rx.moveTo(rpx - 6, 0);
          rx.lineTo(rpx + 6, 0);
          rx.lineTo(rpx, 9);
          rx.closePath();
          rx.fill();
        }
      }
    }

    // ---- Lanes canvas (0-based; scrolls vertically) ----
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width * dpr;
    canvas.height = total * dpr;
    canvas.style.height = `${total}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, width, total);

    tracks.forEach((_t, i) => {
      ctx.fillStyle = i % 2 ? th.laneAlt : th.lane;
      ctx.fillRect(0, tops[i], width, laneHeightOf(i));
    });

    // Vertical gridlines (full lane height; labels live on the sticky ruler).
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    if (!beatGrid) {
      // Major/minor hierarchy mirroring beat mode's 0.5/0.1 alphas (W-38).
      const minor = step / 5;
      const firstMinor = Math.ceil(scrollSec / minor) * minor;
      for (let t = firstMinor; (t - scrollSec) * pps <= width; t += minor) {
        const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
        ctx.globalAlpha = isMajor ? 1 : 0.35;
        const x = Math.round((t - scrollSec) * pps) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, total);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else {
      const stepsPerBar = gridDiv * 4;
      for (let idx = Math.max(0, Math.ceil(scrollSec / stepSec)); ; idx++) {
        const x = (idx * stepSec - scrollSec) * pps;
        if (x > width) break;
        ctx.globalAlpha =
          idx % stepsPerBar === 0 ? 0.5 : idx % gridDiv === 0 ? 0.28 : 0.1;
        const xr = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xr, 0);
        ctx.lineTo(xr, total);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    tracks.forEach((track, ti) => {
      const laneTop = tops[ti] + 4;
      const laneH = laneHeightOf(ti) - 8;
      const tc = track.color ?? trackColor(ti, th.trackColors); // identity color (custom or auto)
      for (const clip of track.clips) {
        const d = drag.current;
        let startSec = clip.timeline_start / sr;
        let drawTop = laneTop;
        let ghost = false;
        if (d && d.kind === "move" && d.clipId === clip.id) {
          startSec = snapSec(xToSec(mouse.current.x) - d.grabSec, step);
          drawTop = laneTopAt(mouse.current.y) ?? laneTop;
          ghost = true;
        }
        let lenSec = clipLen(clip) / sr;
        if (d && d.kind === "trim-end" && d.clipId === clip.id) {
          const end = snapSec(xToSec(mouse.current.x), step);
          lenSec = Math.max(1 / sr, end - startSec);
          ghost = true;
        }
        if (d && d.kind === "trim-start" && d.clipId === clip.id) {
          const ns = snapSec(xToSec(mouse.current.x), step);
          const origEnd = startSec + lenSec;
          startSec = Math.min(ns, origEnd - 1 / sr);
          lenSec = origEnd - startSec;
          ghost = true;
        }

        const x0 = (startSec - scrollSec) * pps;
        const w = lenSec * pps;
        if (x0 + w < 0 || x0 > width) continue;
        const isSel = clip.id === selected;
        // Fill and stroke share rounded geometry; the half-pixel crisping offset only
        // applies to odd line widths, so the selected 2px border stays sharp (W-37).
        const rx0 = Math.round(x0);
        const rw = Math.round(w);
        const off = isSel ? 0 : 0.5; // 2px (even) vs 1px (odd) stroke
        ctx.fillStyle = hexA(tc, isSel ? th.clipAlphaSel : th.clipAlpha);
        ctx.globalAlpha = ghost ? 0.6 : 1;
        ctx.fillRect(rx0, drawTop, rw, laneH);
        ctx.strokeStyle = isSel ? tc : hexA(tc, 0.7);
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.strokeRect(rx0 + off, drawTop + off, rw - 2 * off, laneH - 2 * off);

        const pyr = peaks.current.get(clip.source_id);
        if (pyr)
          drawClipWave(
            ctx,
            pyr,
            clip,
            x0,
            drawTop,
            w,
            laneH,
            pps,
            sr,
            isSel,
            width,
            th,
            tc,
          );

        // Clip name label — a header strip at the top-left, Ableton/Audacity-style.
        if (w > 22) {
          const labelH = 14;
          ctx.fillStyle = hexA(tc, isSel ? 0.9 : 0.62);
          ctx.fillRect(Math.round(x0), drawTop, Math.round(w), labelH);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 2, drawTop, Math.max(0, w - 4), labelH);
          ctx.clip();
          ctx.fillStyle = labelColorFor(tc);
          ctx.font = th.labelFont;
          ctx.textBaseline = "middle";
          ctx.fillText(clip.name, x0 + 5, drawTop + labelH / 2 + 0.5);
          ctx.restore();
        }

        // Fade envelopes (live length during a fade drag).
        let fadeInFrames = clip.fade_in_len;
        let fadeOutFrames = clip.fade_out_len;
        if (d && d.kind === "fade-in" && d.clipId === clip.id) {
          fadeInFrames = Math.max(
            0,
            (xToSec(mouse.current.x) - clip.timeline_start / sr) * sr,
          );
        }
        if (d && d.kind === "fade-out" && d.clipId === clip.id) {
          fadeOutFrames = Math.max(
            0,
            ((clip.timeline_start + clipLen(clip)) / sr -
              xToSec(mouse.current.x)) *
              sr,
          );
        }
        drawFade(
          ctx,
          "in",
          clip.fade_in_curve,
          fadeInFrames,
          sr,
          pps,
          x0,
          drawTop,
          w,
          laneH,
          th,
        );
        drawFade(
          ctx,
          "out",
          clip.fade_out_curve,
          fadeOutFrames,
          sr,
          pps,
          x0,
          drawTop,
          w,
          laneH,
          th,
        );
        ctx.globalAlpha = 1;
      }
    });

    if (drag.current && snapLine.current != null) {
      const x = (snapLine.current - scrollSec) * pps;
      if (x >= 0 && x <= width) {
        ctx.strokeStyle = th.snap;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, total);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Live recording waveform: a growing envelope on the armed track, plus a moving
    // record cursor. Buckets are mutated in place by useAudio and read fresh here (the
    // recording rAF drives repaints).
    if (recording) {
      // Prefer the track captured at record start; fall back to the armed track (e.g.
      // when the backend auto-created a track because none was armed).
      const tks = project?.tracks ?? [];
      const valid = (id: string | null) => !!id && tks.some((t) => t.id === id);
      // Snapshot track, else the armed track, else the last track (where the backend
      // places a take recorded with nothing armed).
      const liveId = valid(recTrackId.current)
        ? recTrackId.current
        : valid(armedTrackId)
          ? armedTrackId
          : tks[tks.length - 1]?.id;
      // Before the backend's just-created track lands (empty-timeline case), draw in
      // the first lane so the user still sees live feedback immediately.
      const found = tks.findIndex((t) => t.id === liveId);
      const ti = found >= 0 ? found : 0;
      {
        const laneTop = tops[ti] + 4;
        const laneH = (tops[ti + 1] ?? total) - tops[ti] - 8;
        const mid = laneTop + laneH / 2;
        const start = recStartSec.current;
        const buckets = recWave.current.buckets;
        // Auto-scale the live waveform to its running peak so quiet input is visible
        // (matches the recorded-clip display gain).
        let pk = 0;
        for (const b of buckets)
          pk = Math.max(pk, Math.abs(b.max), Math.abs(b.min));
        const gain = pk > 0.0001 ? Math.min(12, 0.9 / pk) : 1;
        ctx.fillStyle = th.waveSel;
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i];
          const x = (start + b.t - scrollSec) * pps;
          if (x < -2 || x > width) continue;
          const next = buckets[i + 1];
          const bw = next ? Math.max(1, (next.t - b.t) * pps) : 1;
          const h = Math.max(-1, Math.min(1, b.max * gain));
          const l = Math.max(-1, Math.min(1, b.min * gain));
          const y1 = mid - h * (laneH / 2) * 0.95;
          const y2 = mid - l * (laneH / 2) * 0.95;
          ctx.fillRect(x, Math.min(y1, y2), bw, Math.max(1, Math.abs(y2 - y1)));
        }
        const lastT = buckets.length ? buckets[buckets.length - 1].t : 0;
        const cx = (start + lastT - scrollSec) * pps;
        ctx.strokeStyle = th.playhead;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, laneTop);
        ctx.lineTo(cx, laneTop + laneH);
        ctx.stroke();
      }
    }

    const px = (playheadSec - scrollSec) * pps;
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = th.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, total);
      ctx.stroke();
    }
  }, [
    project,
    collapsed,
    width,
    pps,
    scrollSec,
    playheadSec,
    selected,
    sr,
    gridStep,
    snapSec,
    xToSec,
    laneTopAt,
    recording,
    recWave,
    armedTrackId,
    beatGrid,
    bpm,
    gridDiv,
    stepSec,
  ]);

  drawRef.current = draw;
  useEffect(() => {
    draw();
  }, [draw]);

  // ---- Hit testing ----
  const hitTest = useCallback(
    (x: number, y: number): { clip: ClipView; zone: Zone } | null => {
      if (!project) return null;
      const ti = trackIndexAtY(y);
      const track = project.tracks[ti];
      if (!track) return null;
      const laneTop = laneLayout(project.tracks, collapsed).tops[ti] + 4;
      const inTopStrip = y <= laneTop + 14;
      for (const clip of track.clips) {
        const x0 = (clip.timeline_start / sr - scrollSec) * pps;
        const w = (clipLen(clip) / sr) * pps;
        if (x < x0 - EDGE_PX || x > x0 + w + EDGE_PX) continue;
        if (inTopStrip && x >= x0 && x <= x0 + FADE_ZONE_PX)
          return { clip, zone: "fade-in" };
        if (inTopStrip && x >= x0 + w - FADE_ZONE_PX && x <= x0 + w)
          return { clip, zone: "fade-out" };
        if (Math.abs(x - x0) <= EDGE_PX) return { clip, zone: "trim-start" };
        if (Math.abs(x - (x0 + w)) <= EDGE_PX)
          return { clip, zone: "trim-end" };
        if (x >= x0 && x <= x0 + w) return { clip, zone: "body" };
      }
      return null;
    },
    [project, sr, scrollSec, pps, collapsed, trackIndexAtY],
  );

  const cursorFor = (zone: Zone | null): string =>
    zone === "trim-start" || zone === "trim-end"
      ? "col-resize"
      : zone === "fade-in" || zone === "fade-out"
        ? "ew-resize" // horizontal drag, not a click (W-28)
        : zone === "body"
          ? "grab"
          : "default";

  // Mid-drag cursor: keep the gesture's own cursor, not a blanket "grabbing" (W-28).
  const dragCursor = (d: Drag): string =>
    !d
      ? "default"
      : d.kind === "trim-start" || d.kind === "trim-end"
        ? "col-resize"
        : d.kind === "fade-in" || d.kind === "fade-out"
          ? "ew-resize"
          : "grabbing";

  // ---- Ruler scrubbing (sets the playhead / seeks) ----
  const rulerScrub = useRef(false);
  const rulerSec = (e: React.MouseEvent) =>
    Math.max(
      0,
      snapToGrid(
        xToSec(e.clientX - e.currentTarget.getBoundingClientRect().left),
      ),
    );
  const onRulerDown = (e: React.MouseEvent) => {
    seek(Math.round(rulerSec(e) * sr));
    rulerScrub.current = true;
  };
  const onRulerMove = (e: React.MouseEvent) => {
    if (!rulerScrub.current) return;
    setPlayheadSec(rulerSec(e));
    drawRef.current();
  };
  const onRulerUp = (e: React.MouseEvent) => {
    if (!rulerScrub.current) return;
    rulerScrub.current = false;
    seek(Math.round(rulerSec(e) * sr));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mouse.current = { x, y };
    const hit = hitTest(x, y);
    const clickedSec = Math.max(0, xToSec(x));
    if (hit) {
      setSelected(hit.clip.id);
      const id = hit.clip.id;
      if (hit.zone === "trim-start")
        drag.current = { kind: "trim-start", clipId: id };
      else if (hit.zone === "trim-end")
        drag.current = { kind: "trim-end", clipId: id };
      else if (hit.zone === "fade-in")
        drag.current = { kind: "fade-in", clipId: id };
      else if (hit.zone === "fade-out")
        drag.current = { kind: "fade-out", clipId: id };
      else {
        // Click on a clip body: move the playhead there (seeking if playing) so the
        // playhead follows your click, then arm a move-drag.
        seek(Math.round(snapToGrid(clickedSec) * sr));
        drag.current = {
          kind: "move",
          clipId: id,
          grabSec: xToSec(x) - hit.clip.timeline_start / sr,
        };
      }
    } else {
      setSelected(null);
      seek(Math.round(snapToGrid(clickedSec) * sr));
      drag.current = { kind: "scrub" };
    }
    tick((n) => n + 1);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    mouse.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    altBypass.current = e.altKey; // hold Alt while dragging to bypass snap
    if (drag.current) {
      if (drag.current.kind === "scrub")
        setPlayheadSec(snapToGrid(Math.max(0, xToSec(mouse.current.x))));
      drawRef.current();
    } else {
      // Cursor affordance: telegraph what a drag here would do.
      setCursor(
        cursorFor(hitTest(mouse.current.x, mouse.current.y)?.zone ?? null),
      );
    }
  };

  const onMouseUp = () => {
    const d = drag.current;
    drag.current = null;
    snapLine.current = null;
    if (!d || !project) {
      tick((n) => n + 1);
      return;
    }
    const step = gridStep();
    const clip = findClip(project, "clipId" in d ? d.clipId : "");
    if (d.kind === "move" && clip) {
      const startSec = snapSec(xToSec(mouse.current.x) - d.grabSec, step);
      const ti = trackIndexAtY(mouse.current.y);
      const track =
        project.tracks[ti] ??
        project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
      const newStart = Math.round(startSec * sr);
      const curTrack = project.tracks.find((t) =>
        t.clips.some((c) => c.id === clip.id),
      );
      // Only commit a real change — a plain click to select must not push a no-op move.
      if (
        track &&
        (track.id !== curTrack?.id || newStart !== clip.timeline_start)
      ) {
        api.move(clip.id, track.id, newStart);
      }
    } else if (d.kind === "trim-end" && clip) {
      const frame = Math.round(snapSec(xToSec(mouse.current.x), step) * sr);
      if (frame !== clip.timeline_start + clipLen(clip))
        api.trimEnd(clip.id, frame);
    } else if (d.kind === "trim-start" && clip) {
      const frame = Math.round(snapSec(xToSec(mouse.current.x), step) * sr);
      if (frame !== clip.timeline_start) api.trimStart(clip.id, frame);
    } else if (d.kind === "fade-in" && clip) {
      const lenFrames = Math.max(
        0,
        Math.round((xToSec(mouse.current.x) - clip.timeline_start / sr) * sr),
      );
      api.setFadeIn(clip.id, lenFrames, clip.fade_in_curve as FadeCurve);
    } else if (d.kind === "fade-out" && clip) {
      const clipEndSec = (clip.timeline_start + clipLen(clip)) / sr;
      const lenFrames = Math.max(
        0,
        Math.round((clipEndSec - xToSec(mouse.current.x)) * sr),
      );
      api.setFadeOut(clip.id, lenFrames, clip.fade_out_curve as FadeCurve);
    } else if (d.kind === "scrub") {
      // Settle the playhead at the final scrub position (and seek there if playing).
      seek(Math.round(snapToGrid(Math.max(0, xToSec(mouse.current.x))) * sr));
    }
    tick((n) => n + 1);
  };

  // Double-click a fade region to cycle its curve shape.
  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    if (hit.zone === "fade-in") {
      api.setFadeIn(
        hit.clip.id,
        hit.clip.fade_in_len,
        nextCurve(hit.clip.fade_in_curve as FadeCurve),
      );
    } else if (hit.zone === "fade-out") {
      api.setFadeOut(
        hit.clip.id,
        hit.clip.fade_out_len,
        nextCurve(hit.clip.fade_out_curve as FadeCurve),
      );
    }
  };

  // ---- Drag a media-pool source onto a track ----
  const onCanvasDragOver = (e: React.DragEvent) => {
    // Always allow the drop (some webviews don't expose custom drag types during
    // dragover); onCanvasDrop validates the payload.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onCanvasDrop = async (e: React.DragEvent) => {
    const sourceId = e.dataTransfer.getData("application/x-waver-source");
    if (!sourceId || !project) return;
    e.preventDefault();
    const src = project.sources.find((s) => s.id === sourceId);
    if (!src) return;
    const el = canvasRef.current ?? wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const spec = (start: number): ClipSpec => ({
      name: (src.path.split(/[\\/]/).pop() ?? "Clip").replace(/\.[^.]+$/, ""),
      source_id: src.id,
      source_channel: null,
      source_in: 0,
      source_out: src.frames,
      timeline_start: start,
      gain_db: 0,
      fade_in_len: 0,
      fade_in_curve: "linear",
      fade_out_len: 0,
      fade_out_curve: "linear",
    });
    const place = async (
      track: ProjectView["tracks"][number] | { id: string },
      start: number,
      priorView: ProjectView,
    ) => {
      const before = new Set(
        priorView.tracks.flatMap((t) => t.clips.map((cl) => cl.id)),
      );
      const view = await api.paste(spec(start), track.id);
      const placed = view?.tracks
        .flatMap((t) => t.clips)
        .find((cl) => !before.has(cl.id));
      if (placed) {
        setSelected(placed.id);
        revealSec(placed.timeline_start / sr);
      }
    };
    if (project.tracks.length === 0) {
      // Empty timeline: complete the drop, don't swallow it (W-09).
      const view = await api.addTrack();
      const t0 = view?.tracks[0];
      if (!t0 || !view) return;
      await place(t0, Math.round(Math.max(0, xToSec(x)) * sr), view);
      return;
    }
    // Clamp into the lane range so a drop above/below lands on a valid track.
    const raw = trackIndexAtY(y);
    const ti = raw >= 0 ? raw : project.tracks.length - 1;
    const track = project.tracks[ti];
    if (!track) return;
    const wanted = Math.round(Math.max(0, xToSec(x)) * sr);
    const start = freeStartOn(track, wanted, src.frames);
    await place(track, start, project);
    if (start !== wanted)
      onNotice(
        `Placed at ${fmtTimecode(start / sr)} — no room at the drop point.`,
      );
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom horizontally around the cursor.
      e.preventDefault();
      const rect = canvasRef.current!.getBoundingClientRect();
      const cur = scrollSec + (e.clientX - rect.left) / pps;
      const np = Math.min(
        MAX_PPS,
        Math.max(MIN_PPS, pps * Math.exp(-e.deltaY * 0.002)),
      );
      setScrollSec(Math.max(0, cur - (e.clientX - rect.left) / np));
      setPps(np);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Horizontal intent → pan the timeline; vertical wheel is left to scroll the
      // lanes natively (the scroll container).
      setScrollSec((s) => Math.max(0, s + e.deltaX / pps));
    }
  };

  const splitAtPlayhead = useCallback(() => {
    if (selected) api.split(selected, Math.round(playheadSec * sr));
  }, [selected, playheadSec, sr, api]);

  // A non-overlapping start frame for a `len`-frame clip on `track`: the wanted
  // position, or appended after the track's clips if that would overlap (mirrors the
  // recording-placement and drag-drop behaviour, so placement is consistent everywhere).
  const freeStartOn = (
    track: ProjectView["tracks"][number],
    wanted: number,
    len: number,
  ): number => {
    const overlaps = track.clips.some(
      (c) =>
        wanted < c.timeline_start + (c.source_out - c.source_in) &&
        c.timeline_start < wanted + len,
    );
    return overlaps
      ? track.clips.reduce(
          (m, c) =>
            Math.max(m, c.timeline_start + (c.source_out - c.source_in)),
          0,
        )
      : wanted;
  };
  const trackOfClip = (id: string) =>
    project?.tracks.find((t) => t.clips.some((c) => c.id === id)) ?? null;

  // Bring a timeline position into view (used after paste/duplicate/drop/take; W-06/08).
  const revealSec = useCallback(
    (sec: number) => {
      const viewSec = width / pps;
      setScrollSec((s) =>
        sec < s || sec > s + viewSec ? Math.max(0, sec - viewSec * 0.15) : s,
      );
    },
    [width, pps],
  );

  // Select + reveal the clip a finished take committed (W-06). Waits for the refreshed
  // project that contains it; a notice explains any relocation the overlay missed.
  const seenTakeSeq = useRef(0);
  useEffect(() => {
    if (!lastTake || lastTake.seq === seenTakeSeq.current || !project) return;
    const c = findClip(project, lastTake.clipId);
    if (!c) return; // refresh not landed yet
    seenTakeSeq.current = lastTake.seq;
    setSelected(lastTake.clipId);
    const startS = c.timeline_start / sr;
    revealSec(startS);
    if (Math.abs(startS - recStartSec.current) > 0.05)
      onNotice(
        `Take placed at ${fmtTimecode(startS)} — the watched position was occupied.`,
      );
  }, [lastTake, project, sr, revealSec, onNotice]);

  // ---- Clipboard: copy / cut / paste / duplicate the selected clip ----
  const clipboard = useRef<ClipView | null>(null);
  const [hasClipboard, setHasClipboard] = useState(false);
  const specFrom = (c: ClipView, timeline_start: number): ClipSpec => ({
    name: c.name,
    source_id: c.source_id,
    source_channel: c.source_channel,
    source_in: c.source_in,
    source_out: c.source_out,
    timeline_start,
    gain_db: c.gain_db,
    fade_in_len: c.fade_in_len,
    fade_in_curve: c.fade_in_curve,
    fade_out_len: c.fade_out_len,
    fade_out_curve: c.fade_out_curve,
  });

  const copySel = useCallback(() => {
    const c = project && selected ? findClip(project, selected) : null;
    if (c) {
      clipboard.current = c;
      setHasClipboard(true);
    }
  }, [project, selected]);

  const cutSel = useCallback(() => {
    const c = project && selected ? findClip(project, selected) : null;
    if (c) {
      clipboard.current = c;
      setHasClipboard(true);
      api.del(c.id, false);
      setSelected(null);
    }
  }, [project, selected, api]);

  const pasteAtPlayhead = useCallback(async () => {
    const c = clipboard.current;
    if (!c || !project) return;
    // The clipboard source must still exist (New/Open can replace the pool).
    if (!project.sources.some((s) => s.id === c.source_id)) {
      clipboard.current = null;
      setHasClipboard(false);
      onNotice(
        "The clipboard clip's audio is no longer in this project — clipboard cleared.",
      );
      return;
    }
    const track =
      project.tracks.find((t) => t.id === effArmedId) ?? project.tracks[0];
    if (!track) return;
    const len = c.source_out - c.source_in;
    const wanted = Math.round(playheadSec * sr);
    const start = freeStartOn(track, wanted, len);
    const before = new Set(
      project.tracks.flatMap((t) => t.clips.map((cl) => cl.id)),
    );
    const view = await api.paste(specFrom(c, start), track.id);
    const placed = view?.tracks
      .flatMap((t) => t.clips)
      .find((cl) => !before.has(cl.id));
    if (placed) {
      setSelected(placed.id);
      revealSec(placed.timeline_start / sr);
    }
    if (start !== wanted)
      onNotice(
        `Pasted at ${fmtTimecode(start / sr)} — no room at the playhead.`,
      );
  }, [effArmedId, project, playheadSec, sr, api, onNotice, revealSec]);

  const duplicateSel = useCallback(async () => {
    const c = project && selected ? findClip(project, selected) : null;
    const track = c ? trackOfClip(c.id) : null;
    if (!c || !track) return;
    // Place the copy at the playhead (or after the original), snapping past any clip
    // that would overlap — so Duplicate never fails on adjacent clips (e.g. split halves).
    const len = c.source_out - c.source_in;
    const wanted = Math.max(
      c.timeline_start + len,
      Math.round(playheadSec * sr),
    );
    const start = freeStartOn(track, wanted, len);
    const before = new Set(
      (project?.tracks ?? []).flatMap((t) => t.clips.map((cl) => cl.id)),
    );
    const view = await api.duplicate(c.id, start);
    const placed = view?.tracks
      .flatMap((t) => t.clips)
      .find((cl) => !before.has(cl.id));
    if (placed) {
      setSelected(placed.id);
      revealSec(placed.timeline_start / sr);
    }
    if (start !== wanted)
      onNotice(
        `Duplicated to ${fmtTimecode(start / sr)} — no room at the wanted spot.`,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected, playheadSec, sr, api, onNotice, revealSec]);

  // Arm the selected clip's track (the DAW-standard 'R' shortcut).
  const armSelected = useCallback(() => {
    const t = selected ? trackOfClip(selected) : null;
    if (t) toggleArm(t.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, project, toggleArm]);

  // ---- View helpers: fit / zoom-to-selection / nudge / fold-all ----
  const clampPps = (p: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, p));

  // Rightmost content edge (seconds) across every clip — the extent to fit.
  const contentEndSec = useCallback((): number => {
    let end = 0;
    for (const t of project?.tracks ?? [])
      for (const c of t.clips)
        end = Math.max(end, (c.timeline_start + clipLen(c)) / sr);
    return end;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, sr]);

  // Fit the whole project into the viewport (Audacity "Fit to Width").
  const fitToWindow = useCallback(() => {
    const end = contentEndSec();
    setScrollSec(0);
    if (end <= 0) return;
    setPps(clampPps((width * 0.98) / end));
  }, [contentEndSec, width]);

  // Keyboard zoom centered on the playhead (W-25).
  const zoomStep = useCallback(
    (dir: 1 | -1) => {
      const np = clampPps(dir === 1 ? pps * 1.5 : pps / 1.5);
      setPps(np);
      setScrollSec(Math.max(0, playheadSec - width / np / 2));
    },
    [pps, playheadSec, width],
  );

  // Zoom so the selected clip fills the viewport (Audacity "Zoom to Selection").
  const zoomToSelection = useCallback(() => {
    const c = project && selected ? findClip(project, selected) : null;
    if (!c) return;
    const len = clipLen(c) / sr;
    if (len <= 0) return;
    setPps(clampPps((width * 0.9) / len));
    setScrollSec(Math.max(0, c.timeline_start / sr - len * 0.05));
  }, [project, selected, sr, width]);

  // Nudge the selected clip along the timeline by one grid step (Shift = ×4).
  // Skips the move if it would overlap another clip on the same track.
  const nudgeSelected = useCallback(
    (dir: -1 | 1, big: boolean) => {
      const c = project && selected ? findClip(project, selected) : null;
      const track = c ? trackOfClip(c.id) : null;
      if (!c || !track) return;
      const stepFrames = beatGrid ? stepSec * sr : 0.1 * sr; // 1/10s default step
      const delta = dir * stepFrames * (big ? 4 : 1);
      const len = clipLen(c);
      const want = Math.max(0, Math.round(c.timeline_start + delta));
      const overlaps = track.clips.some(
        (o) =>
          o.id !== c.id &&
          want < o.timeline_start + clipLen(o) &&
          o.timeline_start < want + len,
      );
      if (!overlaps && want !== c.timeline_start)
        api.move(c.id, track.id, want);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [project, selected, beatGrid, stepSec, sr, api],
  );

  // Collapse every track, or (if all already collapsed) expand every track.
  const foldAll = useCallback(() => {
    const ids = (project?.tracks ?? []).map((t) => t.id);
    setCollapsed((prev) =>
      ids.length > 0 && ids.every((id) => prev.has(id))
        ? new Set()
        : new Set(ids),
    );
  }, [project]);

  // ---- Follow playhead: keep it in view during playback (Audacity/Ableton) ----
  useEffect(() => {
    if (!followPlayhead || !playing || width <= 0) return;
    const viewSec = width / pps;
    const left = scrollSec;
    const right = scrollSec + viewSec;
    // Re-page when the playhead crosses the right edge or scrolls off the left.
    if (playheadSec > right - viewSec * 0.08)
      setScrollSec(Math.max(0, playheadSec - viewSec * 0.15));
    else if (playheadSec < left)
      setScrollSec(Math.max(0, playheadSec - viewSec * 0.15));
  }, [followPlayhead, playing, playheadSec, pps, width, scrollSec]);

  // ---- Keyboard shortcuts (registered once; reads latest via a ref) ----
  const kb = useRef({
    api,
    selected,
    ripple,
    splitAtPlayhead,
    playing,
    togglePause,
    startPlay,
    copySel,
    cutSel,
    pasteAtPlayhead,
    duplicateSel,
    armSelected,
    fitToWindow,
    zoomToSelection,
    nudgeSelected,
    foldAll,
    recording,
    canRecord,
    onToggleRecord,
    showShortcuts,
    stopPlay,
    seek,
    seekEnd: () => seek(Math.round(contentEndSec() * sr)),
    zoomStep,
    toggleShortcuts: () => setShowShortcuts((s) => !s),
    toggleSnap: () => setSnapEnabled((s) => !s),
  });
  kb.current = {
    api,
    selected,
    ripple,
    splitAtPlayhead,
    playing,
    togglePause,
    startPlay,
    copySel,
    cutSel,
    pasteAtPlayhead,
    duplicateSel,
    armSelected,
    fitToWindow,
    zoomToSelection,
    nudgeSelected,
    foldAll,
    recording,
    canRecord,
    onToggleRecord,
    showShortcuts,
    stopPlay,
    seek,
    seekEnd: () => seek(Math.round(contentEndSec() * sr)),
    zoomStep,
    toggleShortcuts: () => setShowShortcuts((s) => !s),
    toggleSnap: () => setSnapEnabled((s) => !s),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT"))
        return;
      const k = kb.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // Modal gate: while the shortcuts overlay is up, only Escape and '?' work —
      // destructive shortcuts must not fire behind an aria-modal dialog (W-03).
      if (k.showShortcuts) {
        if (
          e.key === "Escape" ||
          e.key === "?" ||
          (key === "/" && e.shiftKey)
        ) {
          e.preventDefault();
          setShowShortcuts(false);
        }
        return;
      }
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? k.api.redo() : k.api.undo();
      } else if (mod && key === "c") {
        e.preventDefault();
        k.copySel();
      } else if (mod && key === "x") {
        e.preventDefault();
        k.cutSel();
      } else if (mod && key === "v") {
        e.preventDefault();
        k.pasteAtPlayhead();
      } else if (mod && key === "d") {
        e.preventDefault();
        k.duplicateSel();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (k.selected) {
          e.preventDefault();
          k.api.del(k.selected, k.ripple);
          setSelected(null);
        }
      } else if (e.key === "ArrowLeft" && !mod && k.selected) {
        e.preventDefault();
        k.nudgeSelected(-1, e.shiftKey);
      } else if (e.key === "ArrowRight" && !mod && k.selected) {
        e.preventDefault();
        k.nudgeSelected(1, e.shiftKey);
      } else if (e.key === "Home" && !mod) {
        e.preventDefault();
        k.seek(0);
      } else if (e.key === "End" && !mod) {
        e.preventDefault();
        k.seekEnd();
      } else if ((e.key === "+" || e.key === "=") && !mod) {
        k.zoomStep(1);
      } else if (e.key === "-" && !mod) {
        k.zoomStep(-1);
      } else if (key === "r" && !mod && e.shiftKey) {
        e.preventDefault();
        if (k.canRecord || k.recording) k.onToggleRecord();
      } else if (key === "r" && !mod) {
        k.armSelected();
      } else if (key === "s" && !mod && !e.shiftKey) {
        k.splitAtPlayhead();
      } else if (key === "n" && !mod) {
        k.toggleSnap();
      } else if (key === "f" && !mod) {
        k.fitToWindow();
      } else if (key === "e" && !mod) {
        k.zoomToSelection();
      } else if (key === "t" && !mod) {
        k.foldAll();
      } else if (e.key === "?" || (key === "/" && e.shiftKey)) {
        e.preventDefault();
        k.toggleShortcuts();
      } else if (e.key === "Escape") {
        // Hierarchical Escape (W-03/W-25): stop playback first, then clear the
        // selection. Popovers/overlay consume Escape before it reaches here.
        if (k.playing) k.stopPlay();
        else setSelected(null);
      } else if (e.key === " ") {
        e.preventDefault();
        // A rolling take owns Space: stop capture, never start playback into the
        // live mic (FR-2.3 clean capture; W-01).
        if (k.recording) k.onToggleRecord();
        else if (k.playing) k.togglePause();
        else k.startPlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="waveform">
      <div className="wave-toolbar">
        <div className="transport-group">
          <button
            type="button"
            className="transport play"
            disabled={!outputId || !project || project.tracks.length === 0}
            onClick={playing ? togglePause : startPlay}
            title={playing ? "Pause / resume (space)" : "Play (space)"}
            aria-label={playing && !paused ? "Pause" : "Play"}
          >
            {playing && !paused ? (
              <IconPause size={18} />
            ) : (
              <IconPlay size={18} />
            )}
          </button>
          <button
            type="button"
            className="transport stop"
            disabled={!playing}
            onClick={stopPlay}
            title="Stop"
            aria-label="Stop"
          >
            <IconStop size={16} />
          </button>
          <button
            type="button"
            className={`transport rec${recording ? " recording" : ""}`}
            disabled={!canRecord}
            onClick={onToggleRecord}
            title={
              recording
                ? "Stop recording (Space or Shift+R)"
                : effArmedId
                  ? "Record (Shift+R)"
                  : `Record (Shift+R) — nothing armed, take appends to ${project?.tracks[0]?.name ?? "a new track"}`
            }
            aria-label={
              recording
                ? `Stop recording, elapsed ${fmtTimecode(recElapsed)}`
                : "Start recording"
            }
            aria-pressed={recording}
          >
            <span
              className={recording ? "rec-square" : "rec-dot"}
              aria-hidden="true"
            />
          </button>
        </div>
        <div className="wave-timecode">
          {recording ? (
            <span className="tc-rec" role="timer">
              {fmtTimecode(recElapsed)}
            </span>
          ) : (
            <span className="tc-time">{fmtTimecode(playheadSec)}</span>
          )}
          {beatGrid && (
            <span className="tc-beats">
              {barsBeats(playheadSec, bpm, stepSec)}
            </span>
          )}
        </div>
        <span className="tb-sep" />
        <button
          type="button"
          className="tbtn"
          onClick={() => api.addTrack()}
          title="Add an empty track"
        >
          <IconPlus />
          <span>Track</span>
        </button>
        <span className="tb-sep" />
        <button
          type="button"
          className="tbtn icon-only"
          onClick={() => setPps((p) => Math.min(MAX_PPS, p * 1.5))}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <IconZoomIn />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          onClick={() => setPps((p) => Math.max(MIN_PPS, p / 1.5))}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <IconZoomOut />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          onClick={fitToWindow}
          title="Fit project to window (F)"
          aria-label="Fit to window"
        >
          <IconFit />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!selected}
          onClick={zoomToSelection}
          title="Zoom to selection (E)"
          aria-label="Zoom to selection"
        >
          <IconZoomSel />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          onClick={foldAll}
          title="Fold / unfold all tracks (T)"
          aria-label="Fold all tracks"
        >
          <IconFoldAll />
        </button>
        <button
          type="button"
          className={`tbtn icon-only${snapEnabled ? " active" : ""}`}
          onClick={() => setSnapEnabled((s) => !s)}
          title="Snap to grid (N) — hold Alt while dragging to bypass"
          aria-label="Snap to grid"
          aria-pressed={snapEnabled}
        >
          <IconMagnet />
        </button>
        <button
          type="button"
          className={`tbtn icon-only${followPlayhead ? " active" : ""}`}
          onClick={() => setFollowPlayhead((s) => !s)}
          title="Follow playhead during playback"
          aria-label="Follow playhead"
          aria-pressed={followPlayhead}
        >
          <IconFollow />
        </button>
        <div
          className="grid-controls"
          title="Beat grid — playhead & edits snap to it"
        >
          <button
            type="button"
            className={`tbtn${beatGrid ? " active" : ""}`}
            onClick={() => setBeatGrid((g) => !g)}
            aria-pressed={beatGrid}
          >
            <IconGrid />
            <span>Grid</span>
          </button>
          <input
            type="number"
            className="grid-bpm"
            min={20}
            max={300}
            value={bpm}
            disabled={!beatGrid}
            onChange={(e) =>
              setBpm(Math.min(300, Math.max(20, Number(e.target.value) || 120)))
            }
            title="Tempo (BPM)"
            aria-label="Tempo in BPM"
          />
          <span className="grid-unit">BPM</span>
          <select
            className="grid-div"
            value={gridDiv}
            disabled={!beatGrid}
            onChange={(e) => setGridDiv(Number(e.target.value))}
            title="Grid resolution (steps per beat)"
            aria-label="Grid resolution"
          >
            <option value={1}>1/4</option>
            <option value={2}>1/8</option>
            <option value={3}>1/8T</option>
            <option value={4}>1/16</option>
            <option value={8}>1/32</option>
          </select>
        </div>
        <span className="tb-sep" />
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!selected}
          onClick={splitAtPlayhead}
          title="Split at playhead (S)"
          aria-label="Split"
        >
          <IconSplit />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!selected}
          onClick={duplicateSel}
          title="Duplicate clip (⌘/Ctrl+D)"
          aria-label="Duplicate"
        >
          <IconDuplicate />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!selected}
          onClick={cutSel}
          title="Cut clip (⌘/Ctrl+X)"
          aria-label="Cut"
        >
          <IconCut />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!selected}
          onClick={copySel}
          title="Copy clip (⌘/Ctrl+C)"
          aria-label="Copy"
        >
          <IconCopy />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!hasClipboard}
          onClick={pasteAtPlayhead}
          title="Paste at playhead on the armed track (⌘/Ctrl+V)"
          aria-label="Paste"
        >
          <IconPaste />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!selected}
          onClick={() => selected && api.splitChannels(selected)}
          title="Split into mono channels"
          aria-label="Channels"
        >
          <IconChannels />
        </button>
        <button
          type="button"
          className="tbtn danger icon-only"
          disabled={!selected}
          onClick={() => {
            if (selected) {
              api.del(selected, ripple);
              setSelected(null);
            }
          }}
          title="Delete clip"
          aria-label="Delete"
        >
          <IconTrash />
        </button>
        <label
          className="ripple-toggle"
          title="Ripple: shift later clips left on delete"
        >
          <input
            type="checkbox"
            checked={ripple}
            onChange={(e) => setRipple(e.target.checked)}
          />
          Ripple
        </label>
        <span className="tb-sep" />
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!project?.can_undo}
          onClick={() => api.undo()}
          title="Undo (⌘/Ctrl+Z)"
          aria-label="Undo"
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          disabled={!project?.can_redo}
          onClick={() => api.redo()}
          title="Redo (⌘/Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          <IconRedo />
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          onClick={() => setShowShortcuts(true)}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <IconHelp />
        </button>
      </div>
      <div className="wave-body">
        {/* Sticky ruler row: a fixed spacer over the track headers + the ruler canvas,
            outside the vertical scroll so the time/bar labels stay visible. */}
        <div className="wave-ruler-row">
          <div className="wave-ruler-spacer" />
          <canvas
            ref={rulerRef}
            className="wave-ruler-canvas"
            style={{ width: "100%", cursor: "ew-resize" }}
            onMouseDown={onRulerDown}
            onMouseMove={onRulerMove}
            onMouseUp={onRulerUp}
            onMouseLeave={onRulerUp}
          />
        </div>
        <div className="wave-scroll">
          <TrackHeaders
            project={project}
            api={api}
            armedTrackId={effArmedId}
            inputLevels={inputLevels}
            onToggleArm={toggleArm}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
          />
          <div
            className="wave-canvas-wrap"
            ref={wrapRef}
            onDragOver={onCanvasDragOver}
            onDrop={onCanvasDrop}
          >
            {project &&
              !recording &&
              project.tracks.length > 0 &&
              project.tracks.every((t) => t.clips.length === 0) && (
                <p className="wave-empty-overlay">
                  Press ● Rec in the transport to record, or drag audio in from
                  the Media pool.
                </p>
              )}
            {!project || (project.tracks.length === 0 && !recording) ? (
              <p className="wave-empty">
                Record, import, or drag a file from the pool to start your
                timeline.
              </p>
            ) : (
              <canvas
                ref={canvasRef}
                role="application"
                aria-label="Timeline editor"
                style={{
                  width: "100%",
                  cursor: drag.current ? dragCursor(drag.current) : cursor,
                }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onDoubleClick={onDoubleClick}
                onWheel={onWheel}
              />
            )}
          </div>
        </div>
      </div>
      <Inspector project={project} selected={selected} api={api} sr={sr} />
      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}
    </div>
  );
}

/** Keyboard shortcuts cheat-sheet (toggled with `?`). Focus moves into the dialog on
 *  open, Tab is trapped inside, and focus returns to the opener on close (W-03). */
function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const groups: { title: string; items: [string, string][] }[] = [
    {
      title: "Transport",
      items: [
        ["Space", "Play / pause (stops a rolling take)"],
        ["Shift + R", "Start / stop recording"],
        ["Esc", "Stop playback · clear selection"],
        ["Home / End", "Jump to start / end"],
        ["S", "Split clip at playhead"],
        ["R", "Arm selected clip's track"],
      ],
    },
    {
      title: "Edit",
      items: [
        ["⌘/Ctrl + Z", "Undo"],
        ["⌘/Ctrl + Shift + Z", "Redo"],
        ["⌘/Ctrl + C / X / V", "Copy / cut / paste"],
        ["⌘/Ctrl + D", "Duplicate clip"],
        ["← / →", "Nudge clip (Shift = ×4)"],
        ["Delete / Backspace", "Delete clip"],
      ],
    },
    {
      title: "File",
      items: [
        ["⌘/Ctrl + S", "Save project"],
        ["⇧ ⌘/Ctrl + S", "Save As"],
      ],
    },
    {
      title: "View",
      items: [
        ["+ / −", "Zoom in / out at playhead"],
        ["F", "Fit project to window"],
        ["E", "Zoom to selection"],
        ["T", "Fold / unfold all tracks"],
        ["N", "Toggle snap to grid"],
        ["Alt (drag)", "Bypass snap momentarily"],
        ["Ctrl + wheel", "Zoom · wheel: scroll"],
        ["?", "This cheat-sheet"],
      ],
    },
  ];
  return (
    <div
      className="shortcuts-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onMouseDown={onClose}
    >
      <div
        className="shortcuts-card"
        ref={cardRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className="tbtn icon-only"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <IconClose />
          </button>
        </div>
        <div className="shortcuts-cols">
          {groups.map((g) => (
            <div key={g.title} className="shortcuts-group">
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([k, d]) => (
                  <div key={k} className="shortcut-row">
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{d}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
