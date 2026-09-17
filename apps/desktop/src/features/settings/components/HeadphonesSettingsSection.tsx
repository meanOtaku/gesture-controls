import type { RefObject } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";

type HeadphonesSettingsSectionProps = {
  enabled: boolean;
  rateHz: number;
  rateInputRef: RefObject<HTMLInputElement | null>;
  onToggleEnabled: () => void;
};

/** Sony headphone acceptance: whether incoming packets are processed, and at what display/recording rate. */
export function HeadphonesSettingsSection({ enabled, rateHz, rateInputRef, onToggleEnabled }: HeadphonesSettingsSectionProps) {
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
          <Button type="button" variant="outline" onClick={onToggleEnabled}>
            {enabled ? "Enabled" : "Disabled"}
          </Button>
          <span className="text-xs text-muted-foreground">Click to {enabled ? "disable" : "enable"}</span>
        </div>
        <Label className="flex flex-col items-start gap-1">
          Headphones rate
          <Input
            aria-label="Headphones rate Hz"
            type="number"
            min="1"
            max="200"
            step="1"
            ref={rateInputRef}
            key={`headphones-rate-${rateHz}`}
            defaultValue={rateHz}
          />
          <small>Hz</small>
        </Label>
      </CardContent>
    </Card>
  );
}
