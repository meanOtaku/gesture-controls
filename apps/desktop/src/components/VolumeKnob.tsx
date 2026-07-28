import type { CSSProperties } from "react";

interface VolumeKnobProps {
  volume: number;
}

type KnobStyle = CSSProperties & { "--volume-progress": number };

export function VolumeKnob({ volume }: VolumeKnobProps) {
  const boundedVolume = Math.min(100, Math.max(0, Math.round(volume)));
  const style: KnobStyle = { "--volume-progress": boundedVolume };

  return (
    <section
      className="volume-knob"
      role="meter"
      aria-label="Current volume"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={boundedVolume}
    >
      <div className="volume-knob__halo" />
      <svg className="volume-knob__dial" viewBox="0 0 120 120" aria-hidden="true">
        <circle className="volume-knob__track" cx="60" cy="60" r="52" pathLength="100" />
        <circle className="volume-knob__progress" cx="60" cy="60" r="52" pathLength="100" style={style} />
      </svg>
      <div className="volume-knob__value">
        <strong>{boundedVolume}%</strong>
        <span>Volume</span>
      </div>
    </section>
  );
}
