import { AnimatedNumber } from "../../../components/app/AnimatedNumber";
import type { CSSProperties } from "react";

interface VolumeSliderProps {
  /** The level in percent; `null` when it cannot be read, shown as a dash. */
  volume: number | null;
  /** What the level is of, shown under it and in the meter's name. */
  label?: string;
  orientation: "horizontal" | "vertical";
  grabbed?: boolean;
  /** Most recent native volume read/write failure, shown instead of leaving the slider static on error. */
  nativeVolumeError?: string | null;
}

type SliderStyle = CSSProperties & { "--volume-progress": number };

/** The overlay for a volume recipe whose device is a fader: a slider that fills with the volume. */
export function VolumeSlider({ volume, orientation, label = "Volume", grabbed = false, nativeVolumeError = null }: VolumeSliderProps) {
  const boundedVolume = Math.min(100, Math.max(0, volume ?? 0));
  const style: SliderStyle = { "--volume-progress": boundedVolume };

  return (
    <section
      className={`volume-slider volume-slider--${orientation}${grabbed ? " grabbed" : ""}`}
      role="meter"
      aria-label={`Current ${label.toLowerCase()}`}
      aria-orientation={orientation}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={volume === null ? undefined : boundedVolume}
    >
      <div className="volume-slider__track" aria-hidden="true">
        <div className="volume-slider__fill" style={style} />
      </div>
      <div className="volume-slider__value">
        <strong>{volume === null ? "–" : <><AnimatedNumber value={Math.round(boundedVolume)} />%</>}</strong>
        <span>{label}</span>
        <small>{grabbed ? "Grabbed · Turn wrist" : "Ready"}</small>
      </div>
      {nativeVolumeError && <p className="volume-knob__native-error" role="alert">{nativeVolumeError}</p>}
    </section>
  );
}
