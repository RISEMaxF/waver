import { useEffect, useRef, useState } from "react";
import type { ChannelLevel } from "../audio/types";
import { IconMic, IconRefresh } from "./icons";

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
  // Numeric readout updated at most ~5x/s (rounded to whole dB) so it's readable rather
  // than a blur of decimals.
  const [displayDb, setDisplayDb] = useState("-∞");
  const lastDbAt = useRef(0);

  useEffect(() => {
    let peak = MIN_DBFS;
    channels.forEach((ch, i) => {
      holds.current[i] = Math.max(
        ch.peak_dbfs,
        (holds.current[i] ?? MIN_DBFS) - PEAK_DECAY_DB,
      );
      if (ch.peak_dbfs >= -0.1) clipped.current[i] = true;
      peak = Math.max(peak, ch.peak_dbfs);
    });
    const now = performance.now();
    if (now - lastDbAt.current > 200) {
      lastDbAt.current = now;
      setDisplayDb(peak <= MIN_DBFS ? "-∞" : String(Math.round(peak)));
    }
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

  const anyClip = clipped.current.some(Boolean);

  return (
    <div
      className={`meter${compact ? " compact" : ""}`}
      role="group"
      aria-label="Input level meter"
      onClick={reset}
      title="Input level — click to reset peak / clip hold"
    >
      {compact && <IconMic size={12} className="meter-mic" />}
      <div className="meter-bars">
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
                {/* dB reference ticks at -24/-12/-6 (fractions of the -60..0 range) */}
                {compact && <span className="meter-ticks" aria-hidden="true" />}
                <div className="meter-rms" style={sizeStyle(compact, rmsPct)} />
                <div
                  className="meter-peak"
                  style={posStyle(compact, peakPct)}
                />
                <div
                  className="meter-hold"
                  style={posStyle(compact, holdPct)}
                />
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
      {compact && (
        <span className={`meter-compact-db${anyClip ? " clip" : ""}`}>
          {anyClip ? "CLIP" : `${displayDb} dB`}
        </span>
      )}
      <button
        type="button"
        className="meter-reset"
        aria-label="Reset peak and clip hold"
        title="Reset peak / clip hold"
        onClick={(e) => {
          e.stopPropagation();
          reset();
        }}
      >
        <IconRefresh size={11} />
      </button>
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
