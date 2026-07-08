import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { importToPoolDialog } from "../audio/files";
import { playbackStatus, previewSource, stopPlayback } from "../audio/project";
import type { ProjectView, SourceView } from "../audio/project";
import {
  IconChevronLeft,
  IconChevronRight,
  IconImport,
  IconPlay,
  IconPlus,
  IconStop,
} from "./icons";

const basename = (p: string) =>
  (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");

/** Media pool / scratchpad: imported sources you can audition (play/stop, Finder-style)
 *  and drag onto tracks. A source can be dropped many times (a reusable clip bin). */
export function MediaPool({
  project,
  outputId,
  onChanged,
  onNotice,
  onError,
  onPlace,
}: {
  project: ProjectView | null;
  outputId: string | null;
  onChanged: () => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onPlace: (sourceId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Resizable drawer width (drag the right edge), persisted per user.
  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem("waver-pool-w"));
    return w >= 160 && w <= 420 ? w : 200;
  });
  const resize = useRef<{ x: number; w: number } | null>(null);
  // Global "Reset layout" (dispatched from the timeline's menus).
  useEffect(() => {
    const onReset = () => {
      setWidth(200);
      localStorage.removeItem("waver-pool-w");
      setCollapsed(false);
    };
    window.addEventListener("waver:reset-layout", onReset);
    return () => window.removeEventListener("waver:reset-layout", onReset);
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resize.current) return;
      const w = Math.min(
        420,
        Math.max(160, resize.current.w + (e.clientX - resize.current.x)),
      );
      setWidth(w);
    };
    const onUp = () => {
      if (!resize.current) return;
      resize.current = null;
      setWidth((w) => {
        localStorage.setItem("waver-pool-w", String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const sources = project?.sources ?? [];

  // Auto-reset the play button when a preview finishes on its own.
  useEffect(() => {
    if (!previewId) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const st = await playbackStatus();
        if (alive && !st.playing) setPreviewId(null);
      } catch {
        /* ignore */
      }
    }, 300);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [previewId]);

  const togglePreview = async (id: string) => {
    if (previewId === id) {
      stopPlayback().catch(() => {});
      setPreviewId(null);
      return;
    }
    if (!outputId) {
      onNotice("Select an output device to preview.");
      return;
    }
    try {
      await previewSource(outputId, id);
      setPreviewId(id);
    } catch (e) {
      onError(`Preview failed: ${e}`);
    }
  };

  // Files dropped from the OS arrive as bytes (no path - Tauri interception is
  // off for internal DnD), so stream them to the import_dropped command.
  const AUDIO_RE = /\.(wav|flac|mp3|ogg|aac|m4a|aiff?|opus)$/i;
  const [dragOver, setDragOver] = useState(false);
  const importDropped = async (files: FileList) => {
    const audio = [...files].filter((f) => AUDIO_RE.test(f.name));
    if (!audio.length) {
      onNotice("Drop audio files (wav, flac, mp3, ogg, aiff, opus).");
      return;
    }
    setBusy(true);
    try {
      for (const f of audio) {
        const bytes = await f.arrayBuffer();
        await invoke("import_dropped", bytes, {
          headers: { "x-filename": encodeURIComponent(f.name) },
        });
      }
      onChanged();
    } catch (e) {
      onError(`Import failed - ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async () => {
    setBusy(true);
    try {
      const n = await importToPoolDialog();
      if (n > 0) onChanged();
    } catch (e) {
      onError(`Import failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  if (collapsed) {
    return (
      <div className="media-pool collapsed">
        <button
          type="button"
          className="pool-toggle"
          onClick={() => setCollapsed(false)}
          title="Show media pool"
          aria-label="Show media pool"
        >
          <IconChevronRight />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`media-pool${dragOver ? " drop-target" : ""}`}
      aria-label="Media pool"
      style={{ width }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) importDropped(e.dataTransfer.files);
      }}
    >
      <div
        className="panel-resize pool-resize"
        role="separator"
        aria-label="Resize media pool"
        title="Drag to resize - double-click to reset"
        onDoubleClick={() => {
          setWidth(200);
          localStorage.removeItem("waver-pool-w");
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          resize.current = { x: e.clientX, w: width };
        }}
      />
      <div className="pool-header">
        <span className="pool-title">Media</span>
        <div className="pool-actions">
          <button
            type="button"
            className="tbtn sm"
            disabled={busy}
            onClick={addFiles}
            title="Import files into the pool"
          >
            <IconPlus />
            <span>Add</span>
          </button>
          <button
            type="button"
            className="pool-toggle"
            onClick={() => setCollapsed(true)}
            title="Hide media pool"
            aria-label="Hide media pool"
          >
            <IconChevronLeft />
          </button>
        </div>
      </div>
      <div className="pool-list">
        {sources.length === 0 ? (
          <p className="pool-empty">
            Add audio files here (or drop them from Finder), then drag them onto
            a track. Recordings and imports show up too.
          </p>
        ) : (
          sources.map((s) => (
            <PoolItem
              key={s.id}
              source={s}
              playing={previewId === s.id}
              onToggle={() => togglePreview(s.id)}
              onPlace={() => onPlace(s.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PoolItem({
  source,
  playing,
  onToggle,
  onPlace,
}: {
  source: SourceView;
  playing: boolean;
  onToggle: () => void;
  onPlace: () => void;
}) {
  const dur = source.frames / Math.max(1, source.sample_rate);
  const ch =
    source.channels === 1
      ? "Mono"
      : source.channels === 2
        ? "Stereo"
        : `${source.channels}ch`;
  return (
    <div
      className={`pool-item${playing ? " playing" : ""}`}
      draggable
      tabIndex={0}
      role="listitem"
      aria-label={`${basename(source.path)}, ${dur.toFixed(1)} seconds, ${ch}. Press Enter to place at the playhead.`}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onPlace();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-waver-source", source.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`${source.path}\nDrag onto a track, or place at the playhead`}
    >
      <button
        type="button"
        className="pool-play"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        title={playing ? "Stop preview" : "Preview"}
        aria-label={playing ? "Stop preview" : "Preview"}
      >
        {playing ? <IconStop size={13} /> : <IconPlay size={13} />}
      </button>
      <div className="pool-item-info">
        <span className="pool-item-name">{basename(source.path)}</span>
        <span className="pool-item-meta">
          {dur.toFixed(1)}s · {ch}
        </span>
      </div>
      <button
        type="button"
        className="pool-place"
        onClick={(e) => {
          e.stopPropagation();
          onPlace();
        }}
        title="Place at playhead (Enter)"
        aria-label="Place at playhead"
      >
        <IconImport size={13} />
      </button>
    </div>
  );
}
