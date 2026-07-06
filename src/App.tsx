import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAudio } from "./audio/useAudio";
import { useProject } from "./audio/useProject";
import { AudioControls } from "./components/AudioControls";
import { FileBar } from "./components/FileBar";
import { WaveformTimeline } from "./components/WaveformTimeline";
import "./App.css";

interface AppInfo {
  name: string;
  version: string;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Waver</span>
          {info && <span className="brand-ver">v{info.version}</span>}
        </div>
        <FileBar project={project.project} onChanged={project.refresh} />
        <AudioControls audio={audio} />
      </header>

      {(audio.notice || audio.error || project.error) && (
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
        </div>
      )}

      <main className="stage">
        <WaveformTimeline
          project={project.project}
          api={project}
          outputId={audio.outputId}
        />
      </main>
    </div>
  );
}

export default App;
