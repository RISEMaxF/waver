import { useCallback, useEffect, useRef, useState } from "react";
// Export settings live in a popover: format/bit-depth are touched once per
// session, so they don't deserve permanent top-bar space (Audacity 4 pattern).
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
import { fmtTimecode } from "./timeline/renderer";
import {
  IconExport,
  IconImport,
  IconNew,
  IconOpen,
  IconSave,
  IconSaveAs,
} from "./icons";

interface Props {
  project: ProjectView | null;
  onChanged: () => void; // refresh the project view
  dirty: boolean;
  markDirty: () => void;
  markClean: () => void;
  onError: (msg: string) => void; // failures surface as dismissible toasts (W-05)
  /** Current timeline range selection (frames) - enables "Export selection". */
  exportRange: { start: number; end: number } | null;
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
  onError,
  exportRange,
}: Props) {
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>("int24");
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node))
        setExportOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [exportOpen]);
  const [msg, setMsg] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);

  // Success text is transient (4s) and yields the moment new edits land, so it can
  // never contradict the dirty dot (W-05).
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(id);
  }, [msg]);
  useEffect(() => {
    if (dirty) setMsg(null);
  }, [dirty]);

  const sampleRate = project?.sample_rate ?? 48000;
  const hasContent =
    !!project && project.tracks.some((t) => t.clips.length > 0);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setBusyAction(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      onError(`${label} failed - ${e}`);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  // Save / Save As are also keyboard commands (⌘S / ⇧⌘S; W-04).
  const doSave = useCallback(async () => {
    await run("Save", async () => {
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, markClean]);

  const doSaveAs = useCallback(async () => {
    await run("Save As", async () => {
      const p = await saveProjectDialog();
      if (p) {
        setProjectPath(p);
        markClean();
        setMsg(`Saved ${basename(p)}`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markClean]);

  const saveKeys = useRef({ doSave, doSaveAs, busy });
  saveKeys.current = { doSave, doSaveAs, busy };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (saveKeys.current.busy) return; // same guard as the buttons
        if (e.shiftKey) saveKeys.current.doSaveAs();
        else saveKeys.current.doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="filebar">
      <div className="filebar-group">
        <button
          type="button"
          className="tbtn icon-only"
          disabled={busy}
          title="New project"
          aria-label="New project"
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
        </button>
        <button
          type="button"
          className="tbtn icon-only"
          aria-label="Open project"
          title="Open project"
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
                    ? `Opened ${basename(r.path)} - ${r.missing_sources.length} source file(s) missing`
                    : `Opened ${basename(r.path)}`,
                );
              }
            })
          }
        >
          <IconOpen />
        </button>
        <button
          type="button"
          className={`tbtn icon-only${busyAction === "Save" ? " working" : ""}`}
          disabled={busy}
          aria-label="Save project"
          title={
            busyAction === "Save"
              ? "Saving…"
              : projectPath
                ? `Save to ${basename(projectPath)} (⌘S)`
                : "Save project (⌘S)"
          }
          onClick={doSave}
        >
          <IconSave />
        </button>
        <button
          type="button"
          className={`tbtn icon-only${busyAction === "Save As" ? " working" : ""}`}
          disabled={busy}
          aria-label="Save As"
          title={
            busyAction === "Save As" ? "Saving…" : "Save to a new file (⇧⌘S)"
          }
          onClick={doSaveAs}
        >
          <IconSaveAs />
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
          <span className="filebar-project-name">
            {projectPath ? basename(projectPath) : "Untitled"}
          </span>
        </span>
      </div>

      <span className="tb-div" />

      <div className="filebar-group">
        <button
          type="button"
          className={`tbtn icon-only${busyAction === "Import" ? " working" : ""}`}
          aria-label="Import audio"
          title={busyAction === "Import" ? "Importing…" : "Import audio file"}
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
        </button>
        <div className="filebar-export" ref={exportRef}>
          <button
            type="button"
            ref={exportBtnRef}
            className={`tbtn icon-only${busyAction === "Export" ? " working" : ""}${exportOpen ? " active" : ""}`}
            disabled={busy}
            aria-label="Export mixdown"
            aria-haspopup="dialog"
            aria-expanded={exportOpen}
            title={busyAction === "Export" ? "Exporting…" : "Export mixdown…"}
            onClick={() => setExportOpen((o) => !o)}
          >
            <IconExport />
          </button>
          {exportOpen && (
            <div
              className="ac-popover anchor-left export-popover"
              role="dialog"
              aria-label="Export mixdown"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setExportOpen(false);
                  exportBtnRef.current?.focus();
                }
              }}
            >
              <h3 className="devsel-heading">Export mixdown</h3>
              <label className="export-row">
                <span>Format</span>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as ExportFormat)}
                >
                  <option value="wav">WAV</option>
                  <option value="flac">FLAC</option>
                  <option value="ogg">OGG</option>
                </select>
              </label>
              <label className="export-row">
                <span>Bit depth</span>
                <select
                  value={bitDepth}
                  onChange={(e) =>
                    setBitDepth(e.target.value as ExportBitDepth)
                  }
                  disabled={format === "ogg"}
                >
                  <option value="int16">16-bit</option>
                  <option value="int24">24-bit</option>
                  <option value="float32">32-bit float</option>
                </select>
              </label>
              {exportRange && (
                <button
                  type="button"
                  className="tbtn export-go"
                  disabled={busy}
                  onClick={() => {
                    setExportOpen(false);
                    run("Export", async () => {
                      const p = await exportProjectDialog(
                        format,
                        bitDepth,
                        sampleRate,
                        2,
                        exportRange,
                      );
                      if (p) setMsg(`Exported selection ${basename(p)}`);
                    });
                  }}
                >
                  <IconExport />
                  <span>
                    Export selection ({fmtTimecode(exportRange.start / sampleRate)}
                    {" - "}
                    {fmtTimecode(exportRange.end / sampleRate)})
                  </span>
                </button>
              )}
              <button
                type="button"
                className="tbtn export-go"
                disabled={busy || !hasContent}
                title={
                  hasContent ? undefined : "Record or import something first"
                }
                onClick={() => {
                  setExportOpen(false);
                  run("Export", async () => {
                    const p = await exportProjectDialog(
                      format,
                      bitDepth,
                      sampleRate,
                      2,
                    );
                    if (p) setMsg(`Exported ${basename(p)}`);
                  });
                }}
              >
                <IconExport />
                <span>Export {format.toUpperCase()}</span>
              </button>
              {!hasContent && (
                <p className="export-hint">Record or import something first.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {msg && (
        <span className="filebar-msg" role="status" aria-live="polite">
          {msg}
        </span>
      )}
    </div>
  );
}
