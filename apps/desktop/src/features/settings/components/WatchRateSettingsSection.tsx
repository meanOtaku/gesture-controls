import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SettingsNumberField } from "../settingsForm";

/** Galaxy Watch IMU sampling rates, applied live through Android's SensorManager. */
export function WatchRateSettingsSection() {
  return (
    <Card role="region" aria-label="Watch sensor rates">
      <CardHeader>
        <SectionHeader
          title="IMU sampling rates"
          description="Galaxy Watch"
          help={{
            label: "About Watch IMU sensor rates",
            content: "Applied live via Android SensorManager without restarting the stream. Higher rates give smoother tracking but use more battery and bandwidth.",
          }}
        />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SettingsNumberField name="watchOrientationRateHz" />
        <SettingsNumberField name="watchAccelerationRateHz" />
        <SettingsNumberField name="watchGyroscopeRateHz" />
      </CardContent>
    </Card>
  );
}
