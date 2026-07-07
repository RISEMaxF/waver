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
import { setRecordTarget, zeroCrossing } from "../audio/project";
import type { ProjectApi } from "../audio/useProject";
import { useTransport } from "../audio/useTransport";
import { fetchPeaks, type PeakPyramid } from "../audio/peaks";
import { Inspector } from "./timeline/Inspector";
import { TrackHeaders } from "./timeline/TrackHeaders";
import { MasterMeter } from "./timeline/MasterMeter";
import { ContextMenu, type MenuState } from "./timeline/ContextMenu";
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
  IconLoop,
  IconMagnet,
  IconPaste,
  IconPause,
  IconPlay,
  IconPlus,
  IconRedo,
  IconSkipEnd,
  IconSkipStart,
  IconSplit,
  IconStop,
  IconTrash,
  IconUndo,
  IconZoomIn,
  IconZoomOut,
  IconZoomSel,
  IconZeroCross,
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
  CURVE_NAMES,
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
  /** Reports the range selection (frames) upward - enables Export selection. */
  onRangeChange: (r: { start: number; end: number } | null) => void;
}

type Drag =
  | { kind: "move"; clipId: string; grabSec: number }
  | { kind: "trim-start"; clipId: string }
  | { kind: "trim-end"; clipId: string }
  | { kind: "fade-in"; clipId: string }
  | { kind: "fade-out"; clipId: string }
  | { kind: "scrub" }
  | { kind: "range"; anchorSec: number }
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
      : c === "log"
        ? "s_curve"
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
  onRangeChange,
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
  const [showGuide, setShowGuide] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
  // Time-range selection (drag across empty lane space): powers loop + range ops.
  const [range, setRange] = useState<{ start: number; end: number } | null>(
    null,
  );
  const [loopOn, setLoopOn] = useState(false);
  // Snap splits/trims to source zero crossings — click-free cuts (FR-2.3).
  const [zeroCross, setZeroCross] = useState(true);
  // Toolbar width drives priority+overflow: below the threshold the edit and view
  // clusters collapse into dropdown menus instead of scrolling out of reach.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [tbWide, setTbWide] = useState(true);
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTbWide(el.clientWidth >= 980));
    ro.observe(el);
    setTbWide(el.clientWidth >= 980);
    return () => ro.disconnect();
  }, []);

  // Playback speed (1 = normal); stretch preserves pitch, repitch is tape-style.
  const [playSpeed, setPlaySpeed] = useState(1);
  const [preservePitch, setPreservePitch] = useState(true);
  // Resizable track-controls gutter (drag the boundary), persisted per user.
  const [gutterW, setGutterW] = useState(() => {
    const w = Number(localStorage.getItem("waver-gutter-w"));
    return w >= 150 && w <= 340 ? w : 190;
  });
  const gutterDrag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!gutterDrag.current) return;
      setGutterW(
        Math.min(
          340,
          Math.max(150, gutterDrag.current.w + (e.clientX - gutterDrag.current.x)),
        ),
      );
    };
    const onUp = () => {
      if (!gutterDrag.current) return;
      gutterDrag.current = null;
      setGutterW((w) => {
        localStorage.setItem("waver-gutter-w", String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const altBypass = useRef(false); // Alt held during a drag momentarily disables snap
  const [, tick] = useState(0);
  // Snapshot of where/when the current recording began (for the live overlay).
  const recStartSec = useRef(0);
  const recTrackId = useRef<string | null>(null);
  const prevRecording = useRef(false);

  const sr = project?.sample_rate ?? 48000;
  const clipLen = (c: ClipView) => c.source_out - c.source_in;

  // Surface the range selection (in frames) to the app - enables Export selection.
  useEffect(() => {
    onRangeChange(
      range
        ? {
            start: Math.round(range.start * sr),
            end: Math.round(range.end * sr),
          }
        : null,
    );
  }, [range, sr, onRangeChange]);

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
      loop:
        loopOn && range
          ? {
              start: Math.round(range.start * sr),
              end: Math.round(range.end * sr),
            }
          : null,
      speed: playSpeed,
      preservePitch,
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
          const barPx = stepSec * stepsPerBar * pps;
          // Zoom-adaptive labels: never closer than ~40px (QoL).
          const labelEvery = Math.max(1, Math.ceil(40 / Math.max(1, barPx)));
          for (let idx = Math.max(0, Math.ceil(scrollSec / stepSec)); ; idx++) {
            const x = (idx * stepSec - scrollSec) * pps;
            if (x > width) break;
            if (idx % stepsPerBar === 0) {
              const bar = idx / stepsPerBar;
              if (barPx >= 4 || bar % labelEvery === 0) tick(Math.round(x));
              if (bar % labelEvery === 0)
                rx.fillText(String(bar + 1), Math.round(x) + 3, 12);
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
      const stepPx = stepSec * pps;
      for (let idx = Math.max(0, Math.ceil(scrollSec / stepSec)); ; idx++) {
        const x = (idx * stepSec - scrollSec) * pps;
        if (x > width) break;
        const isBar = idx % stepsPerBar === 0;
        const isBeat = idx % gridDiv === 0;
        // Zoom-adaptive density (QoL): drop subdivisions that would bunch <4px.
        if (!isBar && !isBeat && stepPx < 4) continue;
        if (!isBar && isBeat && stepPx * gridDiv < 4) continue;
        ctx.globalAlpha = isBar ? 0.5 : isBeat ? 0.28 : 0.1;
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
        // Zero-length fades on the selected clip still show a faint corner handle,
        // so the drag affordance is discoverable before any fade exists.
        if (isSel) {
          ctx.strokeStyle = th.fadeHandle;
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 1;
          if (fadeInFrames <= 0) {
            ctx.beginPath();
            ctx.arc(rx0 + 4, drawTop + 4, 3, 0, Math.PI * 2);
            ctx.stroke();
          }
          if (fadeOutFrames <= 0) {
            ctx.beginPath();
            ctx.arc(rx0 + rw - 4, drawTop + 4, 3, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
        // Live readout while shaping a fade: length + curve name at the handle.
        if (
          d &&
          (d.kind === "fade-in" || d.kind === "fade-out") &&
          d.clipId === clip.id
        ) {
          const frames = d.kind === "fade-in" ? fadeInFrames : fadeOutFrames;
          const ms = Math.round((frames / sr) * 1000);
          const curve =
            d.kind === "fade-in" ? clip.fade_in_curve : clip.fade_out_curve;
          const label = `${ms} ms · ${CURVE_NAMES[curve] ?? curve}`;
          ctx.font = th.labelFont;
          const tw = ctx.measureText(label).width;
          const lx =
            d.kind === "fade-in"
              ? Math.min(x0 + (frames / sr) * pps + 6, width - tw - 6)
              : Math.max(x0 + w - (frames / sr) * pps - tw - 6, 6);
          ctx.fillStyle = th.labelText;
          ctx.globalAlpha = 0.95;
          ctx.textBaseline = "top";
          ctx.fillText(label, lx, drawTop + 18);
          ctx.globalAlpha = 1;
        }
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

    // Time-range selection overlay: accent tint + hard edges, over the clips so
    // it reads on filled lanes, under the playhead.
    if (range) {
      const rx0 = (range.start - scrollSec) * pps;
      const rx1 = (range.end - scrollSec) * pps;
      if (rx1 > 0 && rx0 < width) {
        ctx.fillStyle = hexA(th.clipEdgeSel, 0.12);
        ctx.fillRect(rx0, 0, rx1 - rx0, total);
        ctx.strokeStyle = th.clipEdgeSel;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1;
        for (const rx of [rx0, rx1]) {
          ctx.beginPath();
          ctx.moveTo(Math.round(rx) + 0.5, 0);
          ctx.lineTo(Math.round(rx) + 0.5, total);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
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
    range,
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
      // Empty lane: arm a range-select drag (anchor magnetized to clip edges /
      // grid). A plain click still seeks — resolved on mouseup.
      setSelected(null);
      drag.current = {
        kind: "range",
        anchorSec: snapSec(clickedSec, gridStep()),
      };
      setRange(null);
    }
    tick((n) => n + 1);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    mouse.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    altBypass.current = e.altKey; // hold Alt while dragging to bypass snap
    if (drag.current) {
      if (drag.current.kind === "range") {
        const a = drag.current.anchorSec;
        const raw = Math.max(0, xToSec(mouse.current.x));
        // Magnetic end: clip edges + grid + playhead (same snapping as clip drags),
        // so selecting exactly a clip's width is effortless.
        const b = snapSec(raw, gridStep());
        setRange(
          Math.abs(raw - a) * pps < 3
            ? null
            : { start: Math.min(a, b), end: Math.max(a, b) },
        );
      }
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
        zcTimelineFrame(clip, frame).then((f) =>
          api.trimEnd(clip.id, Math.max(clip.timeline_start + 1, f)),
        );
    } else if (d.kind === "trim-start" && clip) {
      const frame = Math.round(snapSec(xToSec(mouse.current.x), step) * sr);
      if (frame !== clip.timeline_start)
        zcTimelineFrame(clip, frame).then((f) => api.trimStart(clip.id, f));
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
    } else if (d.kind === "range") {
      const a = d.anchorSec;
      const raw = Math.max(0, xToSec(mouse.current.x));
      if (Math.abs(raw - a) * pps < 3) {
        // No real drag: behave like the old empty-lane click (seek + clear).
        setRange(null);
        seek(Math.round(snapToGrid(raw) * sr));
      } else {
        const b = snapSec(raw, step);
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        setRange(end > start ? { start, end } : null);
        seek(Math.round(start * sr)); // Space then plays the selection
      }
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
    } else {
      // Double-click a clip body: select exactly the clip's time range
      // (Audacity's double-click-selects-clip), ready for loop/delete/zoom.
      setSelected(hit.clip.id);
      setRange({
        start: hit.clip.timeline_start / sr,
        end: (hit.clip.timeline_start + clipLen(hit.clip)) / sr,
      });
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
        `Placed at ${fmtTimecode(start / sr)} - no room at the drop point.`,
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

  // Map a timeline frame on `clip` to the nearest source zero crossing and back.
  // Timeline and source stay locked (t - timeline_start == s - source_in).
  const zcTimelineFrame = useCallback(
    async (clip: ClipView, timelineFrame: number): Promise<number> => {
      if (!zeroCross) return timelineFrame;
      const sf = clip.source_in + (timelineFrame - clip.timeline_start);
      if (sf <= 0) return timelineFrame;
      try {
        const zf = await zeroCrossing(clip.source_id, Math.round(sf));
        return timelineFrame + (zf - Math.round(sf));
      } catch {
        return timelineFrame; // engine unavailable - edit still applies unsnapped
      }
    },
    [zeroCross],
  );

  const splitAtPlayhead = useCallback(async () => {
    const c = project && selected ? findClip(project, selected) : null;
    if (!c || !selected) return;
    let frame = Math.round(playheadSec * sr);
    const adj = await zcTimelineFrame(c, frame);
    // Only keep the snap when it stays strictly inside the clip.
    if (adj > c.timeline_start && adj < c.timeline_start + clipLen(c))
      frame = adj;
    api.split(selected, frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected, playheadSec, sr, api, zcTimelineFrame]);

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
        `Take placed at ${fmtTimecode(startS)} - the watched position was occupied.`,
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

  // Paste the clipboard clip onto `track` at `wanted` (frames), selecting what
  // landed. Shared by ⌘V (playhead) and the right-click "Paste here".
  const pasteAtPos = useCallback(
    async (track: ProjectView["tracks"][number], wanted: number) => {
      const c = clipboard.current;
      if (!c || !project) return;
      // The clipboard source must still exist (New/Open can replace the pool).
      if (!project.sources.some((s) => s.id === c.source_id)) {
        clipboard.current = null;
        setHasClipboard(false);
        onNotice(
          "The clipboard clip's audio is no longer in this project - clipboard cleared.",
        );
        return;
      }
      const len = c.source_out - c.source_in;
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
          `Pasted at ${fmtTimecode(start / sr)} - no room at that position.`,
        );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [project, sr, api, onNotice, revealSec],
  );

  const pasteAtPlayhead = useCallback(async () => {
    if (!project) return;
    const track =
      project.tracks.find((t) => t.id === effArmedId) ?? project.tracks[0];
    if (!track) return;
    await pasteAtPos(track, Math.round(playheadSec * sr));
  }, [effArmedId, project, playheadSec, sr, pasteAtPos]);

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
        `Duplicated to ${fmtTimecode(start / sr)} - no room at the wanted spot.`,
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

  // Zoom to the time-range selection when present, else the selected clip
  // (Audacity "Zoom to Selection").
  const zoomToSelection = useCallback(() => {
    let startS: number;
    let lenS: number;
    if (range) {
      startS = range.start;
      lenS = range.end - range.start;
    } else {
      const c = project && selected ? findClip(project, selected) : null;
      if (!c) return;
      startS = c.timeline_start / sr;
      lenS = clipLen(c) / sr;
    }
    if (lenS <= 0) return;
    setPps(clampPps((width * 0.9) / lenS));
    setScrollSec(Math.max(0, startS - lenS * 0.05));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected, range, sr, width]);

  // Delete the selected time range across all tracks (honors the Ripple toggle).
  const deleteRangeSel = useCallback(async () => {
    if (!range) return;
    await api.deleteRange(
      Math.round(range.start * sr),
      Math.round(range.end * sr),
      ripple,
    );
    setRange(null);
  }, [range, sr, api, ripple]);

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

  // ---- Follow the moving head: playback playhead OR the recording write-head ----
  // Recording isn't playback here (the playhead stays put), so the follow logic
  // tracks the live take's leading edge while capturing (recElapsed ticks ~10 Hz).
  useEffect(() => {
    if (!followPlayhead || width <= 0) return;
    if (!playing && !recording) return;
    const head = recording ? recStartSec.current + recElapsed : playheadSec;
    const viewSec = width / pps;
    // Re-page when the head crosses the right edge or falls off the left.
    if (head > scrollSec + viewSec * 0.92)
      setScrollSec(Math.max(0, head - viewSec * 0.15));
    else if (head < scrollSec)
      setScrollSec(Math.max(0, head - viewSec * 0.15));
  }, [
    followPlayhead,
    playing,
    recording,
    recElapsed,
    playheadSec,
    pps,
    width,
    scrollSec,
  ]);

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
    seekBy: (deltaSec: number) =>
      seek(Math.max(0, Math.round((playheadSec + deltaSec) * sr))),
    zoomStep,
    hasRange: !!range,
    clearRange: () => setRange(null),
    deleteRangeSel,
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
    seekBy: (deltaSec: number) =>
      seek(Math.max(0, Math.round((playheadSec + deltaSec) * sr))),
    zoomStep,
    hasRange: !!range,
    clearRange: () => setRange(null),
    deleteRangeSel,
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
        } else if (k.hasRange) {
          e.preventDefault();
          k.deleteRangeSel();
        }
      } else if (e.key === "ArrowLeft" && !mod) {
        e.preventDefault();
        if (k.selected) k.nudgeSelected(-1, e.shiftKey);
        else k.seekBy(e.shiftKey ? -5 : -1); // cursor seek, Audacity-style
      } else if (e.key === "ArrowRight" && !mod) {
        e.preventDefault();
        if (k.selected) k.nudgeSelected(1, e.shiftKey);
        else k.seekBy(e.shiftKey ? 5 : 1);
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
        // Hierarchical Escape (W-03/W-25): stop playback, then the time range,
        // then the clip selection. Popovers/overlay consume Escape earlier.
        if (k.playing) k.stopPlay();
        else if (k.hasRange) k.clearRange();
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

  // ---- Right-click menus (QoL): clip / lane / ruler ----
  const onCanvasContext = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!project) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitTest(x, y);
    if (hit && (hit.zone === "fade-in" || hit.zone === "fade-out")) {
      const clip = hit.clip;
      const isIn = hit.zone === "fade-in";
      setSelected(clip.id);
      const curCurve = (
        isIn ? clip.fade_in_curve : clip.fade_out_curve
      ) as FadeCurve;
      const curLen = isIn ? clip.fade_in_len : clip.fade_out_len;
      const apply = (len: number, curve: FadeCurve) =>
        isIn
          ? api.setFadeIn(clip.id, len, curve)
          : api.setFadeOut(clip.id, len, curve);
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          ...(["linear", "equal_power", "log", "s_curve"] as FadeCurve[]).map(
            (cv) => ({
              label: `${cv === curCurve ? "● " : "○ "}${CURVE_NAMES[cv]}`,
              onClick: () => apply(curLen, cv),
            }),
          ),
          "sep" as const,
          {
            label: "Fast (30 ms)",
            onClick: () => apply(Math.round(0.03 * sr), curCurve),
          },
          {
            label: "Medium (250 ms)",
            onClick: () => apply(Math.round(0.25 * sr), curCurve),
          },
          {
            label: "Long (1 s)",
            onClick: () => apply(sr, curCurve),
          },
          "sep" as const,
          {
            label: `Remove fade-${isIn ? "in" : "out"}`,
            danger: true,
            disabled: curLen <= 0,
            onClick: () => apply(0, curCurve),
          },
        ],
      });
      return;
    }
    if (hit) {
      const clip = hit.clip;
      setSelected(clip.id);
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Split at playhead", shortcut: "S", onClick: splitAtPlayhead },
          { label: "Duplicate", shortcut: "⌘D", onClick: duplicateSel },
          "sep",
          { label: "Cut", shortcut: "⌘X", onClick: cutSel },
          { label: "Copy", shortcut: "⌘C", onClick: copySel },
          {
            label: "Paste at playhead",
            shortcut: "⌘V",
            disabled: !hasClipboard,
            onClick: pasteAtPlayhead,
          },
          "sep",
          {
            label: "Split into mono channels",
            onClick: () => api.splitChannels(clip.id),
          },
          {
            label: "Normalize to -1 dB",
            onClick: () => {
              const lvl = peaks.current.get(clip.source_id)?.levels[0];
              if (!lvl) return;
              const ch = lvl.channels;
              const b0 = Math.floor(clip.source_in / lvl.framesPerBucket);
              const b1 = Math.min(
                lvl.numBuckets - 1,
                Math.floor(clip.source_out / lvl.framesPerBucket),
              );
              let peak = 0;
              for (let b = b0; b <= b1; b++)
                for (let c = 0; c < ch; c++)
                  peak = Math.max(
                    peak,
                    Math.abs(lvl.mins[b * ch + c]),
                    Math.abs(lvl.maxs[b * ch + c]),
                  );
              if (peak <= 0.0001) {
                onNotice("Clip is silent - nothing to normalize.");
                return;
              }
              const gain = Math.max(
                -24,
                Math.min(12, -1 - 20 * Math.log10(peak)),
              );
              api.setClipGain(clip.id, Math.round(gain * 10) / 10);
            },
          },
          {
            label: "Select clip range",
            onClick: () =>
              setRange({
                start: clip.timeline_start / sr,
                end: (clip.timeline_start + clipLen(clip)) / sr,
              }),
          },
          { label: "Zoom to clip", shortcut: "E", onClick: zoomToSelection },
          "sep",
          {
            label: "Delete",
            shortcut: "⌫",
            danger: true,
            onClick: () => {
              api.del(clip.id, ripple);
              setSelected(null);
            },
          },
        ],
      });
      return;
    }
    const ti = trackIndexAtY(y);
    const track = project.tracks[ti];
    const frame = Math.round(Math.max(0, xToSec(x)) * sr);
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Paste here",
          disabled: !hasClipboard || !track,
          onClick: () => track && pasteAtPos(track, frame),
        },
        { label: "Add track", onClick: () => api.addTrack() },
        ...(range
          ? ([
              "sep",
              {
                label: loopOn ? "Stop looping range" : "Loop range",
                onClick: () => setLoopOn((l) => !l),
              },
              {
                label: "Delete range",
                shortcut: "⌫",
                danger: true,
                onClick: deleteRangeSel,
              },
              { label: "Clear range", onClick: () => setRange(null) },
            ] as const)
          : []),
      ],
    });
  };

  const onRulerContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const frame = Math.round(snapToGrid(Math.max(0, rulerSec(e))) * sr);
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Play from here", onClick: () => startPlay(frame) },
        { label: "Seek to here", onClick: () => seek(frame) },
        "sep",
        { label: "Fit project", shortcut: "F", onClick: fitToWindow },
      ],
    });
  };

  // Timeline quick-play (Audacity): double-click the ruler to play from there.
  const onRulerDouble = (e: React.MouseEvent) => {
    const frame = Math.round(snapToGrid(Math.max(0, rulerSec(e))) * sr);
    if (playing) seek(frame);
    else startPlay(frame);
  };

  return (
    <div className="waveform">
      <div className="wave-toolbar" ref={toolbarRef}>
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
                  : `Record (Shift+R) - nothing armed, take appends to ${project?.tracks[0]?.name ?? "a new track"}`
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
          <button
            type="button"
            className="transport skip"
            onClick={() => seek(0)}
            title="Go to start (Home)"
            aria-label="Go to start"
          >
            <IconSkipStart size={14} />
          </button>
          <button
            type="button"
            className="transport skip"
            onClick={() => seek(Math.round(contentEndSec() * sr))}
            title="Go to end (End)"
            aria-label="Go to end"
          >
            <IconSkipEnd size={14} />
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
        <MasterMeter playing={playing && !paused} />
        <div className="speed-controls" title="Playback speed">
          <select
            className="speed-select"
            value={playSpeed}
            onChange={(e) => setPlaySpeed(Number(e.target.value))}
            aria-label="Playback speed"
          >
            <option value={0.5}>0.5x</option>
            <option value={0.75}>0.75x</option>
            <option value={1}>1x</option>
            <option value={1.25}>1.25x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
          </select>
          {playSpeed !== 1 && (
            <button
              type="button"
              className={`tbtn icon-only${preservePitch ? " active" : ""}`}
              onClick={() => setPreservePitch((p) => !p)}
              title={
                preservePitch
                  ? "Preserving pitch (stretch) - click for tape-style repitch"
                  : "Tape-style repitch (pitch follows speed) - click to preserve pitch"
              }
              aria-label="Preserve pitch"
              aria-pressed={preservePitch}
            >
              <IconZeroCross />
            </button>
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
        {tbWide && (
        <button
          type="button"
          className="tbtn icon-only"
          onClick={fitToWindow}
          title="Fit project to window (F)"
          aria-label="Fit to window"
        >
          <IconFit />
        </button>
        )}
        {tbWide && (
        <>
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
          title="Snap to grid (N) - hold Alt while dragging to bypass"
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
        <button
          type="button"
          className={`tbtn icon-only${loopOn && range ? " active" : ""}`}
          disabled={!range && !loopOn}
          onClick={() => setLoopOn((l) => !l)}
          title={
            range
              ? "Loop the selected range during playback"
              : "Loop - drag across empty lane space to select a range first"
          }
          aria-label="Loop selection"
          aria-pressed={loopOn}
        >
          <IconLoop />
        </button>
        <button
          type="button"
          className={`tbtn icon-only${zeroCross ? " active" : ""}`}
          onClick={() => setZeroCross((z) => !z)}
          title="Snap splits & trims to zero crossings (click-free cuts)"
          aria-label="Snap to zero crossings"
          aria-pressed={zeroCross}
        >
          <IconZeroCross />
        </button>
        <div
          className="grid-controls"
          title="Beat grid - playhead & edits snap to it"
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
        </>
        )}
        <span className="tb-sep" />
        {!tbWide && (
          <>
            <button
              type="button"
              className="tbtn"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setCtxMenu({
                  x: r.left,
                  y: r.bottom + 4,
                  items: [
                    { label: "Split at playhead", shortcut: "S", disabled: !selected, onClick: splitAtPlayhead },
                    { label: "Duplicate", shortcut: "⌘D", disabled: !selected, onClick: duplicateSel },
                    { label: "Cut", shortcut: "⌘X", disabled: !selected, onClick: cutSel },
                    { label: "Copy", shortcut: "⌘C", disabled: !selected, onClick: copySel },
                    { label: "Paste", shortcut: "⌘V", disabled: !hasClipboard, onClick: pasteAtPlayhead },
                    { label: "Split into mono channels", disabled: !selected, onClick: () => selected && api.splitChannels(selected) },
                    "sep",
                    { label: `${ripple ? "✓ " : ""}Ripple delete`, onClick: () => setRipple((r) => !r) },
                    { label: "Delete clip", shortcut: "⌫", danger: true, disabled: !selected, onClick: () => { if (selected) { api.del(selected, ripple); setSelected(null); } } },
                  ],
                });
              }}
              title="Edit actions"
              aria-haspopup="menu"
            >
              <IconCut />
              <span>Edit</span>
            </button>
            <button
              type="button"
              className="tbtn"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setCtxMenu({
                  x: r.left,
                  y: r.bottom + 4,
                  items: [
                    { label: "Fit project", shortcut: "F", onClick: fitToWindow },
                    { label: "Zoom to selection", shortcut: "E", disabled: !selected && !range, onClick: zoomToSelection },
                    { label: "Fold / unfold all tracks", shortcut: "T", onClick: foldAll },
                    "sep",
                    { label: `${snapEnabled ? "✓ " : ""}Snap`, shortcut: "N", onClick: () => setSnapEnabled((v) => !v) },
                    { label: `${followPlayhead ? "✓ " : ""}Follow playhead`, onClick: () => setFollowPlayhead((v) => !v) },
                    { label: `${loopOn ? "✓ " : ""}Loop range`, disabled: !range && !loopOn, onClick: () => setLoopOn((v) => !v) },
                    { label: `${zeroCross ? "✓ " : ""}Zero-crossing snap`, onClick: () => setZeroCross((v) => !v) },
                    { label: `${beatGrid ? "✓ " : ""}Beat grid`, onClick: () => setBeatGrid((v) => !v) },
                  ],
                });
              }}
              title="View options"
              aria-haspopup="menu"
            >
              <IconGrid />
              <span>View</span>
            </button>
          </>
        )}
        {tbWide && (
        <>
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
        </>
        )}
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
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setCtxMenu({
              x: r.left,
              y: r.bottom + 4,
              items: [
                {
                  label: "Quick guide",
                  onClick: () => setShowGuide(true),
                },
                {
                  label: "Keyboard shortcuts",
                  shortcut: "?",
                  onClick: () => setShowShortcuts(true),
                },
              ],
            });
          }}
          title="Help"
          aria-label="Help"
          aria-haspopup="menu"
        >
          <IconHelp />
        </button>
        {range && (
          <span
            className="sel-readout"
            title="Selection start - end (length)"
            aria-label={`Selection from ${fmtTimecode(range.start)} to ${fmtTimecode(range.end)}`}
          >
            {fmtTimecode(range.start)}-{fmtTimecode(range.end)} (
            {fmtTimecode(range.end - range.start)})
          </span>
        )}
      </div>
      <div className="wave-body">
        {/* Sticky ruler row: a fixed spacer over the track headers + the ruler canvas,
            outside the vertical scroll so the time/bar labels stay visible. */}
        <div className="wave-ruler-row">
          <div className="wave-ruler-spacer" style={{ width: gutterW }} />
          <div
            className="panel-resize gutter-resize"
            role="separator"
            aria-label="Resize track controls"
            onMouseDown={(e) => {
              e.preventDefault();
              gutterDrag.current = { x: e.clientX, w: gutterW };
            }}
          />
          <canvas
            ref={rulerRef}
            className="wave-ruler-canvas"
            style={{ width: "100%", cursor: "ew-resize" }}
            onMouseDown={onRulerDown}
            onMouseMove={onRulerMove}
            onMouseUp={onRulerUp}
            onMouseLeave={onRulerUp}
            onDoubleClick={onRulerDouble}
            onContextMenu={onRulerContext}
          />
        </div>
        <div className="wave-scroll">
          <TrackHeaders
            project={project}
            api={api}
            width={gutterW}
            armedTrackId={effArmedId}
            inputLevels={inputLevels}
            onToggleArm={toggleArm}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
          />
          <div
            className="panel-resize gutter-resize"
            role="separator"
            aria-label="Resize track controls"
            onMouseDown={(e) => {
              e.preventDefault();
              gutterDrag.current = { x: e.clientX, w: gutterW };
            }}
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
                onContextMenu={onCanvasContext}
                onWheel={onWheel}
              />
            )}
          </div>
        </div>
      </div>
      <Inspector project={project} selected={selected} api={api} sr={sr} />
      {ctxMenu && (
        <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      )}
      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}
      {showGuide && <GuideOverlay onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/** Quick guide: how the core loops work, in four short panels. */
function GuideOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);
  const sections: { title: string; body: string }[] = [
    {
      title: "Record",
      body: "Arm a track with its round button (or R with a clip selected), then hit the red transport key or Shift+R. The armed track shows a live input meter and the view follows the take. Space stops capture. The finished take is selected automatically. Nothing armed? The take appends to track 1.",
    },
    {
      title: "Edit",
      body: "Click selects a clip; drag moves it, edges trim, top corners shape fades (right-click a corner for curve and length presets). S splits at the playhead. Cuts snap to zero crossings while the sine toggle is on. Everything is non-destructive and undoable.",
    },
    {
      title: "Ranges + loops",
      body: "Drag across empty lane space to select a time range (it snaps to clip edges; double-click a clip to select exactly its span). E zooms to it, Delete removes it on every track (Ripple closes the gap), and the loop toggle cycles playback over it.",
    },
    {
      title: "Files",
      body: "Cmd+S saves the project; the dot by the name means unsaved changes. Add audio via Import or the Media drawer, drag items onto tracks or press Enter to place them at the playhead. Export renders a mixdown; format lives in the export popover.",
    },
  ];
  return (
    <div
      className="shortcuts-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Quick guide"
      onMouseDown={onClose}
    >
      <div className="shortcuts-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <h2>Quick guide</h2>
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
        <div className="guide-body">
          {sections.map((sec) => (
            <section key={sec.title} className="guide-section">
              <h3>{sec.title}</h3>
              <p>{sec.body}</p>
            </section>
          ))}
        </div>
      </div>
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
        ["Drag empty lane", "Select a time range (snaps to clip edges)"],
        ["Double-click clip", "Select exactly the clip's range"],
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
        ["← / →", "Nudge clip · seek when none selected"],
        ["Delete / Backspace", "Delete clip (or the selected range)"],
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
