import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAudio } from "./audio/useAudio";
import { useProject } from "./audio/useProject";
import { AudioControls } from "./components/AudioControls";
import { FileBar } from "./components/FileBar";
import { MediaPool } from "./components/MediaPool";
import { WaveformTimeline } from "./components/WaveformTimeline";
import "./App.css";

interface AppInfo {
  name: string;
  version: string;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [poolMsg, setPoolMsg] = useState<string | null>(null);
  const audio = useAudio();
  const project = useProject();

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch(() => {});
  }, []);

  // Refresh the project timeline whenever a new take is recorded.
  const takeCount = useRef(0);
  useEffect(() => {
    if (audio.takes.length !== takeCount.current) {
      takeCount.current = audio.takes.length;
      project.refresh();
    }
  }, [audio.takes, project]);

  // Toggle recording; refresh after starting so a just-created track (armed on the
  // backend when nothing was armed) shows up and the live waveform has a lane.
  const onToggleRecord = useCallback(async () => {
    if (audio.recording) {
      audio.stopRec();
      return;
    }
    await audio.startRec();
    project.refresh();
  }, [audio, project]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Waver</span>
          {info && <span className="brand-ver">v{info.version}</span>}
        </div>
        <FileBar project={project.project} onChanged={project.refresh} />
        <AudioControls audio={audio} onToggleRecord={onToggleRecord} />
      </header>

      {(audio.notice || audio.error || project.error || poolMsg) && (
        <div className="banners">
          {audio.notice && (
            <p className="notice" role="status" aria-live="polite">
              {audio.notice}
            </p>
          )}
          {audio.error && (
            <p className="error-banner" role="alert">
              {audio.error}
            </p>
          )}
          {project.error && (
            <p className="error-banner" role="alert">
              {project.error}
            </p>
          )}
          {poolMsg && (
            <p
              className="error-banner"
              role="alert"
              onClick={() => setPoolMsg(null)}
            >
              {poolMsg}
            </p>
          )}
        </div>
      )}

      <main className="stage">
        <MediaPool
          project={project.project}
          onChanged={project.refresh}
          onError={setPoolMsg}
        />
        <WaveformTimeline
          project={project.project}
          api={project}
          outputId={audio.outputId}
          recording={audio.recording}
          recWave={audio.recWave}
        />
      </main>
    </div>
  );
}

export default App;
