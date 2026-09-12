import type { RefObject } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";

type WatchHealthDeliverySettingsSectionProps = {
  ppgFlushRateHz: number;
  heartRateAcceptanceRateHz: number;
  skinTemperatureAcceptanceRateHz: number;
  edaAcceptanceRateHz: number;
  ppgFlushRateInputRef: RefObject<HTMLInputElement | null>;
  heartRateAcceptanceRateInputRef: RefObject<HTMLInputElement | null>;
  skinTemperatureAcceptanceRateInputRef: RefObject<HTMLInputElement | null>;
  edaAcceptanceRateInputRef: RefObject<HTMLInputElement | null>;
};

/** Samsung Health Sensor SDK delivery: raw PPG flush cadence plus desktop acceptance rates for continuous trackers. */
export function WatchHealthDeliverySettingsSection({
  ppgFlushRateHz,
  heartRateAcceptanceRateHz,
  skinTemperatureAcceptanceRateHz,
  edaAcceptanceRateHz,
  ppgFlushRateInputRef,
  heartRateAcceptanceRateInputRef,
  skinTemperatureAcceptanceRateInputRef,
  edaAcceptanceRateInputRef,
}: WatchHealthDeliverySettingsSectionProps) {
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
      <CardContent className="calibration-actions">
        <Label className="flex flex-col items-start gap-1">
          Raw PPG flush
          <Input aria-label="Watch PPG flush rate Hz" type="number" min="0.1" max="10" step="0.1"
            ref={ppgFlushRateInputRef} key={`watch-ppg-flush-${ppgFlushRateHz}`}
            defaultValue={ppgFlushRateHz} />
          <small>Hz</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Heart rate
          <Input aria-label="Watch heart rate acceptance rate Hz" type="number" min="0.1" max="200" step="0.1"
            ref={heartRateAcceptanceRateInputRef} key={`watch-heart-rate-acceptance-${heartRateAcceptanceRateHz}`}
            defaultValue={heartRateAcceptanceRateHz} />
          <small>Hz</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          Skin temperature
          <Input aria-label="Watch skin temperature acceptance rate Hz" type="number" min="0.1" max="200" step="0.1"
            ref={skinTemperatureAcceptanceRateInputRef} key={`watch-temperature-acceptance-${skinTemperatureAcceptanceRateHz}`}
            defaultValue={skinTemperatureAcceptanceRateHz} />
          <small>Hz</small>
        </Label>
        <Label className="flex flex-col items-start gap-1">
          EDA
          <Input aria-label="Watch EDA acceptance rate Hz" type="number" min="0.1" max="200" step="0.1"
            ref={edaAcceptanceRateInputRef} key={`watch-eda-acceptance-${edaAcceptanceRateHz}`}
            defaultValue={edaAcceptanceRateHz} />
          <small>Hz</small>
        </Label>
      </CardContent>
    </Card>
  );
}
