import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
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
import {
  IconExport,
  IconImport,
  IconMoon,
  IconNew,
  IconOpen,
  IconSave,
  IconSaveAs,
  IconSun,
} from "./icons";

interface Props {
  project: ProjectView | null;
  onChanged: () => void; // refresh the project view
  dirty: boolean;
  markDirty: () => void;
  markClean: () => void;
}

/** Confirm discarding unsaved changes before a destructive project switch (F1). */
async function okToDiscard(dirty: boolean, action: string): Promise<boolean> {
  if (!dirty) return true;
  return ask(`You have unsaved changes. Discard them and ${action}?`, {
    title: "Unsaved changes",
    kind: "warning",
  });
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function FileBar({
  project,
  onChanged,
  dirty,
  markDirty,
  markClean,
}: Props) {
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
          className="tbtn"
          disabled={busy}
          title="Start a new empty project"
          onClick={() =>
            run("New", async () => {
              if (!(await okToDiscard(dirty, "start a new project"))) return;
              await newProject();
              setProjectPath(null);
              markClean();
              onChanged();
              setMsg("New project");
            })
          }
        >
          <IconNew />
          <span>New</span>
        </button>
        <button
          type="button"
          className="tbtn"
          disabled={busy}
          onClick={() =>
            run("Open", async () => {
              if (!(await okToDiscard(dirty, "open another project"))) return;
              const r = await loadProjectDialog();
              if (r) {
                setProjectPath(r.path);
                markClean();
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
          <IconOpen />
          <span>Open</span>
        </button>
        <button
          type="button"
          className="tbtn"
          disabled={busy}
          title={
            projectPath ? `Save to ${basename(projectPath)}` : "Save project"
          }
          onClick={() =>
            run("Save", async () => {
              if (projectPath) {
                await saveProjectToPath(projectPath);
                markClean();
                setMsg(`Saved ${basename(projectPath)}`);
              } else {
                const p = await saveProjectDialog();
                if (p) {
                  setProjectPath(p);
                  markClean();
                  setMsg(`Saved ${basename(p)}`);
                }
              }
            })
          }
        >
          <IconSave />
          <span>Save</span>
        </button>
        <button
          type="button"
          className="tbtn"
          disabled={busy}
          title="Save to a new file"
          onClick={() =>
            run("Save As", async () => {
              const p = await saveProjectDialog();
              if (p) {
                setProjectPath(p);
                markClean();
                setMsg(`Saved ${basename(p)}`);
              }
            })
          }
        >
          <IconSaveAs />
          <span>Save As</span>
        </button>
        <span
          className="filebar-project"
          title={projectPath ?? "Unsaved project"}
        >
          {dirty && (
            <span
              className="dirty-dot"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            >
              ●
            </span>
          )}
          {projectPath ? basename(projectPath) : "Untitled"}
        </span>
      </div>

      <span className="tb-div" />

      <div className="filebar-group">
        <button
          type="button"
          className="tbtn"
          disabled={busy}
          onClick={() =>
            run("Import", async () => {
              const r = await importAudioDialog();
              if (r) {
                markDirty();
                setMsg(`Imported ${r.name} (${r.duration_secs.toFixed(1)}s)`);
                onChanged();
              }
            })
          }
        >
          <IconImport />
          <span>Import</span>
        </button>
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
          className="tbtn"
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
          <IconExport />
          <span>Export</span>
        </button>
      </div>

      <span className="tb-div" />

      <button
        type="button"
        className="tbtn icon-only theme-toggle"
        onClick={() => setDark((d) => !d)}
        title="Toggle light / dark theme"
        aria-label="Toggle theme"
      >
        {dark ? <IconSun /> : <IconMoon />}
      </button>

      {msg && <span className="filebar-msg">{msg}</span>}
    </div>
  );
}
