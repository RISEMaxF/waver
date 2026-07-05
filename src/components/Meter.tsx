import type { ChannelLevel } from "../audio/types";

// Meter display range. Below MIN_DBFS reads as silence.
const MIN_DBFS = -60;
const MAX_DBFS = 0;

function normalize(dbfs: number): number {
  const clamped = Math.max(MIN_DBFS, Math.min(MAX_DBFS, dbfs));
  return ((clamped - MIN_DBFS) / (MAX_DBFS - MIN_DBFS)) * 100;
}

function fmtDb(dbfs: number): string {
  if (dbfs <= MIN_DBFS) return "-∞";
  return dbfs.toFixed(1);
}

function ChannelBar({ level, index }: { level: ChannelLevel; index: number }) {
  const rmsPct = normalize(level.rms_dbfs);
  const peakPct = normalize(level.peak_dbfs);
  const clipping = level.peak_dbfs >= -0.1;

  return (
    <div className="meter-channel">
      <div className="meter-track">
        {/* RMS fill */}
        <div className="meter-rms" style={{ height: `${rmsPct}%` }} />
        {/* Peak indicator line */}
        <div
          className={`meter-peak${clipping ? " clip" : ""}`}
          style={{ bottom: `${peakPct}%` }}
        />
      </div>
      <div className="meter-readout">
        <span className="meter-db">{fmtDb(level.peak_dbfs)}</span>
        <span className="meter-ch">{index + 1}</span>
      </div>
    </div>
  );
}

export function Meter({ channels }: { channels: ChannelLevel[] }) {
  if (channels.length === 0) {
    return (
      <p className="meter-idle">No signal — select an input device to meter.</p>
    );
  }
  return (
    <div className="meter" role="group" aria-label="Input level meter">
      {channels.map((level, i) => (
        <ChannelBar key={i} level={level} index={i} />
      ))}
    </div>
  );
}
