import type { RecordingResult } from "../audio/types";

interface Props {
  recording: boolean;
  elapsed: number;
  canRecord: boolean;
  takes: RecordingResult[];
  onStart: () => void;
  onStop: () => void;
}

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.floor((secs * 100) % 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function Recorder(props: Props) {
  return (
    <div className="recorder">
      <div className="rec-controls">
        {props.recording ? (
          <button className="rec-btn stop" onClick={props.onStop} type="button">
            <span className="rec-square" /> Stop
          </button>
        ) : (
          <button
            className="rec-btn start"
            onClick={props.onStart}
            disabled={!props.canRecord}
            type="button"
            title={props.canRecord ? "Record" : "Select an input device first"}
          >
            <span className="rec-dot" /> Record
          </button>
        )}
        <span className={`rec-time${props.recording ? " live" : ""}`}>
          {fmtTime(props.recording ? props.elapsed : 0)}
        </span>
      </div>

      {props.takes.length > 0 && (
        <ul className="takes">
          {props.takes.map((t) => (
            <li key={t.clip_id} className="take">
              <span className="take-name">{t.name}</span>
              <span className="take-meta">
                {t.duration_secs.toFixed(1)}s · {t.channels}ch ·{" "}
                {(t.sample_rate / 1000).toFixed(1)}kHz
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
