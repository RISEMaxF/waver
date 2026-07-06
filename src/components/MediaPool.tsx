import { useState } from "react";
import { importToPoolDialog } from "../audio/files";
import type { ProjectView, SourceView } from "../audio/project";
import { IconChevronLeft, IconChevronRight, IconPlus } from "./icons";

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Media pool / scratchpad: imported sources you can drag onto tracks. A source can be
 *  dropped many times (each drop is a new clip), so it works as a reusable clip bin. */
export function MediaPool({
  project,
  onChanged,
  onError,
}: {
  project: ProjectView | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const sources = project?.sources ?? [];

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
    <div className="media-pool" aria-label="Media pool">
      <div className="pool-header">
        <span className="pool-title">Media</span>
        <div className="pool-actions">
          <button
            type="button"
            className="tbtn"
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
            Add audio files here, then drag them onto a track. Recordings and
            imports show up too.
          </p>
        ) : (
          sources.map((s) => <PoolItem key={s.id} source={s} />)
        )}
      </div>
    </div>
  );
}

function PoolItem({ source }: { source: SourceView }) {
  const dur = source.frames / Math.max(1, source.sample_rate);
  return (
    <div
      className="pool-item"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-waver-source", source.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`${source.path}\nDrag onto a track to place`}
    >
      <span className="pool-item-name">{basename(source.path)}</span>
      <span className="pool-item-meta">
        {dur.toFixed(1)}s · {source.channels}ch
      </span>
    </div>
  );
}
