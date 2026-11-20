import { AnimatedNumber } from "../../../components/app/AnimatedNumber";
import type { CSSProperties } from "react";

interface VolumeKnobProps {
  /** The level in percent; `null` when it cannot be read, shown as a dash. */
  volume: number | null;
  /** What the level is of, shown under it and in the meter's name. */
  label?: string;
  grabbed?: boolean;
  /** Most recent native volume read/write failure; surfaced directly instead of leaving the knob static on error. */
  nativeVolumeError?: string | null;
}

type KnobStyle = CSSProperties & { "--volume-progress": number };

export function VolumeKnob({
  volume,
  label = "Volume",
  grabbed = false,
  nativeVolumeError = null,
}: VolumeKnobProps) {
  const boundedVolume = Math.min(100, Math.max(0, volume ?? 0));
  const style: KnobStyle = { "--volume-progress": boundedVolume };

  return (
    <section
      className={grabbed ? "volume-knob grabbed" : "volume-knob"}
      role="meter"
      aria-label={`Current ${label.toLowerCase()}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={volume === null ? undefined : boundedVolume}
    >
      <div className="volume-knob__halo" />
      <svg className="volume-knob__dial" viewBox="0 0 120 120" aria-hidden="true">
        <circle className="volume-knob__track" cx="60" cy="60" r="52" pathLength="100" />
        <circle className="volume-knob__progress" cx="60" cy="60" r="52" pathLength="100" style={style} />
      </svg>
      <div className="volume-knob__value">
        <strong>{volume === null ? "–" : <><AnimatedNumber value={Math.round(boundedVolume)} />%</>}</strong>
        <span>{label}</span>
        <small>{grabbed ? "Grabbed · Turn wrist" : "Ready"}</small>
      </div>
      {nativeVolumeError && <p className="volume-knob__native-error" role="alert">{nativeVolumeError}</p>}
    </section>
  );
}
