import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SettingsNumberField } from "../settingsForm";

/** Wrist-rotation tuning for the volume knob gesture: sensitivity, and rate limiting. */
export function WristRotationSettings() {
  return (
    <Card role="region" aria-label="Wrist rotation controls">
      <CardHeader>
        <SectionHeader
          title="Wrist rotation tuning"
          description="Volume gesture"
          help={{
            label: "About wrist rotation tuning",
            content: "Applied on the next STEM-button grab. Dead zone ignores small unintentional turns. Sensitivity sets volume points per degree of rotation; the max volume rate caps how fast the volume can change. Defaults give 30 volume points for a 90° twist.",
          }}
        />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SettingsNumberField name="wristDeadZoneDegrees" />
        <SettingsNumberField name="wristVolumePointsPerDegree" />
        <SettingsNumberField name="wristMaxAngularVelocityDegreesPerSecond" />
        <SettingsNumberField name="wristMaxVolumePointsPerSecond" />
      </CardContent>
    </Card>
  );
}
