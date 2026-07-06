import { useEffect, useRef, useState } from "react";
import type { ChannelLevel } from "../audio/types";

// Meter display range. Below MIN_DBFS reads as silence.
const MIN_DBFS = -60;
const MAX_DBFS = 0;
const PEAK_DECAY_DB = 1.2; // peak-hold falls this many dB per update

function normalize(dbfs: number): number {
  const clamped = Math.max(MIN_DBFS, Math.min(MAX_DBFS, dbfs));
  return ((clamped - MIN_DBFS) / (MAX_DBFS - MIN_DBFS)) * 100;
}

function fmtDb(dbfs: number): string {
  return dbfs <= MIN_DBFS ? "-∞" : dbfs.toFixed(1);
}

export function Meter({
  channels,
  compact = false,
}: {
  channels: ChannelLevel[];
  compact?: boolean;
}) {
  // Peak-hold + latching clip indicator (Audacity pattern): holds decay slowly; the
  // clip latch stays lit until the user clicks the meter to reset.
  const holds = useRef<number[]>([]);
  const clipped = useRef<boolean[]>([]);
  const [, bump] = useState(0);

  useEffect(() => {
    channels.forEach((ch, i) => {
      holds.current[i] = Math.max(
        ch.peak_dbfs,
        (holds.current[i] ?? MIN_DBFS) - PEAK_DECAY_DB,
      );
      if (ch.peak_dbfs >= -0.1) clipped.current[i] = true;
    });
    bump((n) => n + 1);
  }, [channels]);

  const reset = () => {
    holds.current = [];
    clipped.current = [];
    bump((n) => n + 1);
  };

  if (channels.length === 0) {
    return (
      <p className={`meter-idle${compact ? " compact" : ""}`}>
        No input signal.
      </p>
    );
  }

  return (
    <div
      className={`meter${compact ? " compact" : ""}`}
      role="group"
      aria-label="Input level meter (click to reset peak)"
      onClick={reset}
      title="Click to reset peak / clip hold"
    >
      {channels.map((level, i) => {
        const rmsPct = normalize(level.rms_dbfs);
        const peakPct = normalize(level.peak_dbfs);
        const holdPct = normalize(holds.current[i] ?? MIN_DBFS);
        const isClipped = clipped.current[i];
        return (
          <div className="meter-channel" key={i}>
            <span
              className={`meter-clip${isClipped ? " on" : ""}`}
              title="Clipped"
            />
            <div className="meter-track">
              <div className="meter-rms" style={sizeStyle(compact, rmsPct)} />
              <div className="meter-peak" style={posStyle(compact, peakPct)} />
              <div className="meter-hold" style={posStyle(compact, holdPct)} />
            </div>
            {!compact && (
              <div className="meter-readout">
                <span className="meter-db">{fmtDb(level.peak_dbfs)}</span>
                <span className="meter-ch">{i + 1}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Fill grows along the meter axis (height for vertical, width for horizontal).
function sizeStyle(compact: boolean, pct: number): React.CSSProperties {
  return compact ? { width: `${pct}%` } : { height: `${pct}%` };
}

// A tick positioned along the meter axis.
function posStyle(compact: boolean, pct: number): React.CSSProperties {
  return compact ? { left: `${pct}%` } : { bottom: `${pct}%` };
}
