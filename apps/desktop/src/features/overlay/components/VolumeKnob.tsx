import type { CSSProperties } from "react";
import type { CornerWristVolumeDemoPhase } from "../../../shared/protocol/events";

interface VolumeKnobProps {
  volume: number;
  grabbed?: boolean;
  cornerDemoPhase?: CornerWristVolumeDemoPhase | null;
  /** Most recent native volume read/write failure; surfaced directly instead of leaving the knob static on error. */
  nativeVolumeError?: string | null;
}

type KnobStyle = CSSProperties & { "--volume-progress": number };

const CORNER_DEMO_PHASE_LABEL: Record<CornerWristVolumeDemoPhase, string> = {
  targeting: "Targeting…",
  ready: "Ready — twist wrist",
  adjusting: "Adjusting",
  unavailableNoOrientation: "Unavailable — no Watch orientation",
  unavailableVolumeUnsupported: "Unavailable — volume control unsupported",
};

export function VolumeKnob({
  volume,
  grabbed = false,
  cornerDemoPhase = null,
  nativeVolumeError = null,
}: VolumeKnobProps) {
  const boundedVolume = Math.min(100, Math.max(0, Math.round(volume)));
  const style: KnobStyle = { "--volume-progress": boundedVolume };

  return (
    <section
      className={grabbed ? "volume-knob grabbed" : "volume-knob"}
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
      {cornerDemoPhase && <p className="volume-knob__corner-demo-phase">{CORNER_DEMO_PHASE_LABEL[cornerDemoPhase]}</p>}
      {nativeVolumeError && <p className="volume-knob__native-error" role="alert">{nativeVolumeError}</p>}
    </section>
  );
}
