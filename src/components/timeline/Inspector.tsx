import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipView, FadeCurve, ProjectView } from "../../audio/project";
import type { ProjectApi } from "../../audio/useProject";
import { fetchPeaks, type PeakPyramid } from "../../audio/peaks";
import {
  CURVE_NAMES,
  drawClipWave,
  drawFade,
  fmtGainDb,
  fmtTimecode,
  parseTimecode,
  readCanvasTheme,
  trackColor,
} from "./renderer";

// Small per-source pyramid cache so the preview doesn't refetch on every render.
const previewPeaks = new Map<string, PeakPyramid>();

/** The selected clip's waveform with its fades drawn over it - fills the
 *  inspector's spare width (Ableton's clip view shows the sample; so do we). */
function WavePreview({
  clip,
  sr,
  color,
}: {
  clip: ClipView;
  sr: number;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (previewPeaks.has(clip.source_id)) return;
    let alive = true;
    fetchPeaks(clip.source_id)
      .then((p) => {
        if (!alive) return;
        previewPeaks.set(clip.source_id, p);
        bump((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [clip.source_id]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const draw = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w < 10 || h < 10) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const th = readCanvasTheme();
      ctx.fillStyle = th.laneAlt;
      ctx.fillRect(0, 0, w, h);
      // center line
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(h / 2) + 0.5);
      ctx.lineTo(w, Math.round(h / 2) + 0.5);
      ctx.stroke();
      const pyr = previewPeaks.get(clip.source_id);
      const lenSec = (clip.source_out - clip.source_in) / sr;
      if (pyr && lenSec > 0) {
        const pps = w / lenSec;
        drawClipWave(ctx, pyr, clip, 0, 0, w, h, pps, sr, false, w, th, color);
        drawFade(
          ctx,
          "in",
          clip.fade_in_curve,
          clip.fade_in_len,
          sr,
          pps,
          0,
          0,
          w,
          h,
          th,
        );
        drawFade(
          ctx,
          "out",
          clip.fade_out_curve,
          clip.fade_out_len,
          sr,
          pps,
          0,
          0,
          w,
          h,
          th,
        );
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return (
    <div className="insp-wave-wrap" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

/** Editable clip start time (h:mm:ss.mmm or plain seconds), committing on blur/Enter
 *  via the same move op as dragging (W-27). */
function StartField({
  seconds,
  onCommit,
}: {
  seconds: number;
  onCommit: (sec: number) => void;
}) {
  const [draft, setDraft] = useState(fmtTimecode(seconds));
  const commit = () => {
    const sec = parseTimecode(draft);
    if (sec !== null && Math.abs(sec - seconds) > 1e-6) onCommit(sec);
    else setDraft(fmtTimecode(seconds));
  };
  return (
    <input
      className="insp-time"
      value={draft}
      aria-label="Clip start time"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(fmtTimecode(seconds));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const CURVES: FadeCurve[] = ["linear", "equal_power", "log", "s_curve"];

/** Clip name field: edits locally, commits on blur / Enter (avoids an IPC per keystroke). */
function NameField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
    else setDraft(value);
  };
  return (
    <input
      className="insp-name"
      value={draft}
      aria-label="Clip name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

interface Props {
  project: ProjectView | null;
  selected: string | null;
  api: ProjectApi;
  sr: number;
}

/** Persistent, selection-driven inspector (Ableton pattern): always present, shows
 *  the selected clip's gain + fades and its track gain, or a hint when nothing is
 *  selected. */
export function Inspector({ project, selected, api, sr }: Props) {
  const found = selected ? findClipAndTrack(project, selected) : null;
  if (!found) {
    return (
      <div className="inspector empty">
        Select a clip to edit its gain and fades.
      </div>
    );
  }
  const { clip, track } = found;
  const msFrom = (frames: number) => Math.round((frames / sr) * 1000);
  const framesFrom = (ms: number) => Math.round((ms / 1000) * sr);
  const src = project?.sources.find((s) => s.id === clip.source_id);
  const chLabel = src
    ? src.channels === 1
      ? "Mono"
      : src.channels === 2
        ? "Stereo"
        : `${src.channels}ch`
    : "";
  const lenSec = (clip.source_out - clip.source_in) / sr;

  return (
    <div className="inspector">
      <section className="insp-panel insp-panel-clip">
        <h4 className="insp-title">Clip</h4>
        <NameField
          key={clip.id}
          value={clip.name}
          onCommit={(n) => api.setClipName(clip.id, n)}
        />
        {src && (
          <span className="insp-meta">
            {chLabel} · {(src.sample_rate / 1000).toFixed(1)} kHz
          </span>
        )}
        <div className="insp-row">
          <label className="insp-label">Start</label>
          <StartField
            key={`${clip.id}:${clip.timeline_start}`}
            seconds={clip.timeline_start / sr}
            onCommit={(sec) =>
              api.move(clip.id, track.id, Math.round(sec * sr))
            }
          />
          <span className="insp-meta">Len {fmtTimecode(lenSec)}</span>
        </div>
        <GainRow
          value={clip.gain_db}
          onChange={(v) => api.setClipGain(clip.id, v)}
        />
      </section>

      <section className="insp-panel">
        <h4 className="insp-title">Fades</h4>
        <FadeControls
          label="In"
          idBase="fade-in"
          lenMs={msFrom(clip.fade_in_len)}
          curve={clip.fade_in_curve as FadeCurve}
          onLen={(ms) =>
            api.setFadeIn(
              clip.id,
              framesFrom(ms),
              clip.fade_in_curve as FadeCurve,
            )
          }
          onCurve={(cv) => api.setFadeIn(clip.id, clip.fade_in_len, cv)}
        />
        <FadeControls
          label="Out"
          idBase="fade-out"
          lenMs={msFrom(clip.fade_out_len)}
          curve={clip.fade_out_curve as FadeCurve}
          onLen={(ms) =>
            api.setFadeOut(
              clip.id,
              framesFrom(ms),
              clip.fade_out_curve as FadeCurve,
            )
          }
          onCurve={(cv) => api.setFadeOut(clip.id, clip.fade_out_len, cv)}
        />
      </section>

      <section className="insp-panel">
        <h4 className="insp-title">Track</h4>
        <span className="insp-meta insp-trackname">{track.name}</span>
        <GainRow
          value={track.gain_db}
          onChange={(v) => api.setTrackGain(track.id, v)}
        />
      </section>

      <section className="insp-panel insp-panel-wave">
        <h4 className="insp-title">Wave</h4>
        <WavePreview
          clip={clip}
          sr={sr}
          color={
            track.color ??
            trackColor(
              Math.max(
                0,
                project?.tracks.findIndex((t) => t.id === track.id) ?? 0,
              ),
            )
          }
        />
      </section>
    </div>
  );
}

/** A compact "Gain [====] [+0.0] dB" row; double-click the slider to reset (F37). */
function GainRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="insp-row">
      <label
        className="insp-label"
        title="Double-click the slider to reset to 0 dB"
      >
        Gain
      </label>
      <input
        type="range"
        min={-24}
        max={12}
        step={0.5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        aria-label="Gain"
        aria-valuetext={fmtGainDb(value)}
      />
      <input
        type="number"
        className="insp-gain-num"
        min={-24}
        max={12}
        step={0.5}
        value={value}
        onChange={(e) =>
          onChange(Math.max(-24, Math.min(12, Number(e.target.value) || 0)))
        }
        aria-label="Gain in dB"
      />
      <span className="insp-unit">dB</span>
    </div>
  );
}

function FadeControls({
  label,
  idBase,
  lenMs,
  curve,
  onLen,
  onCurve,
}: {
  label: string;
  idBase: string;
  lenMs: number;
  curve: FadeCurve;
  onLen: (ms: number) => void;
  onCurve: (c: FadeCurve) => void;
}) {
  return (
    <div className="insp-row">
      <label className="insp-label" htmlFor={`insp-${idBase}-len`}>
        {label}
      </label>
      <input
        id={`insp-${idBase}-len`}
        type="number"
        min={0}
        value={lenMs}
        onChange={(e) => onLen(Number(e.target.value))}
      />
      <span className="insp-unit">ms</span>
      <select
        aria-label={`${label} curve`}
        value={curve}
        onChange={(e) => onCurve(e.target.value as FadeCurve)}
      >
        {CURVES.map((cv) => (
          <option key={cv} value={cv}>
            {CURVE_NAMES[cv] ?? cv}
          </option>
        ))}
      </select>
    </div>
  );
}

function findClipAndTrack(
  project: ProjectView | null,
  clipId: string,
): { clip: ClipView; track: ProjectView["tracks"][number] } | null {
  if (!project) return null;
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}
