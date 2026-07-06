import { ask } from "@tauri-apps/plugin-dialog";
import type { ProjectApi } from "../../audio/useProject";
import type { ProjectView } from "../../audio/project";
import { IconClose } from "../icons";
import { RULER_HEIGHT, TRACK_HEIGHT, trackColor } from "./renderer";

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

  const removeTrack = async (id: string, name: string, clipCount: number) => {
    const warn =
      clipCount > 0
        ? `Delete “${name}” and its ${clipCount} clip${clipCount === 1 ? "" : "s"}? This can be undone.`
        : `Delete “${name}”?`;
    const ok = await ask(warn, { title: "Delete track", kind: "warning" });
    if (ok) api.removeTrack(id);
  };

  return (
    <div className="track-headers" aria-label="Track controls">
      <div className="track-headers-spacer" style={{ height: RULER_HEIGHT }} />
      {tracks.map((t, i) => {
        const dimmed = t.muted || (anySolo && !t.soloed);
        const armed = t.id === armedTrackId;
        return (
          <div
            key={t.id}
            className={`track-head${dimmed ? " dimmed" : ""}${armed ? " armed" : ""}`}
            style={{
              height: TRACK_HEIGHT,
              ["--track-color" as string]: trackColor(i),
            }}
          >
            <span className="track-color-strip" />
            <div className="track-head-main">
              <div className="track-head-top">
                <span className="track-name" title={t.name}>
                  {t.name}
                </span>
                <button
                  type="button"
                  className="track-remove"
                  onClick={() => removeTrack(t.id, t.name, t.clips.length)}
                  title="Delete track"
                  aria-label={`Delete ${t.name}`}
                >
                  <IconClose size={13} />
                </button>
              </div>
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
              <div className="track-head-gain">
                <input
                  type="range"
                  min={-24}
                  max={12}
                  step={0.5}
                  value={t.gain_db}
                  onChange={(e) =>
                    api.setTrackGain(t.id, Number(e.target.value))
                  }
                  aria-label={`${t.name} gain`}
                  title={`${t.gain_db.toFixed(1)} dB`}
                />
                <span className="track-gain-val">
                  {t.gain_db.toFixed(0)} dB
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
