import { SectionHeader } from "../../../components/app/SectionHeader";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SettingsNumberField } from "../settingsForm";

type HeadphonesSettingsSectionProps = {
  enabled: boolean;
  onToggleEnabled: () => void;
};

/** Sony headphone acceptance: whether incoming packets are processed, and at what display/recording rate. */
export function HeadphonesSettingsSection({ enabled, onToggleEnabled }: HeadphonesSettingsSectionProps) {
  return (
    <Card role="region" aria-label="Headphones settings">
      <CardHeader>
        <SectionHeader
          title="Acceptance rate"
          description="Headphones"
          help={{
            label: "About the headphones acceptance rate",
            content: "Every incoming Sony packet still updates calibration and connection state; this only throttles what's displayed and recorded.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" aria-pressed={enabled} onClick={onToggleEnabled}>
            {enabled ? "Enabled" : "Disabled"}
          </Button>
          <span className="text-xs text-muted-foreground">Click to {enabled ? "disable" : "enable"}; takes effect immediately</span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="headphonesRateHz" />
        </div>
      </CardContent>
    </Card>
  );
}
