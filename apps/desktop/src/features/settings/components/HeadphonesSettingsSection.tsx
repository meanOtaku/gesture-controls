import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";

type HeadphonesSettingsSectionProps = {
  enabled: boolean;
  onToggleEnabled: () => void;
};

/**
 * Whether the headphones' head pose reaches the screen and recordings. Their sample rate is under Advanced, with the
 * other rates.
 */
export function HeadphonesSettingsSection({ enabled, onToggleEnabled }: HeadphonesSettingsSectionProps) {
  return (
    <Card role="region" aria-label="Headphones settings">
      <CardHeader>
        <SectionHeader
          title="Head pose"
          description="Takes effect at once."
          help={{
            label: "About head pose",
            content: "Off, the head pose is neither shown nor recorded. Every incoming Sony packet still updates calibration and the connection, so recipes that start by looking somewhere keep working. The sample rate under Advanced throttles what is shown and recorded in the same way.",
          }}
        />
      </CardHeader>
      <CardContent>
        <label className="flex items-center justify-between gap-3">
          <span className="label">Show and record head pose</span>
          <Switch aria-label={`Show and record head pose ${enabled ? "on" : "off"}`} checked={enabled} onCheckedChange={onToggleEnabled} />
        </label>
      </CardContent>
    </Card>
  );
}
