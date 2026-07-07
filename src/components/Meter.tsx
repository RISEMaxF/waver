import { useEffect, useRef, useState } from "react";
import type { ChannelLevel } from "../audio/types";
import { IconMic, IconRefresh } from "./icons";

/** Time-based meter ballistics, animated by rAF so the display is snappy and smooth
 *  regardless of how fast level updates actually arrive over IPC (review of the
 *  "sluggish meter" report: per-update decay stalls when updates are sparse).
 *  Attack is instant; release is dB-per-SECOND. Returns live dB values per channel. */
export function useMeterBallistics(
  levels: ChannelLevel[],
  releaseDbPerSec = 90,
  floor = -60,
): number[] {
  const disp = useRef<number[]>([]);
  const latest = useRef<number[]>([]);
  const [, frame] = useState(0);
  latest.current = levels.map((l) => l.peak_dbfs);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let alive = true;
    const loop = (now: number) => {
      if (!alive) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const tgt = latest.current;
      const d = disp.current;
      let changed = false;
      for (let i = 0; i < Math.max(tgt.length, d.length); i++) {
        const cur = d[i] ?? floor;
        const next = Math.max(tgt[i] ?? floor, cur - releaseDbPerSec * dt);
        if (Math.abs(next - cur) > 0.01) changed = true;
        d[i] = next;
      }
      if (changed) frame((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [releaseDbPerSec, floor]);
  return levels.map((_, i) => disp.current[i] ?? floor);
}

// Meter display range. Below MIN_DBFS reads as silence.
const MIN_DBFS = -60;
const MAX_DBFS = 0;
const PEAK_DECAY_DB = 1.2; // peak-hold falls this many dB per update
const CLIP_HOLD_MS = 2500; // clip latch auto-expires; click still clears it

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
  // Ballistics: peak with instant attack + time-based release, animated by rAF
  // (see useMeterBallistics); slow peak-hold tick; self-expiring clip latch.
  const barDb = useMeterBallistics(channels);
  const holds = useRef<number[]>([]);
  const clipAt = useRef<number[]>([]);
  const [, bump] = useState(0);
  // Numeric readout updated at most ~5x/s (rounded to whole dB) so it's readable rather
  // than a blur of decimals.
  const [displayDb, setDisplayDb] = useState("-∞");
  const lastDbAt = useRef(0);

  useEffect(() => {
    const now = performance.now();
    let peak = MIN_DBFS;
    channels.forEach((ch, i) => {
      holds.current[i] = Math.max(
        ch.peak_dbfs,
        (holds.current[i] ?? MIN_DBFS) - PEAK_DECAY_DB,
      );
      if (ch.peak_dbfs >= -0.1) clipAt.current[i] = now;
      peak = Math.max(peak, ch.peak_dbfs);
    });
    if (now - lastDbAt.current > 200) {
      lastDbAt.current = now;
      setDisplayDb(peak <= MIN_DBFS ? "-∞" : String(Math.round(peak)));
    }
    bump((n) => n + 1);
  }, [channels]);

  const reset = () => {
    holds.current = [];
    clipAt.current = [];
    bump((n) => n + 1);
  };

  if (channels.length === 0) {
    return (
      <p className={`meter-idle${compact ? " compact" : ""}`}>
        No input signal.
      </p>
    );
  }

  const now = performance.now();
  const anyClip = clipAt.current.some((t) => t && now - t < CLIP_HOLD_MS);

  return (
    <div
      className={`meter${compact ? " compact" : ""}`}
      role="group"
      aria-label="Input level meter"
      onClick={reset}
      title="Input level - click to reset peak / clip hold"
    >
      {compact && <IconMic size={12} className="meter-mic" />}
      <div className={compact ? "meter-col" : undefined}>
        <div className="meter-bars">
          {channels.map((level, i) => {
            const rmsPct = normalize(barDb[i] ?? level.peak_dbfs);
            const peakPct = normalize(level.peak_dbfs);
            const holdPct = normalize(holds.current[i] ?? MIN_DBFS);
            const isClipped =
              !!clipAt.current[i] && now - clipAt.current[i] < CLIP_HOLD_MS;
            return (
              <div className="meter-channel" key={i}>
                <span
                  className={`meter-clip${isClipped ? " on" : ""}`}
                  title="Clipped"
                />
                <div className="meter-track">
                  {/* dB reference ticks at -24/-12/-6 (fractions of the -60..0 range) */}
                  {compact && (
                    <span className="meter-ticks" aria-hidden="true" />
                  )}
                  <div
                    className="meter-rms"
                    style={sizeStyle(compact, rmsPct)}
                  />
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
          <div className="meter-scale" aria-hidden="true">
            {[-48, -24, -12, 0].map((v) => (
              <span key={v} style={{ left: `${((v + 60) / 60) * 100}%` }}>
                {v}
              </span>
            ))}
          </div>
        )}
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
