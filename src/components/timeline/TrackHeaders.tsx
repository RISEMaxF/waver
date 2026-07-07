import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ProjectApi } from "../../audio/useProject";
import type { ProjectView } from "../../audio/project";
import type { ChannelLevel } from "../../audio/types";
import { ContextMenu, type MenuState } from "./ContextMenu";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconRecord,
} from "../icons";
import {
  COLLAPSED_H,
  TRACK_HEIGHT,
  TRACK_COLOR_NAMES,
  fmtGainDb,
  trackColor,
  trackPalette,
} from "./renderer";

interface Props {
  project: ProjectView | null;
  api: ProjectApi;
  armedTrackId: string | null;
  onToggleArm: (id: string) => void;
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  /** Live input levels — drawn as a mini meter on the armed track (W-12). */
  inputLevels: ChannelLevel[];
}

/** Tiny horizontal level bar in the armed track's header: signal + clip feedback in
 *  the user's line of sight during capture (W-12 / FR-2.3). */
function MiniMeter({ levels }: { levels: ChannelLevel[] }) {
  const peak = levels.reduce((m, l) => Math.max(m, l.peak_dbfs), -60);
  const pct = ((Math.max(-60, Math.min(0, peak)) + 60) / 60) * 100;
  return (
    <div
      className="track-mini-meter"
      role="img"
      aria-label={`Input level ${peak <= -60 ? "silent" : `${Math.round(peak)} dB`}`}
    >
      <div
        className={`track-mini-fill${peak >= -0.1 ? " clip" : ""}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
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
  inputLevels,
}: Props) {
  const tracks = project?.tracks ?? [];
  const anySolo = tracks.some((t) => t.soloed);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<MenuState | null>(null);
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
      {ctxMenu && (
        <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      )}
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
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: "Rename…", onClick: () => setEditingId(t.id) },
                  { label: "Color…", onClick: () => setPickerFor(t.id) },
                  {
                    label: isCollapsed ? "Expand" : "Collapse",
                    onClick: () => onToggleCollapse(t.id),
                  },
                  "sep",
                  {
                    label: armed ? "Disarm" : "Arm for recording",
                    onClick: () => onToggleArm(t.id),
                  },
                  {
                    label: t.muted ? "Unmute" : "Mute",
                    onClick: () => api.setTrackMuted(t.id, !t.muted),
                  },
                  {
                    label: t.soloed ? "Unsolo" : "Solo",
                    onClick: () => api.setTrackSoloed(t.id, !t.soloed),
                  },
                  "sep",
                  {
                    label: "Delete track…",
                    danger: true,
                    onClick: () => removeTrack(t.id, t.name, t.clips.length),
                  },
                ],
              });
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
                aria-haspopup="dialog"
                aria-expanded={pickerFor === t.id}
                onClick={() => setPickerFor((c) => (c === t.id ? null : t.id))}
              />
              {pickerFor === t.id && (
                <div
                  className="color-popover"
                  role="dialog"
                  aria-label="Track color"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setPickerFor(null);
                      (
                        e.currentTarget.parentElement?.querySelector(
                          ".track-color-strip",
                        ) as HTMLElement | null
                      )?.focus();
                    }
                  }}
                >
                  {trackPalette().map((c, ci) => (
                    <button
                      key={c}
                      type="button"
                      className={`color-swatch${t.color === c ? " selected" : ""}`}
                      style={{ background: c }}
                      title={TRACK_COLOR_NAMES[ci]}
                      aria-label={TRACK_COLOR_NAMES[ci]}
                      aria-pressed={t.color === c}
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
                  editing={editingId === t.id}
                  onEditingChange={(on) => setEditingId(on ? t.id : null)}
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
                  <span className="ts-letter" aria-hidden="true">
                    M
                  </span>
                </button>
                <button
                  type="button"
                  className={`ts-btn solo${t.soloed ? " on" : ""}`}
                  onClick={() => api.setTrackSoloed(t.id, !t.soloed)}
                  title="Solo"
                  aria-label="Solo"
                  aria-pressed={t.soloed}
                >
                  <span className="ts-letter" aria-hidden="true">
                    S
                  </span>
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
                      aria-valuetext={fmtGainDb(t.gain_db)}
                    />
                    <span className="track-gain-val">
                      {fmtGainDb(t.gain_db)}
                    </span>
                  </div>
                  {armed && inputLevels.length > 0 && (
                    <MiniMeter levels={inputLevels} />
                  )}
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

/** Track name: double-click / Enter / context-menu Rename edits inline, commit on
 *  blur / Enter (F8). Editing state lives in TrackHeaders so the menu can start it. */
function TrackName({
  name,
  editing,
  onEditingChange,
  onRename,
}: {
  name: string;
  editing: boolean;
  onEditingChange: (on: boolean) => void;
  onRename: (n: string) => void;
}) {
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
          onEditingChange(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(name);
            onEditingChange(false);
          }
        }}
      />
    );
  }
  const startEdit = () => {
    setDraft(name);
    onEditingChange(true);
  };
  return (
    <span
      className="track-name"
      role="button"
      tabIndex={0}
      title={`${name} — double-click or press Enter to rename`}
      aria-label={`${name} — press Enter to rename`}
      onDoubleClick={startEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          startEdit();
        }
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
