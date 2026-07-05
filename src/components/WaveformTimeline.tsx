import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RecordingResult } from "../audio/types";
import { fetchPeaks, pickLevel, type PeakPyramid } from "../audio/peaks";

interface Props {
  takes: RecordingResult[];
}

const TRACK_HEIGHT = 96;
const RULER_HEIGHT = 22;
const MIN_PPS = 2;
const MAX_PPS = 4000;

const COLORS = {
  bg: "#0e1116",
  ruler: "#8b97a6",
  gridline: "#232b36",
  clip: "#16324a",
  clipEdge: "#2b6a93",
  wave: "#4cc2ff",
  playhead: "#f85149",
};

export function WaveformTimeline({ takes }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const peaks = useRef<Map<string, PeakPyramid>>(new Map());
  const [width, setWidth] = useState(800);
  const [pps, setPps] = useState(120); // pixels per second (zoom)
  const [scrollSec, setScrollSec] = useState(0);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [, forceRedraw] = useState(0);

  // Track container width.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Fetch peaks for any sources we don't have yet.
  useEffect(() => {
    let cancelled = false;
    const missing = takes.filter((t) => !peaks.current.has(t.source_id));
    if (missing.length === 0) return;
    Promise.all(
      missing.map((t) =>
        fetchPeaks(t.source_id)
          .then((p) => peaks.current.set(t.source_id, p))
          .catch(() => {}),
      ),
    ).then(() => {
      if (!cancelled) forceRedraw((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [takes]);

  const totalSeconds = takes.reduce(
    (max, t) =>
      Math.max(max, t.timeline_start / t.sample_rate + t.duration_secs),
    0,
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const height = RULER_HEIGHT + TRACK_HEIGHT;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    // Time ruler: a tick every N seconds chosen by zoom.
    const targetPx = 80;
    const rawStep = targetPx / pps;
    const niceSteps = [
      0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
    ];
    const step = niceSteps.find((s) => s >= rawStep) ?? 600;
    ctx.fillStyle = COLORS.ruler;
    ctx.font = "10px system-ui, sans-serif";
    ctx.strokeStyle = COLORS.gridline;
    ctx.lineWidth = 1;
    const firstTick = Math.ceil(scrollSec / step) * step;
    for (let t = firstTick; (t - scrollSec) * pps <= width; t += step) {
      const x = Math.round((t - scrollSec) * pps) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();
      const m = Math.floor(t / 60);
      const s = t % 60;
      const label =
        m > 0
          ? `${m}:${s.toFixed(step < 1 ? 2 : 0).padStart(step < 1 ? 5 : 2, "0")}`
          : `${s.toFixed(step < 1 ? 2 : 0)}s`;
      ctx.fillText(label, x + 3, 14);
    }

    // Clips + waveforms.
    for (const take of takes) {
      const startSec = take.timeline_start / take.sample_rate;
      const x0 = (startSec - scrollSec) * pps;
      const w = take.duration_secs * pps;
      if (x0 + w < 0 || x0 > width) continue; // offscreen

      const top = RULER_HEIGHT + 4;
      const laneH = TRACK_HEIGHT - 8;
      ctx.fillStyle = COLORS.clip;
      ctx.fillRect(x0, top, w, laneH);
      ctx.strokeStyle = COLORS.clipEdge;
      ctx.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.round(w), laneH - 1);

      const pyramid = peaks.current.get(take.source_id);
      if (pyramid) {
        drawWaveform(
          ctx,
          pyramid,
          take,
          x0,
          top,
          w,
          laneH,
          pps,
          scrollSec,
          width,
        );
      }
    }

    // Playhead.
    const px = (playheadSec - scrollSec) * pps;
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
  }, [width, pps, scrollSec, playheadSec, takes]);

  useEffect(() => {
    draw();
  }, [draw]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Zoom around the cursor.
        const rect = canvasRef.current!.getBoundingClientRect();
        const cursorSec = scrollSec + (e.clientX - rect.left) / pps;
        const factor = Math.exp(-e.deltaY * 0.002);
        const newPps = Math.min(MAX_PPS, Math.max(MIN_PPS, pps * factor));
        setScrollSec(Math.max(0, cursorSec - (e.clientX - rect.left) / newPps));
        setPps(newPps);
      } else {
        const delta = (e.deltaX || e.deltaY) / pps;
        setScrollSec((s) =>
          Math.max(
            0,
            Math.min(s + delta, Math.max(0, totalSeconds - width / pps / 2)),
          ),
        );
      }
    },
    [pps, scrollSec, totalSeconds, width],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      setPlayheadSec(Math.max(0, scrollSec + (e.clientX - rect.left) / pps));
    },
    [pps, scrollSec],
  );

  return (
    <div className="waveform">
      <div className="wave-toolbar">
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
        <button
          type="button"
          onClick={() => {
            setScrollSec(0);
            setPlayheadSec(0);
          }}
        >
          ⏮ Start
        </button>
        <span className="wave-info">
          {pps.toFixed(0)} px/s · playhead {playheadSec.toFixed(2)}s
        </span>
      </div>
      <div className="wave-canvas-wrap" ref={wrapRef}>
        {takes.length === 0 ? (
          <p className="wave-empty">Record a take to see its waveform here.</p>
        ) : (
          <canvas
            ref={canvasRef}
            style={{ width: "100%", cursor: "text" }}
            onWheel={onWheel}
            onClick={onClick}
          />
        )}
      </div>
    </div>
  );
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  pyramid: PeakPyramid,
  take: RecordingResult,
  x0: number,
  top: number,
  w: number,
  laneH: number,
  pps: number,
  scrollSec: number,
  viewWidth: number,
) {
  const framesPerPixel = take.sample_rate / pps;
  const level = pickLevel(pyramid, framesPerPixel);
  if (!level) return;
  const ch = level.channels;
  const perChanH = laneH / ch;

  ctx.fillStyle = COLORS.wave;
  const pxStart = Math.max(0, Math.floor(x0));
  const pxEnd = Math.min(viewWidth, Math.ceil(x0 + w));

  for (let px = pxStart; px < pxEnd; px++) {
    // Time at this pixel, relative to clip start.
    const tSec = scrollSec + px / pps;
    const clipFrame =
      (tSec - take.timeline_start / take.sample_rate) * take.sample_rate;
    if (clipFrame < 0 || clipFrame >= take.frames) continue;
    const bucket0 = Math.floor(clipFrame / level.framesPerBucket);
    const bucket1 = Math.max(
      bucket0,
      Math.floor((clipFrame + framesPerPixel) / level.framesPerBucket),
    );

    for (let c = 0; c < ch; c++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let b = bucket0; b <= bucket1 && b < level.numBuckets; b++) {
        lo = Math.min(lo, level.mins[b * ch + c]);
        hi = Math.max(hi, level.maxs[b * ch + c]);
      }
      if (!isFinite(lo)) continue;
      const laneTop = top + c * perChanH;
      const mid = laneTop + perChanH / 2;
      const y1 = mid - hi * (perChanH / 2) * 0.95;
      const y2 = mid - lo * (perChanH / 2) * 0.95;
      ctx.fillRect(px, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
    }
  }
}
