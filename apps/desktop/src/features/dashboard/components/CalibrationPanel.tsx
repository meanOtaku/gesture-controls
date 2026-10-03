import type { FormEvent } from "react";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { NumberField } from "../../../components/app/NumberField";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { NumberSpec } from "../../../shared/forms/numberField";
import { useNumberDrafts } from "../../../shared/forms/useNumberDrafts";
import type { CalibrationState, CalibrationTarget } from "../../../shared/protocol/events";

/** The ranges `update_calibration_config` accepts; the defaults are `CalibrationConfig::default()` in the interaction engine. */
const CALIBRATION_FIELDS: Record<"threshold" | "dwell", NumberSpec> = {
  threshold: { label: "Activation threshold", unit: "°", min: 1, max: 180, step: 1, defaultValue: 12 },
  dwell: { label: "Activation dwell", unit: "ms", min: 50, max: 5000, step: 50, integer: true, defaultValue: 400 },
};

type CalibrationPanelProps = {
  connected: boolean;
  calibration: CalibrationState;
  isPending: (key: string) => boolean;
  onCaptureTarget: (target: CalibrationTarget) => void;
  onUpdateCalibration: (activationThresholdDegrees: number, dwellMs: number) => void;
};

/** Sony head-tracker calibration: two-point capture plus activation threshold/dwell tuning for the volume gesture. */
export function CalibrationPanel({ connected, calibration, isPending, onCaptureTarget, onUpdateCalibration }: CalibrationPanelProps) {
  const updatePending = isPending("calibration:update");
  const drafts = useNumberDrafts(CALIBRATION_FIELDS, {
    threshold: calibration.activationThresholdDegrees,
    dwell: calibration.dwellMs,
  });

  // Applies as soon as a field is left (or Enter is pressed), but only a value that is valid: an
  // invalid one stays in the box with its error instead of looking accepted while nothing happened.
  const commit = () => {
    if (drafts.dirtyCount === 0) return;
    const result = drafts.submit();
    if (result.values === null) {
      document.getElementById(`calibration-${result.firstInvalid}`)?.focus();
      return;
    }
    onUpdateCalibration(result.values.threshold, result.values.dwell);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    commit();
  };
  const field = (name: "threshold" | "dwell", help: string) => (
    <NumberField
      id={`calibration-${name}`}
      spec={CALIBRATION_FIELDS[name]}
      state={drafts.fields[name]}
      help={<HelpTooltip label={`About the ${CALIBRATION_FIELDS[name].label.toLowerCase()}`}>{help}</HelpTooltip>}
      onChange={(text) => drafts.setText(name, text)}
      onBlur={() => {
        drafts.touch(name);
        commit();
      }}
      onResetToDefault={() => drafts.resetToDefault(name)}
    />
  );

  return (
    <Card role="region" aria-label="Head calibration">
      <CardHeader>
        <SectionHeader
          title={calibration.requiresRecalibration ? "Calibration required" : "Calibration ready"}
          description="Head calibration"
          help={{
            label: "About head calibration",
            content: "Capture the screen center, then look at the top-right corner and capture again. The volume gesture activates once your head crosses the threshold angle toward the top-right target and stays there for the dwell time. A tracker reset clears both captures.",
          }}
          status={
            <Badge variant={calibration.activeTarget ? "default" : "secondary"}>
              {calibration.activeTarget === "topRight"
                ? "Top-right active"
                : calibration.activeTarget === "center"
                  ? "Center active"
                  : "No active target"}
            </Badge>
          }
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {calibration.requiresRecalibration && (
          <p className="calibration-warning">
            Face the screen center, capture it, then look at the top-right corner and capture again.
            A tracker reset clears both targets.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col items-start gap-1">
            <Button
              type="button"
              variant="outline"
              disabled={!connected || isPending("capture:center")}
              onClick={() => onCaptureTarget("center")}
            >
              {isPending("capture:center") ? "Capturing…" : "Capture center"}
            </Button>
            <small className="text-xs text-muted-foreground">{calibration.centerCalibrated ? "Saved" : "Not saved"}</small>
          </div>
          <div className="flex flex-col items-start gap-1">
            <Button
              type="button"
              variant="outline"
              disabled={!connected || isPending("capture:topRight")}
              onClick={() => onCaptureTarget("topRight")}
            >
              {isPending("capture:topRight") ? "Capturing…" : "Capture top-right"}
            </Button>
            <small className="text-xs text-muted-foreground">{calibration.topRightCalibrated ? "Saved" : "Not saved"}</small>
          </div>
        </div>
        <form noValidate aria-label="Activation settings" className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-busy={updatePending} onSubmit={onSubmit}>
          {field("threshold", "How far your head must turn toward the top-right target, in degrees, before the volume gesture can activate.")}
          {field("dwell", "How long your head must hold past the threshold, in milliseconds, before the volume gesture activates.")}
          <p className="hint sm:col-span-2" role="status">
            {updatePending ? "Applying…" : "Changes apply when you leave a field or press Enter."}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
