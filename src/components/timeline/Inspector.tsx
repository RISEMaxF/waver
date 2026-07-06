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
      <div className="insp-group">
        <NameField
          key={clip.id}
          value={clip.name}
          onCommit={(n) => api.setClipName(clip.id, n)}
        />
      </div>
      {src && (
        <span className="insp-meta">
          {chLabel} · {(src.sample_rate / 1000).toFixed(1)} kHz ·{" "}
          {lenSec.toFixed(2)}s
        </span>
      )}
      <div className="insp-group">
        <label className="insp-label" htmlFor="insp-clip-gain">
          Clip gain
        </label>
        <input
          id="insp-clip-gain"
          type="range"
          min={-24}
          max={12}
          step={0.5}
          value={clip.gain_db}
          onChange={(e) => api.setClipGain(clip.id, Number(e.target.value))}
        />
        <span className="insp-val">{clip.gain_db.toFixed(1)} dB</span>
      </div>

      <FadeControls
        label="Fade in"
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
        label="Fade out"
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

      <div className="insp-group">
        <label className="insp-label" htmlFor="insp-track-gain">
          Track “{track.name}” gain
        </label>
        <input
          id="insp-track-gain"
          type="range"
          min={-24}
          max={12}
          step={0.5}
          value={track.gain_db}
          onChange={(e) => api.setTrackGain(track.id, Number(e.target.value))}
        />
        <span className="insp-val">{track.gain_db.toFixed(1)} dB</span>
      </div>
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
    <div className="insp-group">
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
