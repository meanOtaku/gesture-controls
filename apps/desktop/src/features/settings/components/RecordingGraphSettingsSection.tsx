import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SettingsNumberField } from "../settingsForm";

/** How fast live telemetry is recorded to the CSV buffer versus how often the graphs redraw. */
export function RecordingGraphSettingsSection() {
  return (
    <Card role="region" aria-label="Recording and graph settings">
      <CardHeader>
        <SectionHeader
          title="Recording & graph"
          description="Live signals and the recorder"
          help={{
            label: "About recording and graph rates",
            content: "Recording rate controls how many samples per second land in the CSV capture buffer, per channel. Graph refresh rate only controls how often the live charts redraw and does not affect what gets saved.",
          }}
        />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SettingsNumberField name="recordingRateHz" />
        <SettingsNumberField name="graphRefreshRateHz" />
      </CardContent>
    </Card>
  );
}
