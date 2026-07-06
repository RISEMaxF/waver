import { useState } from "react";
import type { ClipView, FadeCurve, ProjectView } from "../../audio/project";
import type { ProjectApi } from "../../audio/useProject";

const CURVES: FadeCurve[] = ["linear", "equal_power", "log"];

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
            {chLabel} · {(src.sample_rate / 1000).toFixed(1)} kHz ·{" "}
            {lenSec.toFixed(2)}s
          </span>
        )}
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
    </div>
  );
}

/** A compact "Gain [====] 0.0 dB" row; double-click the slider to reset to 0 dB (F37). */
function GainRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="insp-row">
      <label className="insp-label">Gain</label>
      <input
        type="range"
        min={-24}
        max={12}
        step={0.5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        title="Double-click to reset to 0 dB"
      />
      <span className="insp-val">{value.toFixed(1)} dB</span>
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
            {cv}
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
