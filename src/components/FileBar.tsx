import { useState } from "react";
import {
  exportProjectDialog,
  importAudioDialog,
  loadProjectDialog,
  saveProjectDialog,
  type ExportBitDepth,
  type ExportFormat,
} from "../audio/files";
import type { ProjectView } from "../audio/project";

interface Props {
  project: ProjectView | null;
  onChanged: () => void; // refresh the project view
}

export function FileBar({ project, onChanged }: Props) {
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>("int24");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const sampleRate = project?.sample_rate ?? 48000;
  const hasContent =
    !!project && project.tracks.some((t) => t.clips.length > 0);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(`${label} failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="filebar">
      <div className="filebar-group">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run("Import", async () => {
              const r = await importAudioDialog();
              if (r) {
                setMsg(`Imported ${r.name} (${r.duration_secs.toFixed(1)}s)`);
                onChanged();
              }
            })
          }
        >
          ⤵ Import audio
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run("Open", async () => {
              const r = await loadProjectDialog();
              if (r) {
                onChanged();
                setMsg(
                  r.missing_sources.length
                    ? `Opened project — ${r.missing_sources.length} source file(s) missing`
                    : "Project opened",
                );
              }
            })
          }
        >
          📂 Open project
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run("Save", async () => {
              const p = await saveProjectDialog();
              if (p) setMsg("Project saved");
            })
          }
        >
          💾 Save project
        </button>
      </div>

      <div className="filebar-group export">
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
          title="Export format"
        >
          <option value="wav">WAV</option>
          <option value="flac">FLAC</option>
          <option value="ogg">OGG</option>
        </select>
        <select
          value={bitDepth}
          onChange={(e) => setBitDepth(e.target.value as ExportBitDepth)}
          disabled={format === "ogg"}
          title="Bit depth"
        >
          <option value="int16">16-bit</option>
          <option value="int24">24-bit</option>
          <option value="float32">32-bit float</option>
        </select>
        <button
          type="button"
          disabled={busy || !hasContent}
          onClick={() =>
            run("Export", async () => {
              const p = await exportProjectDialog(
                format,
                bitDepth,
                sampleRate,
                2,
              );
              if (p) setMsg(`Exported ${format.toUpperCase()}`);
            })
          }
          title={
            hasContent ? "Export mixdown" : "Record or import something first"
          }
        >
          ⤴ Export
        </button>
      </div>

      {msg && <span className="filebar-msg">{msg}</span>}
    </div>
  );
}
