import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ClipView, ProjectView } from "../audio/project";
import {
  pausePlayback,
  play,
  playbackStatus,
  stopPlayback,
} from "../audio/project";
import type { ProjectApi } from "../audio/useProject";
import {
  fetchPeaks,
  pickLevel,
  type PeakLevel,
  type PeakPyramid,
} from "../audio/peaks";

interface Props {
  project: ProjectView | null;
  api: ProjectApi;
  outputId: string | null;
}

const TRACK_HEIGHT = 88;
const RULER_HEIGHT = 22;
const EDGE_PX = 6;
const SNAP_PX = 8;
const MIN_PPS = 2;
const MAX_PPS = 6000;

const C = {
  bg: "#0e1116",
  ruler: "#8b97a6",
  grid: "#1c232e",
  lane: "#12161c",
  laneAlt: "#0f1319",
  clip: "#16324a",
  clipSel: "#1d4a6b",
  clipEdge: "#2b6a93",
  clipEdgeSel: "#4cc2ff",
  wave: "#4cc2ff",
  waveSel: "#8fd6ff",
  playhead: "#f85149",
  snap: "#d29922",
};

type Drag =
  | { kind: "move"; clipId: string; grabSec: number }
  | { kind: "trim-start"; clipId: string }
  | { kind: "trim-end"; clipId: string }
  | { kind: "fade-in"; clipId: string }
  | { kind: "fade-out"; clipId: string }
  | { kind: "scrub" }
  | null;

// fade-in gain shape mirror of waver_core::FadeCurve::fade_in_gain.
function fadeGain(curve: string, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  if (curve === "equal_power") return Math.sin((c * Math.PI) / 2);
  if (curve === "log") return c * c;
  return c;
}

export function WaveformTimeline({ project, api, outputId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const peaks = useRef<Map<string, PeakPyramid>>(new Map());
  const drag = useRef<Drag>(null);
  const mouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const snapLine = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const [width, setWidth] = useState(800);
  const [pps, setPps] = useState(120);
  const [scrollSec, setScrollSec] = useState(0);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [ripple, setRipple] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [, tick] = useState(0);

  const sr = project?.sample_rate ?? 48000;

  // ---- Transport (FR-6.1/6.2) ----
  const startPlay = useCallback(() => {
    if (!outputId || !project) return;
    play(outputId, Math.round(playheadSec * sr))
      .then(() => {
        setPlaying(true);
        setPaused(false);
      })
      .catch(() => {});
  }, [outputId, project, playheadSec, sr]);

  const togglePause = useCallback(() => {
    const next = !paused;
    pausePlayback(next).catch(() => {});
    setPaused(next);
  }, [paused]);

  const stopPlay = useCallback(() => {
    stopPlayback().catch(() => {});
    setPlaying(false);
    setPaused(false);
  }, []);

  // Poll the transport while playing; the playhead follows the audible output.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let alive = true;
    const poll = async () => {
      try {
        const st = await playbackStatus();
        if (!alive) return;
        setPlayheadSec(st.position_frames / sr);
        if (!st.playing) {
          setPlaying(false);
          setPaused(false);
          return;
        }
      } catch {
        /* ignore */
      }
      if (alive) raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [playing, sr]);
  const clipLen = (c: ClipView) => c.source_out - c.source_in;

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
    ).then(() => !cancelled && tick((n) => n + 1));
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

  // ---- Snapping ----
  const snapSec = useCallback(
    (sec: number, gridStep: number): number => {
      const candidates: number[] = [playheadSec];
      // grid
      candidates.push(Math.round(sec / gridStep) * gridStep);
      // clip edges — but never snap the dragged clip to its own edges, which would
      // pin it in place and block fine moves.
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

  const gridStep = useCallback(() => {
    const raw = 80 / pps;
    const steps = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
    return steps.find((s) => s >= raw) ?? 600;
  }, [pps]);

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
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    const step = gridStep();

    // Track lanes.
    (project?.tracks ?? []).forEach((_t, i) => {
      ctx.fillStyle = i % 2 ? C.laneAlt : C.lane;
      ctx.fillRect(0, RULER_HEIGHT + i * TRACK_HEIGHT, width, TRACK_HEIGHT);
    });

    // Ruler + gridlines.
    ctx.fillStyle = C.ruler;
    ctx.font = "10px system-ui, sans-serif";
    ctx.strokeStyle = C.grid;
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

    // Clips.
    (project?.tracks ?? []).forEach((track, ti) => {
      const laneTop = RULER_HEIGHT + ti * TRACK_HEIGHT + 4;
      const laneH = TRACK_HEIGHT - 8;
      for (const clip of track.clips) {
        // If this clip is being move-dragged, draw it as a ghost at cursor instead.
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
        // Trim ghosts.
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
        ctx.fillStyle = isSel ? C.clipSel : C.clip;
        ctx.globalAlpha = ghost ? 0.6 : 1;
        ctx.fillRect(x0, drawTop, w, laneH);
        ctx.strokeStyle = isSel ? C.clipEdgeSel : C.clipEdge;
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
        );
        ctx.globalAlpha = 1;
      }
    });

    // Snap guide line.
    if (drag.current && snapLine.current != null) {
      const x = (snapLine.current - scrollSec) * pps;
      if (x >= 0 && x <= width) {
        ctx.strokeStyle = C.snap;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_HEIGHT);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Playhead.
    const px = (playheadSec - scrollSec) * pps;
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = C.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
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
  ]);

  drawRef.current = draw;
  useEffect(() => {
    draw();
  }, [draw]);

  const xToSec = useCallback(
    (x: number) => scrollSec + x / pps,
    [scrollSec, pps],
  );

  // ---- Mouse interaction ----
  type Zone = "trim-start" | "trim-end" | "fade-in" | "fade-out" | "body";
  const hitTest = (
    x: number,
    y: number,
  ): { clip: ClipView; zone: Zone } | null => {
    if (!project || y < RULER_HEIGHT) return null;
    const ti = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
    const track = project.tracks[ti];
    if (!track) return null;
    const laneTop = RULER_HEIGHT + ti * TRACK_HEIGHT + 4;
    const inTopStrip = y <= laneTop + 14;
    const FADE_ZONE = 22;
    for (const clip of track.clips) {
      const x0 = (clip.timeline_start / sr - scrollSec) * pps;
      const w = (clipLen(clip) / sr) * pps;
      if (x < x0 - EDGE_PX || x > x0 + w + EDGE_PX) continue;
      // Fade handles live in the top strip near each corner.
      if (inTopStrip && x >= x0 && x <= x0 + FADE_ZONE)
        return { clip, zone: "fade-in" };
      if (inTopStrip && x >= x0 + w - FADE_ZONE && x <= x0 + w)
        return { clip, zone: "fade-out" };
      if (Math.abs(x - x0) <= EDGE_PX) return { clip, zone: "trim-start" };
      if (Math.abs(x - (x0 + w)) <= EDGE_PX) return { clip, zone: "trim-end" };
      if (x >= x0 && x <= x0 + w) return { clip, zone: "body" };
    }
    return null;
  };

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
    if (drag.current && drag.current.kind === "scrub") {
      setPlayheadSec(Math.max(0, xToSec(mouse.current.x)));
    }
    if (drag.current) drawRef.current();
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
      // Only commit an actual change — a plain click to select must not push a
      // no-op move (which would pollute undo history and wipe the redo stack).
      if (
        track &&
        (track.id !== curTrack?.id || newStart !== clip.timeline_start)
      ) {
        api.move(clip.id, track.id, newStart);
      }
    } else if (d.kind === "trim-end" && clip) {
      const end = snapSec(xToSec(mouse.current.x), step);
      const frame = Math.round(end * sr);
      if (frame !== clip.timeline_start + clipLen(clip))
        api.trimEnd(clip.id, frame);
    } else if (d.kind === "trim-start" && clip) {
      const ns = snapSec(xToSec(mouse.current.x), step);
      const frame = Math.round(ns * sr);
      if (frame !== clip.timeline_start) api.trimStart(clip.id, frame);
    } else if (d.kind === "fade-in" && clip) {
      // Fade length = distance from the clip start to the cursor.
      const lenFrames = Math.max(
        0,
        Math.round((xToSec(mouse.current.x) - clip.timeline_start / sr) * sr),
      );
      api.setFadeIn(
        clip.id,
        lenFrames,
        clip.fade_in_curve as "linear" | "equal_power" | "log",
      );
    } else if (d.kind === "fade-out" && clip) {
      const clipEndSec = (clip.timeline_start + clipLen(clip)) / sr;
      const lenFrames = Math.max(
        0,
        Math.round((clipEndSec - xToSec(mouse.current.x)) * sr),
      );
      api.setFadeOut(
        clip.id,
        lenFrames,
        clip.fade_out_curve as "linear" | "equal_power" | "log",
      );
    }
    tick((n) => n + 1);
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

  // Split the selected clip at the playhead.
  const splitAtPlayhead = useCallback(() => {
    if (!selected) return;
    api.split(selected, Math.round(playheadSec * sr));
  }, [selected, playheadSec, sr, api]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT"))
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? api.redo() : api.undo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selected) {
          e.preventDefault();
          api.del(selected, ripple);
          setSelected(null);
        }
      } else if (e.key.toLowerCase() === "s") {
        splitAtPlayhead();
      } else if (e.key === " ") {
        e.preventDefault();
        if (playing) togglePause();
        else startPlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, selected, ripple, splitAtPlayhead, playing, togglePause, startPlay]);

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
      <div className="wave-canvas-wrap" ref={wrapRef}>
        {!project || project.tracks.length === 0 ? (
          <p className="wave-empty">
            Record a take to start building your timeline.
          </p>
        ) : (
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              cursor: drag.current ? "grabbing" : "default",
            }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onWheel={onWheel}
          />
        )}
      </div>
      <Inspector project={project} selected={selected} api={api} sr={sr} />
    </div>
  );
}

function Inspector({
  project,
  selected,
  api,
  sr,
}: {
  project: ProjectView | null;
  selected: string | null;
  api: ProjectApi;
  sr: number;
}) {
  if (!project || !selected) {
    return (
      <div className="inspector empty">
        Select a clip to edit its gain and fades.
      </div>
    );
  }
  let clip: ClipView | undefined;
  let track = project.tracks.find((t) => {
    const c = t.clips.find((c) => c.id === selected);
    if (c) clip = c;
    return !!c;
  });
  if (!clip || !track) {
    return (
      <div className="inspector empty">
        Select a clip to edit its gain and fades.
      </div>
    );
  }
  const c = clip;
  const t = track;
  const curves: ("linear" | "equal_power" | "log")[] = [
    "linear",
    "equal_power",
    "log",
  ];
  const msFrom = (frames: number) => Math.round((frames / sr) * 1000);
  const framesFrom = (ms: number) => Math.round((ms / 1000) * sr);

  return (
    <div className="inspector">
      <div className="insp-group">
        <span className="insp-label">Clip gain</span>
        <input
          type="range"
          min={-24}
          max={12}
          step={0.5}
          value={c.gain_db}
          onChange={(e) => api.setClipGain(c.id, Number(e.target.value))}
        />
        <span className="insp-val">{c.gain_db.toFixed(1)} dB</span>
      </div>
      <div className="insp-group">
        <span className="insp-label">Fade in</span>
        <input
          type="number"
          min={0}
          value={msFrom(c.fade_in_len)}
          onChange={(e) =>
            api.setFadeIn(
              c.id,
              framesFrom(Number(e.target.value)),
              c.fade_in_curve as never,
            )
          }
        />
        <span className="insp-unit">ms</span>
        <select
          value={c.fade_in_curve}
          onChange={(e) =>
            api.setFadeIn(c.id, c.fade_in_len, e.target.value as never)
          }
        >
          {curves.map((cv) => (
            <option key={cv} value={cv}>
              {cv}
            </option>
          ))}
        </select>
      </div>
      <div className="insp-group">
        <span className="insp-label">Fade out</span>
        <input
          type="number"
          min={0}
          value={msFrom(c.fade_out_len)}
          onChange={(e) =>
            api.setFadeOut(
              c.id,
              framesFrom(Number(e.target.value)),
              c.fade_out_curve as never,
            )
          }
        />
        <span className="insp-unit">ms</span>
        <select
          value={c.fade_out_curve}
          onChange={(e) =>
            api.setFadeOut(c.id, c.fade_out_len, e.target.value as never)
          }
        >
          {curves.map((cv) => (
            <option key={cv} value={cv}>
              {cv}
            </option>
          ))}
        </select>
      </div>
      <div className="insp-group">
        <span className="insp-label">Track “{t.name}” gain</span>
        <input
          type="range"
          min={-24}
          max={12}
          step={0.5}
          value={t.gain_db}
          onChange={(e) => api.setTrackGain(t.id, Number(e.target.value))}
        />
        <span className="insp-val">{t.gain_db.toFixed(1)} dB</span>
      </div>
    </div>
  );
}

// ---- helpers ----

function drawFade(
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
) {
  if (fadeFrames <= 0) return;
  const fadeW = Math.min(w, (fadeFrames / sr) * pps);
  if (fadeW < 1) return;
  const steps = Math.max(2, Math.min(200, Math.floor(fadeW)));
  ctx.beginPath();
  if (side === "in") {
    ctx.moveTo(x0, top + laneH);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(x0 + t * fadeW, top + laneH - fadeGain(curve, t) * laneH);
    }
    ctx.lineTo(x0, top);
  } else {
    const xr = x0 + w;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(
        xr - fadeW + t * fadeW,
        top + laneH - fadeGain(curve, 1 - t) * laneH,
      );
    }
    ctx.lineTo(xr, top + laneH);
    ctx.lineTo(xr, top);
    ctx.lineTo(xr - fadeW, top);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(14,17,22,0.55)"; // darken the attenuated region
  ctx.fill();
  ctx.strokeStyle = C.snap;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function fmtTime(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const dp = step < 1 ? 2 : 0;
  return m > 0
    ? `${m}:${s.toFixed(dp).padStart(dp ? 5 : 2, "0")}`
    : `${s.toFixed(dp)}s`;
}

function findClip(project: ProjectView, id: string): ClipView | undefined {
  for (const t of project.tracks) {
    const c = t.clips.find((c) => c.id === id);
    if (c) return c;
  }
  return undefined;
}

function laneTopForY(y: number, project: ProjectView | null): number | null {
  if (!project) return null;
  const ti = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
  if (ti < 0 || ti >= project.tracks.length) return null;
  return RULER_HEIGHT + ti * TRACK_HEIGHT + 4;
}

function drawClipWave(
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

  ctx.fillStyle = selected ? C.waveSel : C.wave;
  const pxStart = Math.max(0, Math.floor(x0));
  const pxEnd = Math.min(viewWidth, Math.ceil(x0 + w));

  for (let px = pxStart; px < pxEnd; px++) {
    // Source frame at this pixel = clip source_in + offset into the clip.
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
      const mid = top + laneIdx * perChanH + perChanH / 2;
      const y1 = mid - hi * (perChanH / 2) * 0.95;
      const y2 = mid - lo * (perChanH / 2) * 0.95;
      ctx.fillRect(px, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
    });
  }
}
