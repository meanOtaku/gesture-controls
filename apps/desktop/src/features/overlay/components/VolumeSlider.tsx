import { AnimatedNumber } from "../../../components/app/AnimatedNumber";
import type { CSSProperties } from "react";

interface VolumeSliderProps {
  volume: number;
  orientation: "horizontal" | "vertical";
  grabbed?: boolean;
  /** Most recent native volume read/write failure, shown instead of leaving the slider static on error. */
  nativeVolumeError?: string | null;
}

type SliderStyle = CSSProperties & { "--volume-progress": number };

/** The overlay for a volume recipe whose device is a fader: a slider that fills with the volume. */
export function VolumeSlider({ volume, orientation, grabbed = false, nativeVolumeError = null }: VolumeSliderProps) {
  const boundedVolume = Math.min(100, Math.max(0, volume));
  const style: SliderStyle = { "--volume-progress": boundedVolume };

  return (
    <section
      className={`volume-slider volume-slider--${orientation}${grabbed ? " grabbed" : ""}`}
      role="meter"
      aria-label="Current volume"
      aria-orientation={orientation}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={boundedVolume}
    >
      <div className="volume-slider__track" aria-hidden="true">
        <div className="volume-slider__fill" style={style} />
      </div>
      <div className="volume-slider__value">
        <strong>{<AnimatedNumber value={Math.round(boundedVolume)} />}%</strong>
        <span>Volume</span>
        <small>{grabbed ? "Grabbed · Turn wrist" : "Ready"}</small>
      </div>
      {nativeVolumeError && <p className="volume-knob__native-error" role="alert">{nativeVolumeError}</p>}
    </section>
  );
}
