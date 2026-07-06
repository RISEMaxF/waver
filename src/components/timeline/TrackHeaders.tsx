import type { ProjectApi } from "../../audio/useProject";
import type { ProjectView } from "../../audio/project";
import { RULER_HEIGHT, TRACK_HEIGHT } from "./renderer";

interface Props {
  project: ProjectView | null;
  api: ProjectApi;
  armedTrackId: string | null;
  onToggleArm: (id: string) => void;
}

/** Per-track control panel gutter (Audacity/Ableton pattern: the track owns its
 *  controls). Rows align 1:1 with the canvas lanes via a ruler-height spacer + fixed
 *  TRACK_HEIGHT rows. */
export function TrackHeaders({
  project,
  api,
  armedTrackId,
  onToggleArm,
}: Props) {
  const tracks = project?.tracks ?? [];
  const anySolo = tracks.some((t) => t.soloed);
  return (
    <div className="track-headers" aria-label="Track controls">
      <div className="track-headers-spacer" style={{ height: RULER_HEIGHT }} />
      {tracks.map((t) => {
        const dimmed = t.muted || (anySolo && !t.soloed);
        const armed = t.id === armedTrackId;
        return (
          <div
            key={t.id}
            className={`track-head${dimmed ? " dimmed" : ""}${armed ? " armed" : ""}`}
            style={{ height: TRACK_HEIGHT }}
          >
            <div className="track-head-top">
              <span className="track-name" title={t.name}>
                {t.name}
              </span>
              <div className="track-toggles">
                <button
                  type="button"
                  className={`ts-btn arm${armed ? " on" : ""}`}
                  onClick={() => onToggleArm(t.id)}
                  title="Arm for recording"
                  aria-pressed={armed}
                >
                  R
                </button>
                <button
                  type="button"
                  className={`ts-btn mute${t.muted ? " on" : ""}`}
                  onClick={() => api.setTrackMuted(t.id, !t.muted)}
                  title="Mute"
                  aria-pressed={t.muted}
                >
                  M
                </button>
                <button
                  type="button"
                  className={`ts-btn solo${t.soloed ? " on" : ""}`}
                  onClick={() => api.setTrackSoloed(t.id, !t.soloed)}
                  title="Solo"
                  aria-pressed={t.soloed}
                >
                  S
                </button>
              </div>
            </div>
            <div className="track-head-gain">
              <input
                type="range"
                min={-24}
                max={12}
                step={0.5}
                value={t.gain_db}
                onChange={(e) => api.setTrackGain(t.id, Number(e.target.value))}
                aria-label={`${t.name} gain`}
                title={`${t.gain_db.toFixed(1)} dB`}
              />
              <span className="track-gain-val">{t.gain_db.toFixed(0)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
