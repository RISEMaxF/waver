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
import { setRecordTarget } from "../audio/project";
import type { ProjectApi } from "../audio/useProject";
import { useTransport } from "../audio/useTransport";
import { fetchPeaks, type PeakPyramid } from "../audio/peaks";
import { Inspector } from "./timeline/Inspector";
import { TrackHeaders } from "./timeline/TrackHeaders";
import {
  drawClipWave,
  drawFade,
  findClip,
  fmtTime,
  laneTopForY,
  readCanvasTheme,
  type CanvasTheme,
  EDGE_PX,
  MAX_PPS,
  MIN_PPS,
  RULER_HEIGHT,
  SNAP_PX,
  TRACK_HEIGHT,
} from "./timeline/renderer";

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
  recWave: RecWaveRef;
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
  recWave,
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
  const [armedTrackId, setArmedTrackId] = useState<string | null>(null);
  const [, tick] = useState(0);
  // Snapshot of where/when the current recording began (for the live overlay).
  const recStartSec = useRef(0);
  const recTrackId = useRef<string | null>(null);
  const prevRecording = useRef(false);

  const sr = project?.sample_rate ?? 48000;
  const clipLen = (c: ClipView) => c.source_out - c.source_in;

  const { playing, paused, startPlay, togglePause, stopPlay } = useTransport({
    outputId,
    hasContent: !!project && project.tracks.length > 0,
    startFrame: Math.round(playheadSec * sr),
    sr,
    onPosition: setPlayheadSec,
  });

  // Keep the armed track valid: default to the newest track; clear when none exist.
  useEffect(() => {
    const ids = project?.tracks.map((t) => t.id) ?? [];
    if (armedTrackId && ids.includes(armedTrackId)) return;
    setArmedTrackId(ids.length ? ids[ids.length - 1] : null);
  }, [project, armedTrackId]);

  // Tell the backend where the next take lands (armed track + playhead), except while
  // playing/recording where the target must stay fixed.
  useEffect(() => {
    if (playing || recording) return;
    setRecordTarget(armedTrackId, Math.round(playheadSec * sr)).catch(() => {});
  }, [armedTrackId, playheadSec, playing, recording, sr]);

  // On the record rising edge, snapshot where/when it began for the live overlay.
  useEffect(() => {
    if (recording && !prevRecording.current) {
      recStartSec.current = playheadSec;
      recTrackId.current = armedTrackId;
    }
    prevRecording.current = recording;
  }, [recording, playheadSec, armedTrackId]);

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
    setArmedTrackId((cur) => (cur === id ? null : id));
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

  const height =
    RULER_HEIGHT + Math.max(1, project?.tracks.length ?? 1) * TRACK_HEIGHT;

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
      const candidates: number[] = [playheadSec, Math.round(sec / step) * step];
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
    [project, sr, pps, playheadSec],
  );

  // ---- Draw ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = theme.current;
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, width, height);

    const step = gridStep();

    (project?.tracks ?? []).forEach((_t, i) => {
      ctx.fillStyle = i % 2 ? th.laneAlt : th.lane;
      ctx.fillRect(0, RULER_HEIGHT + i * TRACK_HEIGHT, width, TRACK_HEIGHT);
    });

    ctx.fillStyle = th.ruler;
    ctx.font = "10px system-ui, sans-serif";
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    const first = Math.ceil(scrollSec / step) * step;
    for (let t = first; (t - scrollSec) * pps <= width; t += step) {
      const x = Math.round((t - scrollSec) * pps) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(fmtTime(t, step), x + 3, 14);
    }

    (project?.tracks ?? []).forEach((track, ti) => {
      const laneTop = RULER_HEIGHT + ti * TRACK_HEIGHT + 4;
      const laneH = TRACK_HEIGHT - 8;
      for (const clip of track.clips) {
        const d = drag.current;
        let startSec = clip.timeline_start / sr;
        let drawTop = laneTop;
        let ghost = false;
        if (d && d.kind === "move" && d.clipId === clip.id) {
          startSec = snapSec(xToSec(mouse.current.x) - d.grabSec, step);
          drawTop = laneTopForY(mouse.current.y, project) ?? laneTop;
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
        ctx.fillStyle = isSel ? th.clipSel : th.clip;
        ctx.globalAlpha = ghost ? 0.6 : 1;
        ctx.fillRect(x0, drawTop, w, laneH);
        ctx.strokeStyle = isSel ? th.clipEdgeSel : th.clipEdge;
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.strokeRect(
          Math.round(x0) + 0.5,
          drawTop + 0.5,
          Math.round(w),
          laneH - 1,
        );

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
          );

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
        ctx.moveTo(x + 0.5, RULER_HEIGHT);
        ctx.lineTo(x + 0.5, height);
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
      const liveId =
        recTrackId.current && tks.some((t) => t.id === recTrackId.current)
          ? recTrackId.current
          : armedTrackId;
      const ti = tks.findIndex((t) => t.id === liveId);
      if (ti >= 0) {
        const laneTop = RULER_HEIGHT + ti * TRACK_HEIGHT + 4;
        const laneH = TRACK_HEIGHT - 8;
        const mid = laneTop + laneH / 2;
        const start = recStartSec.current;
        const buckets = recWave.current.buckets;
        ctx.fillStyle = th.waveSel;
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i];
          const x = (start + b.t - scrollSec) * pps;
          if (x < -2 || x > width) continue;
          const next = buckets[i + 1];
          const bw = next ? Math.max(1, (next.t - b.t) * pps) : 1;
          const y1 = mid - b.max * (laneH / 2) * 0.95;
          const y2 = mid - b.min * (laneH / 2) * 0.95;
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
      ctx.lineTo(px, height);
      ctx.stroke();
      // Grabbable handle on the ruler — click/drag the ruler to move the start point.
      ctx.fillStyle = th.playhead;
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 9);
      ctx.closePath();
      ctx.fill();
    }
  }, [
    project,
    width,
    height,
    pps,
    scrollSec,
    playheadSec,
    selected,
    sr,
    gridStep,
    snapSec,
    xToSec,
    recording,
    recWave,
    armedTrackId,
  ]);

  drawRef.current = draw;
  useEffect(() => {
    draw();
  }, [draw]);

  // ---- Hit testing ----
  const hitTest = useCallback(
    (x: number, y: number): { clip: ClipView; zone: Zone } | null => {
      if (!project || y < RULER_HEIGHT) return null;
      const ti = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
      const track = project.tracks[ti];
      if (!track) return null;
      const laneTop = RULER_HEIGHT + ti * TRACK_HEIGHT + 4;
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
    [project, sr, scrollSec, pps],
  );

  const cursorFor = (zone: Zone | null): string =>
    zone === "trim-start" || zone === "trim-end"
      ? "col-resize"
      : zone === "fade-in" || zone === "fade-out"
        ? "pointer"
        : zone === "body"
          ? "grab"
          : "default";

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mouse.current = { x, y };
    const hit = hitTest(x, y);
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
      else
        drag.current = {
          kind: "move",
          clipId: id,
          grabSec: xToSec(x) - hit.clip.timeline_start / sr,
        };
    } else {
      setSelected(null);
      setPlayheadSec(Math.max(0, xToSec(x)));
      drag.current = { kind: "scrub" };
    }
    tick((n) => n + 1);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    mouse.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (drag.current) {
      if (drag.current.kind === "scrub")
        setPlayheadSec(Math.max(0, xToSec(mouse.current.x)));
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
      const ti = Math.floor((mouse.current.y - RULER_HEIGHT) / TRACK_HEIGHT);
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

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const cur = scrollSec + (e.clientX - rect.left) / pps;
      const np = Math.min(
        MAX_PPS,
        Math.max(MIN_PPS, pps * Math.exp(-e.deltaY * 0.002)),
      );
      setScrollSec(Math.max(0, cur - (e.clientX - rect.left) / np));
      setPps(np);
    } else {
      setScrollSec((s) => Math.max(0, s + (e.deltaX || e.deltaY) / pps));
    }
  };

  const splitAtPlayhead = useCallback(() => {
    if (selected) api.split(selected, Math.round(playheadSec * sr));
  }, [selected, playheadSec, sr, api]);

  // ---- Clipboard: copy / cut / paste / duplicate the selected clip ----
  const clipboard = useRef<ClipView | null>(null);
  const specFrom = (c: ClipView, timeline_start: number): ClipSpec => ({
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
    if (c) clipboard.current = c;
  }, [project, selected]);

  const cutSel = useCallback(() => {
    const c = project && selected ? findClip(project, selected) : null;
    if (c) {
      clipboard.current = c;
      api.del(c.id, false);
      setSelected(null);
    }
  }, [project, selected, api]);

  const pasteAtPlayhead = useCallback(() => {
    const c = clipboard.current;
    const trackId = armedTrackId ?? project?.tracks[0]?.id;
    if (!c || !trackId) return;
    api.paste(specFrom(c, Math.round(playheadSec * sr)), trackId);
  }, [armedTrackId, project, playheadSec, sr, api]);

  const duplicateSel = useCallback(() => {
    const c = project && selected ? findClip(project, selected) : null;
    if (!c) return;
    // Place the copy after the original, or at the playhead if that's later.
    const end = c.timeline_start + (c.source_out - c.source_in);
    api.duplicate(c.id, Math.max(end, Math.round(playheadSec * sr)));
  }, [project, selected, playheadSec, sr, api]);

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
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT"))
        return;
      const k = kb.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? k.api.redo() : k.api.undo();
      } else if (mod && key === "c") {
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
      } else if (key === "s" && !mod) {
        k.splitAtPlayhead();
      } else if (e.key === " ") {
        e.preventDefault();
        k.playing ? k.togglePause() : k.startPlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="waveform">
      <div className="wave-toolbar">
        <button
          type="button"
          className="transport"
          disabled={!outputId || !project || project.tracks.length === 0}
          onClick={playing ? togglePause : startPlay}
          title={playing ? "Pause / resume (space)" : "Play (space)"}
        >
          {playing && !paused ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          className="transport"
          disabled={!playing}
          onClick={stopPlay}
          title="Stop"
        >
          ⏹
        </button>
        <span className="tb-sep" />
        <button
          type="button"
          onClick={() => api.addTrack()}
          title="Add an empty track"
        >
          ＋ Track
        </button>
        <span className="tb-sep" />
        <button
          type="button"
          onClick={() => setPps((p) => Math.min(MAX_PPS, p * 1.5))}
        >
          Zoom +
        </button>
        <button
          type="button"
          onClick={() => setPps((p) => Math.max(MIN_PPS, p / 1.5))}
        >
          Zoom −
        </button>
        <span className="tb-sep" />
        <button
          type="button"
          disabled={!selected}
          onClick={splitAtPlayhead}
          title="Split at playhead (S)"
        >
          ✂ Split
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={duplicateSel}
          title="Duplicate clip (⌘/Ctrl+D)"
        >
          ⧉ Duplicate
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={cutSel}
          title="Cut clip (⌘/Ctrl+X)"
        >
          ✁ Cut
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={copySel}
          title="Copy clip (⌘/Ctrl+C)"
        >
          ⧉ Copy
        </button>
        <button
          type="button"
          onClick={pasteAtPlayhead}
          title="Paste at playhead on the armed track (⌘/Ctrl+V)"
        >
          ⊞ Paste
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && api.splitChannels(selected)}
          title="Split into mono channels"
        >
          ⑃ Channels
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (selected) {
              api.del(selected, ripple);
              setSelected(null);
            }
          }}
        >
          🗑 Delete
        </button>
        <label
          className="ripple-toggle"
          title="Ripple: shift later clips left on delete"
        >
          <input
            type="checkbox"
            checked={ripple}
            onChange={(e) => setRipple(e.target.checked)}
          />{" "}
          Ripple
        </label>
        <span className="tb-sep" />
        <button
          type="button"
          disabled={!project?.can_undo}
          onClick={() => api.undo()}
        >
          ↶ Undo
        </button>
        <button
          type="button"
          disabled={!project?.can_redo}
          onClick={() => api.redo()}
        >
          ↷ Redo
        </button>
        <span className="wave-info">
          {pps.toFixed(0)} px/s · {playheadSec.toFixed(2)}s
        </span>
      </div>
      <div className="wave-body">
        <TrackHeaders
          project={project}
          api={api}
          armedTrackId={armedTrackId}
          onToggleArm={toggleArm}
        />
        <div className="wave-canvas-wrap" ref={wrapRef}>
          {!project || project.tracks.length === 0 ? (
            <p className="wave-empty">
              Record or import audio to start your timeline.
            </p>
          ) : (
            <canvas
              ref={canvasRef}
              role="application"
              aria-label="Timeline editor"
              style={{
                width: "100%",
                cursor: drag.current ? "grabbing" : cursor,
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
      <Inspector project={project} selected={selected} api={api} sr={sr} />
    </div>
  );
}
