import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SettingsNumberField } from "../settingsForm";

/** Samsung Health Sensor SDK delivery: raw PPG flush cadence plus desktop acceptance rates for continuous trackers. */
export function WatchHealthDeliverySettingsSection() {
  return (
    <Card role="region" aria-label="Samsung health delivery controls">
      <CardHeader>
        <SectionHeader
          title="Samsung health delivery controls"
          description="Galaxy Watch"
          help={{
            label: "About health SDK delivery limits",
            content: "Raw PPG flush controls the existing HealthTracker.flush() frequency. The acceptance rates only limit desktop graph and recording acceptance; Samsung's Health Sensor SDK still controls the underlying physical sampling rate on the watch.",
          }}
        />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SettingsNumberField name="watchPpgFlushRateHz" />
        <SettingsNumberField name="watchHeartRateAcceptanceRateHz" />
        <SettingsNumberField name="watchSkinTemperatureAcceptanceRateHz" />
        <SettingsNumberField name="watchEdaAcceptanceRateHz" />
      </CardContent>
    </Card>
  );
}
