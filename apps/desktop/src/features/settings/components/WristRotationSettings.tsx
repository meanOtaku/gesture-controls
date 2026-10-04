import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SettingsNumberField } from "../settingsForm";

/** Wrist limits shared by every recipe: glitch rejection and the volume rate cap. */
export function WristRotationSettings() {
  return (
    <Card role="region" aria-label="Wrist rotation controls">
      <CardHeader>
        <SectionHeader
          title="Wrist rotation limits"
          description="All gesture recipes"
          help={{
            label: "About wrist rotation limits",
            content: "Apply to every recipe. A turn faster than the max angular velocity is treated as a glitch and ignored, and the max volume rate caps how fast the volume can change. Each recipe sets its own dead zone and sensitivity on the Recipes page.",
          }}
        />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SettingsNumberField name="wristMaxAngularVelocityDegreesPerSecond" />
        <SettingsNumberField name="wristMaxVolumePointsPerSecond" />
      </CardContent>
    </Card>
  );
}
