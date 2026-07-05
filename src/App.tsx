import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface AppInfo {
  name: string;
  version: string;
}

const MILESTONES: { id: string; label: string; done: boolean }[] = [
  { id: "M0", label: "Scaffold", done: true },
  { id: "M1", label: "Devices + metering", done: false },
  { id: "M2", label: "Clean recording", done: false },
  { id: "M3", label: "Waveforms", done: false },
  { id: "M4", label: "Timeline editing", done: false },
  { id: "M5", label: "Fades, gain, channel split", done: false },
  { id: "M6", label: "Playback engine", done: false },
  { id: "M7", label: "Import / export", done: false },
  { id: "M8", label: "Persistence + polish", done: false },
];

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="container">
      <header className="masthead">
        <h1>
          Waver
          <span className="cursor" />
        </h1>
        <p className="tagline">
          Non-destructive audio recorder &amp; multitrack editor
        </p>
      </header>

      <section className="status">
        {info ? (
          <p className="bridge ok">
            Rust core connected · <strong>{info.name}</strong> v{info.version}
          </p>
        ) : error ? (
          <p className="bridge err">IPC bridge error: {error}</p>
        ) : (
          <p className="bridge">Connecting to Rust core…</p>
        )}
      </section>

      <ol className="milestones">
        {MILESTONES.map((m) => (
          <li key={m.id} className={m.done ? "done" : "todo"}>
            <span className="tick">{m.done ? "✓" : "○"}</span>
            <span className="mid">{m.id}</span>
            <span className="mlabel">{m.label}</span>
          </li>
        ))}
      </ol>
    </main>
  );
}

export default App;
