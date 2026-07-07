import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ProjectApi } from "../../audio/useProject";
import type { ProjectView } from "../../audio/project";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconMute,
  IconRecord,
  IconSolo,
} from "../icons";
import {
  COLLAPSED_H,
  TRACK_HEIGHT,
  TRACK_COLORS,
  trackColor,
} from "./renderer";

interface Props {
  project: ProjectView | null;
  api: ProjectApi;
  armedTrackId: string | null;
  onToggleArm: (id: string) => void;
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
}

/** Per-track control panel gutter (Audacity/Ableton pattern: the track owns its
 *  controls). Rows align 1:1 with the canvas lanes (variable heights for collapse). */
export function TrackHeaders({
  project,
  api,
  armedTrackId,
  onToggleArm,
  collapsed,
  onToggleCollapse,
}: Props) {
  const tracks = project?.tracks ?? [];
  const anySolo = tracks.some((t) => t.soloed);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerFor) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node))
        setPickerFor(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerFor]);

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
      {tracks.map((t, i) => {
        const dimmed = t.muted || (anySolo && !t.soloed);
        const armed = t.id === armedTrackId;
        const isCollapsed = collapsed.has(t.id);
        return (
          <div
            key={t.id}
            className={`track-head${dimmed ? " dimmed" : ""}${armed ? " armed" : ""}${isCollapsed ? " collapsed" : ""}`}
            style={{
              height: isCollapsed ? COLLAPSED_H : TRACK_HEIGHT,
              ["--track-color" as string]: t.color ?? trackColor(i),
            }}
          >
            <div
              className="track-color-wrap"
              ref={pickerFor === t.id ? pickerRef : null}
            >
              <button
                type="button"
                className="track-color-strip"
                title="Track color"
                aria-label={`${t.name} color`}
                onClick={() => setPickerFor((c) => (c === t.id ? null : t.id))}
              />
              {pickerFor === t.id && (
                <div
                  className="color-popover"
                  role="dialog"
                  aria-label="Track color"
                >
                  {TRACK_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="color-swatch"
                      style={{ background: c }}
                      title={c}
                      onClick={() => {
                        api.setTrackColor(t.id, c);
                        setPickerFor(null);
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className="color-swatch auto"
                    title="Auto color"
                    onClick={() => {
                      api.setTrackColor(t.id, null);
                      setPickerFor(null);
                    }}
                  >
                    Auto
                  </button>
                </div>
              )}
            </div>
            <div className="track-head-main">
              <div className="track-head-top">
                <button
                  type="button"
                  className="track-collapse"
                  onClick={() => onToggleCollapse(t.id)}
                  title={isCollapsed ? "Expand track" : "Collapse track"}
                  aria-label={isCollapsed ? "Expand track" : "Collapse track"}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? (
                    <IconChevronRight size={14} />
                  ) : (
                    <IconChevronDown size={14} />
                  )}
                </button>
                <TrackName
                  name={t.name}
                  onRename={(n) => api.setTrackName(t.id, n)}
                />
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
                  title={armed ? "Armed for recording" : "Arm for recording"}
                  aria-label="Arm for recording"
                  aria-pressed={armed}
                >
                  <IconRecord size={13} />
                </button>
                <button
                  type="button"
                  className={`ts-btn mute${t.muted ? " on" : ""}`}
                  onClick={() => api.setTrackMuted(t.id, !t.muted)}
                  title="Mute"
                  aria-label="Mute"
                  aria-pressed={t.muted}
                >
                  <IconMute size={15} />
                </button>
                <button
                  type="button"
                  className={`ts-btn solo${t.soloed ? " on" : ""}`}
                  onClick={() => api.setTrackSoloed(t.id, !t.soloed)}
                  title="Solo"
                  aria-label="Solo"
                  aria-pressed={t.soloed}
                >
                  <IconSolo size={15} />
                </button>
              </div>
              {!isCollapsed && (
                <>
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
                  <div className="track-meta" title={trackDetail(t, project)}>
                    {trackDetail(t, project)}
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Track name: double-click to edit inline, commit on blur / Enter (F8). */
function TrackName({
  name,
  onRename,
}: {
  name: string;
  onRename: (n: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (editing) {
    return (
      <input
        className="track-name-input"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = draft.trim();
          if (v && v !== name) onRename(v);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span
      className="track-name"
      title={`${name} — double-click to rename`}
      onDoubleClick={() => {
        setDraft(name);
        setEditing(true);
      }}
    >
      {name}
    </span>
  );
}

function oneCh(c: number): string {
  return c === 1 ? "Mono" : c === 2 ? "Stereo" : `${c}ch`;
}

/** Track detail line: channel format · sample rate · clip count, from the track's
 *  clips' sources (F10). */
function trackDetail(
  t: ProjectView["tracks"][number],
  project: ProjectView | null,
): string {
  const projRate = `${((project?.sample_rate ?? 48000) / 1000).toFixed(1)} kHz`;
  const n = t.clips.length;
  if (n === 0) return `Empty · ${projRate}`;
  const sources = project?.sources ?? [];
  const used = t.clips
    .map((c) => sources.find((s) => s.id === c.source_id))
    .filter((s): s is ProjectView["sources"][number] => !!s);
  const plural = n === 1 ? "" : "s";
  if (used.length === 0) return `${n} clip${plural}`;
  const chans = new Set(used.map((s) => s.channels));
  const rates = new Set(used.map((s) => s.sample_rate));
  const ch = chans.size > 1 ? "Mixed" : oneCh([...chans][0]);
  const rate =
    rates.size > 1 ? "mixed rate" : `${([...rates][0] / 1000).toFixed(1)} kHz`;
  return `${ch} · ${rate} · ${n} clip${plural}`;
}
