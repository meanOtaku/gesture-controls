import { useRef } from "react";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import type { CalibrationState, CalibrationTarget } from "../../../shared/protocol/events";

type CalibrationPanelProps = {
  connected: boolean;
  calibration: CalibrationState;
  isPending: (key: string) => boolean;
  onCaptureTarget: (target: CalibrationTarget) => void;
  onUpdateCalibration: (activationThresholdDegrees: number, dwellMs: number) => void;
};

/** Sony head-tracker calibration: two-point capture plus activation threshold/dwell tuning for the volume gesture. */
export function CalibrationPanel({ connected, calibration, isPending, onCaptureTarget, onUpdateCalibration }: CalibrationPanelProps) {
  const thresholdInput = useRef<HTMLInputElement>(null);
  const dwellInput = useRef<HTMLInputElement>(null);
  const updatePending = isPending("calibration:update");

  const commitCalibrationSettings = () => {
    const threshold = Number(thresholdInput.current?.value);
    const dwell = Number(dwellInput.current?.value);
    if (Number.isFinite(threshold) && threshold >= 1 && threshold <= 180
      && Number.isInteger(dwell) && dwell >= 50 && dwell <= 5000) {
      onUpdateCalibration(threshold, dwell);
    }
  };

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
            <strong className={`target-state ${calibration.activeTarget ? "active" : ""}`}>
              {calibration.activeTarget === "topRight"
                ? "Top-right active"
                : calibration.activeTarget === "center"
                  ? "Center active"
                  : "No active target"}
            </strong>
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

        <div className="calibration-actions">
          <Button
            type="button"
            variant="outline"
            disabled={!connected || isPending("capture:center")}
            onClick={() => onCaptureTarget("center")}
          >
            {isPending("capture:center") ? "Capturing…" : "Capture center"}
            <small>{calibration.centerCalibrated ? "Saved" : "Not saved"}</small>
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!connected || isPending("capture:topRight")}
            onClick={() => onCaptureTarget("topRight")}
          >
            {isPending("capture:topRight") ? "Capturing…" : "Capture top-right"}
            <small>{calibration.topRightCalibrated ? "Saved" : "Not saved"}</small>
          </Button>
          <Label className="flex flex-col items-start gap-1">
            <span className="flex items-center gap-1">
              Threshold
              <HelpTooltip label="About the activation threshold">
                How far your head must turn toward the top-right target, in degrees, before the volume gesture can activate.
              </HelpTooltip>
            </span>
            <Input
              aria-label="Activation threshold degrees"
              type="number"
              min="1"
              max="180"
              step="1"
              disabled={updatePending}
              ref={thresholdInput}
              key={`threshold-${calibration.activationThresholdDegrees}`}
              defaultValue={calibration.activationThresholdDegrees}
              onBlur={commitCalibrationSettings}
            />
            <small>degrees</small>
          </Label>
          <Label className="flex flex-col items-start gap-1">
            <span className="flex items-center gap-1">
              Dwell
              <HelpTooltip label="About the activation dwell time">
                How long your head must hold past the threshold, in milliseconds, before the volume gesture activates.
              </HelpTooltip>
            </span>
            <Input
              aria-label="Activation dwell milliseconds"
              type="number"
              min="50"
              max="5000"
              step="50"
              disabled={updatePending}
              ref={dwellInput}
              key={`dwell-${calibration.dwellMs}`}
              defaultValue={calibration.dwellMs}
              onBlur={commitCalibrationSettings}
            />
            <small>milliseconds</small>
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}
