import type { RefObject } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";

type WatchRateSettingsSectionProps = {
  orientationRateHz: number;
  accelerationRateHz: number;
  gyroscopeRateHz: number;
  orientationRateInputRef: RefObject<HTMLInputElement | null>;
  accelerationRateInputRef: RefObject<HTMLInputElement | null>;
  gyroscopeRateInputRef: RefObject<HTMLInputElement | null>;
};

/** Galaxy Watch IMU (orientation/acceleration/gyroscope) sampling rates, applied live via Android SensorManager. */
export function WatchRateSettingsSection({
  orientationRateHz,
  accelerationRateHz,
  gyroscopeRateHz,
  orientationRateInputRef,
  accelerationRateInputRef,
  gyroscopeRateInputRef,
}: WatchRateSettingsSectionProps) {
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
      <CardContent className="calibration-actions">
        <Label className="flex flex-col items-start gap-1">
          Orientation
          <Input
            aria-label="Watch orientation rate Hz"
            type="number"
            min="1"
            max="200"
            step="1"
            ref={orientationRateInputRef}
            key={`watch-orientation-rate-${orientationRateHz}`}
            defaultValue={orientationRateHz}
          />
          <small>Hz</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Acceleration
          <Input
            aria-label="Watch acceleration rate Hz"
            type="number"
            min="1"
            max="200"
            step="1"
            ref={accelerationRateInputRef}
            key={`watch-acceleration-rate-${accelerationRateHz}`}
            defaultValue={accelerationRateHz}
          />
          <small>Hz</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Gyroscope
          <Input
            aria-label="Watch gyroscope rate Hz"
            type="number"
            min="1"
            max="200"
            step="1"
            ref={gyroscopeRateInputRef}
            key={`watch-gyroscope-rate-${gyroscopeRateHz}`}
            defaultValue={gyroscopeRateHz}
          />
          <small>Hz</small>
        </Label>
      </CardContent>
    </Card>
  );
}
