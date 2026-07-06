import { useEffect, useState } from "react";
import {
  exportProjectDialog,
  importAudioDialog,
  loadProjectDialog,
  newProject,
  saveProjectDialog,
  saveProjectToPath,
  type ExportBitDepth,
  type ExportFormat,
} from "../audio/files";
import type { ProjectView } from "../audio/project";

interface Props {
  project: ProjectView | null;
  onChanged: () => void; // refresh the project view
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function FileBar({ project, onChanged }: Props) {
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>("int24");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dark, setDark] = useState(true);
  const [projectPath, setProjectPath] = useState<string | null>(null);

  // Theme toggle: set data-theme on <html>; the tokens + canvas follow it.
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

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
          title="Start a new empty project"
          onClick={() =>
            run("New", async () => {
              await newProject();
              setProjectPath(null);
              onChanged();
              setMsg("New project");
            })
          }
        >
          🆕 New
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run("Open", async () => {
              const r = await loadProjectDialog();
              if (r) {
                setProjectPath(r.path);
                onChanged();
                setMsg(
                  r.missing_sources.length
                    ? `Opened ${basename(r.path)} — ${r.missing_sources.length} source file(s) missing`
                    : `Opened ${basename(r.path)}`,
                );
              }
            })
          }
        >
          📂 Open
        </button>
        <button
          type="button"
          disabled={busy}
          title={
            projectPath ? `Save to ${basename(projectPath)}` : "Save project"
          }
          onClick={() =>
            run("Save", async () => {
              if (projectPath) {
                await saveProjectToPath(projectPath);
                setMsg(`Saved ${basename(projectPath)}`);
              } else {
                const p = await saveProjectDialog();
                if (p) {
                  setProjectPath(p);
                  setMsg(`Saved ${basename(p)}`);
                }
              }
            })
          }
        >
          💾 Save
        </button>
        <button
          type="button"
          disabled={busy}
          title="Save to a new file"
          onClick={() =>
            run("Save As", async () => {
              const p = await saveProjectDialog();
              if (p) {
                setProjectPath(p);
                setMsg(`Saved ${basename(p)}`);
              }
            })
          }
        >
          Save As…
        </button>
        {projectPath && (
          <span className="filebar-project" title={projectPath}>
            {basename(projectPath)}
          </span>
        )}
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

      <button
        type="button"
        className="theme-toggle"
        onClick={() => setDark((d) => !d)}
        title="Toggle light / dark theme"
        aria-label="Toggle theme"
      >
        {dark ? "☀" : "🌙"}
      </button>

      {msg && <span className="filebar-msg">{msg}</span>}
    </div>
  );
}
