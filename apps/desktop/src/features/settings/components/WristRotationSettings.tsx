import type { RefObject } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";

type WristRotationSettingsProps = {
  deadZoneDegrees: number;
  smoothingAlpha: number;
  volumePointsPerDegree: number;
  maxAngularVelocityDegreesPerSecond: number;
  maxVolumePointsPerSecond: number;
  deadZoneInputRef: RefObject<HTMLInputElement | null>;
  smoothingInputRef: RefObject<HTMLInputElement | null>;
  sensitivityInputRef: RefObject<HTMLInputElement | null>;
  velocityInputRef: RefObject<HTMLInputElement | null>;
  volumeRateInputRef: RefObject<HTMLInputElement | null>;
};

/** Wrist-rotation tuning for the volume knob gesture: sensitivity, smoothing, and rate limiting. */
export function WristRotationSettings({
  deadZoneDegrees,
  smoothingAlpha,
  volumePointsPerDegree,
  maxAngularVelocityDegreesPerSecond,
  maxVolumePointsPerSecond,
  deadZoneInputRef,
  smoothingInputRef,
  sensitivityInputRef,
  velocityInputRef,
  volumeRateInputRef,
}: WristRotationSettingsProps) {
  return (
    <Card role="region" aria-label="Wrist rotation controls">
      <CardHeader>
        <SectionHeader
          title="Wrist rotation tuning"
          description="Volume gesture"
          help={{
            label: "About wrist rotation tuning",
            content: "Applied on the next STEM-button grab. Dead zone ignores small unintentional turns. Sensitivity sets volume points per degree of rotation; smoothing and rate limiting keep the response steady. Defaults give 30 volume points for a 90° twist.",
          }}
        />
      </CardHeader>
      <CardContent className="calibration-actions">
        <Label className="flex flex-col items-start gap-1">
          Dead zone
          <Input aria-label="Wrist rotation dead zone degrees" type="number" min="0" max="45" step="0.5" ref={deadZoneInputRef} key={`wrist-dead-zone-${deadZoneDegrees}`} defaultValue={deadZoneDegrees} />
          <small>degrees</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Smoothing
          <Input aria-label="Wrist rotation smoothing" type="number" min="0.01" max="1" step="0.01" ref={smoothingInputRef} key={`wrist-smoothing-${smoothingAlpha}`} defaultValue={smoothingAlpha} />
          <small>alpha</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Sensitivity
          <Input aria-label="Wrist rotation volume points per degree" type="number" min="0.01" max="5" step="0.01" ref={sensitivityInputRef} key={`wrist-sensitivity-${volumePointsPerDegree}`} defaultValue={volumePointsPerDegree} />
          <small>points / degree</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Max angular velocity
          <Input aria-label="Wrist rotation max angular velocity" type="number" min="1" max="2000" step="1" ref={velocityInputRef} key={`wrist-velocity-${maxAngularVelocityDegreesPerSecond}`} defaultValue={maxAngularVelocityDegreesPerSecond} />
          <small>degrees / second</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Max volume rate
          <Input aria-label="Wrist rotation max volume rate" type="number" min="1" max="100" step="1" ref={volumeRateInputRef} key={`wrist-volume-rate-${maxVolumePointsPerSecond}`} defaultValue={maxVolumePointsPerSecond} />
          <small>points / second</small>
        </Label>
      </CardContent>
    </Card>
  );
}
