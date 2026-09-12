import type { RefObject } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";

type RecordingGraphSettingsSectionProps = {
  recordingRateHz: number;
  graphRefreshRateHz: number;
  recordingRateInputRef: RefObject<HTMLInputElement | null>;
  graphRefreshRateInputRef: RefObject<HTMLInputElement | null>;
};

/** How fast live telemetry is recorded to the CSV buffer versus how often the graphs redraw. */
export function RecordingGraphSettingsSection({
  recordingRateHz,
  graphRefreshRateHz,
  recordingRateInputRef,
  graphRefreshRateInputRef,
}: RecordingGraphSettingsSectionProps) {
  return (
    <Card role="region" aria-label="Recording and graph settings">
      <CardHeader>
        <SectionHeader title="Recording & graph" description="Live data" />
      </CardHeader>
      <CardContent className="calibration-actions">
        <Label className="flex flex-col items-start gap-1">
          Recording rate
          <Input
            aria-label="Recording rate Hz"
            type="number"
            min="1"
            max="200"
            step="1"
            ref={recordingRateInputRef}
            key={`recording-rate-${recordingRateHz}`}
            defaultValue={recordingRateHz}
          />
          <small>Hz, per channel</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Graph refresh rate
          <Input
            aria-label="Graph refresh rate Hz"
            type="number"
            min="1"
            max="60"
            step="1"
            ref={graphRefreshRateInputRef}
            key={`graph-refresh-rate-${graphRefreshRateHz}`}
            defaultValue={graphRefreshRateHz}
          />
          <small>Hz</small>
        </Label>
      </CardContent>
    </Card>
  );
}
