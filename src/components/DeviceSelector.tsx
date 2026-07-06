import type { DeviceInfo } from "../audio/types";
import { IconRefresh } from "./icons";

interface Props {
  inputs: DeviceInfo[];
  outputs: DeviceInfo[];
  selectedInputId: string | null;
  selectedOutputId: string | null;
  sampleRate: number | null;
  bufferFrames: number | null;
  onSelectInput: (id: string) => void;
  onSelectOutput: (id: string) => void;
  onSelectRate: (rate: number) => void;
  onSelectBuffer: (frames: number | null) => void;
  onRefresh: () => void;
  /** Lock all device controls (e.g. while recording — changing them aborts the take). */
  disabled?: boolean;
}

function deviceLabel(d: DeviceInfo): string {
  const chans = d.channels.length ? `${Math.max(...d.channels)}ch` : "?ch";
  return `${d.name} · ${d.host} · ${chans}${d.is_default ? " (default)" : ""}`;
}

export function DeviceSelector(props: Props) {
  const selectedInput =
    props.inputs.find((d) => d.id === props.selectedInputId) ?? null;
  const rates = selectedInput?.sample_rates ?? [];
  const dis = props.disabled;

  return (
    <div className="devsel">
      {dis && (
        <p className="devsel-locked">
          Locked while recording — stop to change devices.
        </p>
      )}
      <section className="devsel-section">
        <h3 className="devsel-heading">Input</h3>
        <div className="devsel-row">
          <label htmlFor="input-device">Device</label>
          <select
            id="input-device"
            value={props.selectedInputId ?? ""}
            disabled={dis}
            onChange={(e) => props.onSelectInput(e.target.value)}
          >
            {props.inputs.length === 0 && (
              <option value="">No input devices</option>
            )}
            {props.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceLabel(d)}
              </option>
            ))}
          </select>
        </div>
        <div className="devsel-row split">
          <div>
            <label htmlFor="sample-rate">Sample rate</label>
            <select
              id="sample-rate"
              value={props.sampleRate ?? ""}
              disabled={dis || rates.length === 0}
              onChange={(e) => props.onSelectRate(Number(e.target.value))}
            >
              {rates.map((r) => (
                <option key={r} value={r}>
                  {(r / 1000).toFixed(1)} kHz
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="buffer-size">Buffer (frames)</label>
            <select
              id="buffer-size"
              value={props.bufferFrames ?? ""}
              disabled={dis}
              onChange={(e) =>
                props.onSelectBuffer(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
            >
              <option value="">Default</option>
              {[64, 128, 256, 512, 1024, 2048].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="devsel-section">
        <h3 className="devsel-heading">Output</h3>
        <div className="devsel-row">
          <label htmlFor="output-device">Device</label>
          <select
            id="output-device"
            value={props.selectedOutputId ?? ""}
            disabled={dis}
            onChange={(e) => props.onSelectOutput(e.target.value)}
          >
            {props.outputs.length === 0 && (
              <option value="">No output devices</option>
            )}
            {props.outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceLabel(d)}
              </option>
            ))}
          </select>
        </div>
      </section>

      <button
        className="tbtn"
        onClick={props.onRefresh}
        type="button"
        disabled={dis}
      >
        <IconRefresh />
        <span>Rescan devices</span>
      </button>
    </div>
  );
}
